import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleRequest, type Database, type Env, type Statement } from '../../../apps/worker/src/index.js';
import { MirrorClient, planMirror, type MirrorPlan } from './client.js';
import { digest, type MirrorRecord } from './protocol.js';

class LocalStatement implements Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: (string | number | null)[] = []) {}
  bind(...values: (string | number | null)[]) { return new LocalStatement(this.db, this.sql, values); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  syncRun() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.values).changes) } }; }
  async run() { return this.syncRun(); }
}
let sqlite: DatabaseSync; let env: Env;
const writeToken = 'publisher_0123456789_abcdefghijklmnopqrstuvwxyz';
const submitToken = 'submitter_0123456789_abcdefghijklmnopqrstuvwxyz';
const readToken = 'reader_0123456789_abcdefghijklmnopqrstuvwxyz';
let transport: typeof fetch; let client: MirrorClient; const signal = () => new AbortController().signal;
const sample = (title: string): MirrorRecord[] => [{ kind: 'bookmark', id: 'book', title, url: 'https://example.com', categoryId: null, tagIds: [], pinned: false, unread: true }];
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_mirror.sql', '0002_inbox.sql']) sqlite.exec(readFileSync(new URL(`../../../apps/worker/migrations/${name}`, import.meta.url), 'utf8'));
  const db: Database = { prepare: (sql) => new LocalStatement(sqlite, sql), async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE'); try { const results = statements.map((statement) => (statement as LocalStatement).syncRun()); sqlite.exec('COMMIT'); return results; }
    catch (cause) { sqlite.exec('ROLLBACK'); throw cause; }
  } };
  env = { DB: db, WRITE_TOKEN_SHA256: await digest(writeToken), READ_TOKEN_SHA256: await digest(readToken), SUBMIT_TOKEN_SHA256: await digest(submitToken) };
  transport = (async (input: RequestInfo | URL, init?: RequestInit) => handleRequest(new Request(input, init), env)) as typeof fetch;
  client = new MirrorClient('https://mirror.test', writeToken, transport);
});
afterEach(() => sqlite.close());
async function post(path: string, value: unknown, token = writeToken) { return transport(`https://mirror.test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(value) }); }
async function stage(plan: MirrorPlan) {
  expect((await post('/v1/generations', plan.declaration)).status).toBe(200);
  for (const [index, part] of plan.parts.entries()) expect((await post(`/v1/generations/${plan.declaration.generationId}/chunks/${index}`, { identity: plan.declaration.identity, ...part })).status).toBe(200);
}
const publishedId = async () => (await client.info(signal())).activeGeneration;

it('实际 SQLite 上分片发布、重试幂等、只读分片和旧版本删除', async () => {
  const info = await client.info(signal()); const first = await planMirror(sample('第一版'), info);
  const result = await client.publish(first, signal(), () => undefined);
  expect(result.revision).toBe(1);
  expect((await client.publish(first, signal(), () => undefined)).revision).toBe(1);
  const read = await transport(`https://mirror.test/v1/mirror?generation=${result.activeGeneration}&part=0`, { headers: { Authorization: `Bearer ${readToken}` } });
  expect((await read.json()).records[0].title).toBe('第一版');
  const second = await planMirror(sample('第二版'), result); await client.publish(second, signal(), () => undefined);
  expect((sqlite.prepare('SELECT COUNT(*) AS n FROM mirror_generations').get() as { n: number }).n).toBe(1);
  expect((await transport(`https://mirror.test/v1/mirror?generation=${result.activeGeneration}&part=0`, { headers: { Authorization: `Bearer ${readToken}` } })).status).toBe(409);
});

it('上传中断及分片篡改不会替换旧镜像，分片只允许相同内容幂等重试', async () => {
  const initial = await planMirror(sample('原版'), await client.info(signal())); await client.publish(initial, signal(), () => undefined);
  const pending = await planMirror(sample('新内容'), await client.info(signal()));
  await post('/v1/generations', pending.declaration);
  const root = `/v1/generations/${pending.declaration.generationId}`;
  expect((await post(`${root}/publish`, { identity: pending.declaration.identity })).status).toBe(409);
  const part = pending.parts[0]!;
  expect((await post(`${root}/chunks/0`, { identity: pending.declaration.identity, ...part, hash: '0'.repeat(64) })).status).toBe(400);
  const value = { identity: pending.declaration.identity, ...part };
  expect((await post(`${root}/chunks/0`, value)).status).toBe(200);
  expect((await post(`${root}/chunks/0`, value)).status).toBe(200);
  const changed = sample('另一份');
  expect((await post(`${root}/chunks/0`, { identity: pending.declaration.identity, records: changed, hash: await digest(JSON.stringify(changed)) })).status).toBe(409);
  expect(await publishedId()).toBe(initial.declaration.generationId);
});

it('两个并发发布使用相同基线，只有一个 CAS 成功且失败者不删除胜出者内容', async () => {
  const info = await client.info(signal()); const a = await planMirror(sample('A'), info); const b = await planMirror(sample('B'), info);
  await stage(a); await stage(b);
  const responses = await Promise.all([post(`/v1/generations/${a.declaration.generationId}/publish`, { identity: a.declaration.identity }), post(`/v1/generations/${b.declaration.generationId}/publish`, { identity: b.declaration.identity })]);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  expect((await client.info(signal())).revision).toBe(1);
  expect((sqlite.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').get() as { n: number }).n).toBe(1);
});

it('只读令牌和只读 cookie 不能写入；同域登录、过期退出及无缓存头有效', async () => {
  const plan = await planMirror(sample('一'), await client.info(signal()));
  expect((await post('/v1/generations', plan.declaration, readToken)).status).toBe(401);
  const login = await transport('https://mirror.test/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://mirror.test' }, body: JSON.stringify({ token: readToken }) });
  expect(login.status).toBe(200); const cookie = login.headers.get('Set-Cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict');
  const info = await transport('https://mirror.test/v1/info', { headers: { Cookie: cookie } });
  expect(info.status).toBe(200); expect(info.headers.get('Cache-Control')).toContain('no-store');
  expect((await transport('https://mirror.test/v1/generations', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(plan.declaration) })).status).toBe(401);
  expect((await transport('https://mirror.test/v1/session', { method: 'POST', headers: { Origin: 'https://other.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: readToken }) })).status).toBe(403);
  expect((await transport('https://mirror.test/v1/session', { method: 'POST', headers: { Origin: 'https://mirror.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: writeToken }) })).status).toBe(403);
});

it('身份、epoch 和白名单隔离，非法内容不会落入云端', async () => {
  const plan = await planMirror(sample('合法'), await client.info(signal()));
  expect((await post('/v1/generations', { ...plan.declaration, identity: { ...plan.declaration.identity, libraryId: 'other' } })).status).toBe(409);
  expect((await post('/v1/generations', { ...plan.declaration, identity: { ...plan.declaration.identity, epoch: 'old' } })).status).toBe(409);
  await stage(plan);
  const record = { ...sample('私密')[0]!, note: '不可上传' };
  expect((await post(`/v1/generations/${plan.declaration.generationId}/chunks/0`, { identity: plan.declaration.identity, records: [record], hash: await digest(JSON.stringify([record])) })).status).toBe(400);
  expect(JSON.stringify(sqlite.prepare('SELECT body FROM mirror_chunks').all())).not.toContain('不可上传');
});

it('清空镜像采用版本守卫，过期请求不影响已发布内容', async () => {
  const before = await client.info(signal()); const plan = await planMirror(sample('保存'), before); const latest = await client.publish(plan, signal(), () => undefined);
  await expect(client.clear(before, signal())).rejects.toThrow();
  expect(await publishedId()).toBe(plan.declaration.generationId);
  const cleared = await client.clear(latest, signal()); expect(cleared.activeGeneration).toBeNull();
  expect((sqlite.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').get() as { n: number }).n).toBe(0);
});

it('丢失分片响应后查询服务器摘要，只补传未收到的分片', async () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({ ...sample(`资料${index}`)[0]!, id: `b${index}`, url: `https://example.com/${index}` }));
  const plan = await planMirror(rows, await client.info(signal())); let interrupted = false;
  const unreliable = new MirrorClient('https://mirror.test', writeToken, async (input, init) => {
    const response = await transport(input, init);
    if (!interrupted && new URL(String(input)).pathname.endsWith('/chunks/1')) { interrupted = true; throw new Error('lost response'); } return response;
  });
  await expect(unreliable.publish(plan, signal(), () => undefined)).rejects.toThrow();
  const sent: string[] = [];
  const resumed = new MirrorClient('https://mirror.test', writeToken, async (input, init) => { if (/\/chunks\//.test(String(input))) sent.push(String(input)); return transport(input, init); });
  await resumed.publish(plan, signal(), () => undefined);
  expect(sent).toHaveLength(1); expect(sent[0]).toMatch(/chunks\/2$/);
});
it('未发布上传可独立取消，不能误删已发布镜像，只读凭据不能查看上传状态', async () => {
  const first = await planMirror(sample('已发布'), await client.info(signal())); await client.publish(first, signal(), () => undefined);
  const next = await planMirror(sample('暂存'), await client.info(signal())); await stage(next);
  const status = await transport(`https://mirror.test/v1/generations/${next.declaration.generationId}`, { headers: { Authorization: `Bearer ${readToken}` } });
  expect(status.status).toBe(401);
  await client.cancel(next, signal()); await client.cancel(next, signal());
  expect(await publishedId()).toBe(first.declaration.generationId);
  await expect(client.cancel(first, signal())).rejects.toThrow();
  expect((sqlite.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').get() as { n: number }).n).toBe(1);
});
it('并发创建暂存计划也不能绕过服务端数量上限', async () => {
  const info = await client.info(signal()); const plans = await Promise.all(Array.from({ length: 6 }, (_, index) => planMirror(sample(String(index)), info)));
  const responses = await Promise.all(plans.map((plan) => post('/v1/generations', plan.declaration)));
  expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
  expect((sqlite.prepare('SELECT COUNT(*) AS n FROM mirror_generations').get() as { n: number }).n).toBe(5);
});
it('最后一条共享记录转私密后，可发布空镜像撤回全部旧内容', async () => {
  const first = await planMirror(sample('以前共享'), await client.info(signal())); await client.publish(first, signal(), () => undefined);
  const empty = await planMirror([], await client.info(signal())); await client.publish(empty, signal(), () => undefined);
  const chunks = sqlite.prepare('SELECT body FROM mirror_chunks').all() as { body: string }[];
  expect(chunks.flatMap((row) => JSON.parse(row.body))).toEqual([]);
  expect(await publishedId()).toBe(empty.declaration.generationId);
});

const device = { deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', deviceKey: 'device_0123456789_abcdefghijklmnopqrstuvwxyz' };
async function submission() { const info = await client.info(signal()); return { ...device, identity: { serverId: info.serverId, libraryId: info.libraryId, epoch: info.epoch }, id: crypto.randomUUID(), payload: {
  destination: 'bookmark', url: 'https://example.com/inbound', title: '手机收藏', categoryId: null, categoryPath: '', tagIds: [], tagNames: [], sourceDescription: '', note: '暂存备注', pinned: false, unread: true, aiBlocked: false,
} }; }
it('提交凭据仅能提交和查看镜像，不能读取总收件箱或发布；只读不能提交', async () => {
  const input = await submission();
  expect((await post('/v1/inbox', input, readToken)).status).toBe(401);
  expect((await post('/v1/inbox', input, submitToken)).status).toBe(200);
  expect((await transport('https://mirror.test/v1/inbox', { headers: { Authorization: `Bearer ${submitToken}` } })).status).toBe(401);
  const plan = await planMirror(sample('内容'), await client.info(signal()));
  expect((await post('/v1/generations', plan.declaration, submitToken)).status).toBe(401);
  const reader = new MirrorClient('https://mirror.test', submitToken, transport); expect((await reader.info(signal())).protocol).toBe(1);
});
it('提交重试幂等、内容不可替换；设备只能核对自己的状态', async () => {
  const input = await submission(); await post('/v1/inbox', input, submitToken); await post('/v1/inbox', input, submitToken);
  expect((sqlite.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get() as { n: number }).n).toBe(1);
  expect((await post('/v1/inbox', { ...input, payload: { ...input.payload, title: '覆盖' } }, submitToken)).status).toBe(409);
  const own = await post('/v1/inbox/device', { ...device, identity: input.identity, ids: [input.id] }, submitToken);
  expect((await own.json() as { entries: unknown[] }).entries).toHaveLength(1);
  const other = await post('/v1/inbox/device', { ...device, deviceKey: 'another_device_0123456789_abcdefghijklmnopqrstuvwxyz', identity: input.identity, ids: [input.id] }, submitToken);
  expect((await other.json() as { entries: unknown[] }).entries).toHaveLength(0);
});
it('总机分页接收后回执幂等，云端清除正文，发布及清空镜像不清待收件', async () => {
  const input = await submission(); await post('/v1/inbox', input, submitToken);
  const page = await client.inbox(signal()); expect(page.entries[0]?.payload.note).toBe('暂存备注');
  const receipt = { status: 'received' as const, recordKind: 'bookmark' as const, recordId: 'local-bookmark', message: '已接收' };
  await client.acknowledge(page.entries[0]!, receipt, signal()); await client.acknowledge(page.entries[0]!, receipt, signal());
  expect(sqlite.prepare('SELECT payload FROM capture_inbox WHERE id=?').get(input.id)).toMatchObject({ payload: null }); expect((await client.inbox(signal())).entries).toHaveLength(0);
  const next = await submission(); await post('/v1/inbox', next, submitToken);
  const plan = await planMirror(sample('已发布'), await client.info(signal())); await client.publish(plan, signal(), () => undefined); await client.clear(await client.info(signal()), signal());
  expect((await client.inbox(signal())).entries.map((row) => row.id)).toEqual([next.id]);
});
it('提交 Cookie 要求同源、拒绝伪造来源；退出失效，无提交 secret 的旧服务不开放提交', async () => {
  const login = await transport('https://mirror.test/v1/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://mirror.test' }, body: JSON.stringify({ token: submitToken }) });
  const cookie = login.headers.get('Set-Cookie')!; expect(cookie).toContain('HttpOnly');
  const input = await submission();
  const send = (origin: string) => transport('https://mirror.test/v1/inbox', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  expect((await send('https://attacker.test')).status).toBe(403); expect((await send('https://mirror.test')).status).toBe(200);
  delete env.SUBMIT_TOKEN_SHA256; expect((await post('/v1/inbox', await submission(), submitToken)).status).toBe(503);
});
it('收件分页稳定，不把已经处理的记录混入；拒绝失效库和非法字段', async () => {
  const input = await submission();
  expect((await post('/v1/inbox', { ...input, identity: { ...input.identity, epoch: 'old' } }, submitToken)).status).toBe(409);
  expect((await post('/v1/inbox', { ...input, payload: { ...input.payload, localOnly: true } }, submitToken)).status).toBe(400);
  for (let index = 0; index < 52; index++) await post('/v1/inbox', { ...input, id: crypto.randomUUID() }, submitToken);
  const first = await client.inbox(signal()); expect(first.entries).toHaveLength(50); expect(first.hasMore).toBe(true);
  const next = await client.inbox(signal(), first.entries.at(-1)!.seq); expect(next.entries).toHaveLength(2);
  sqlite.exec('DELETE FROM capture_inbox');
  for (let index = 0; index < 30; index++) await post('/v1/inbox', { ...input, id: crypto.randomUUID(), payload: { ...input.payload, note: '字'.repeat(10000) } }, submitToken);
  const large = await client.inbox(signal()); expect(large.entries.length).toBeLessThan(30); expect(large.hasMore).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeLessThan(900000);
  const rest = await client.inbox(signal(), large.entries.at(-1)!.seq); expect(large.entries.length + rest.entries.length).toBe(30);
});
