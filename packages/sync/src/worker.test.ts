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
const readToken = 'reader_0123456789_abcdefghijklmnopqrstuvwxyz';
let transport: typeof fetch; let client: MirrorClient; const signal = () => new AbortController().signal;
const sample = (title: string): MirrorRecord[] => [{ kind: 'bookmark', id: 'book', title, url: 'https://example.com', categoryId: null, tagIds: [], pinned: false, unread: true }];
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../apps/worker/migrations/0001_mirror.sql', import.meta.url), 'utf8'));
  const db: Database = { prepare: (sql) => new LocalStatement(sqlite, sql), async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE'); try { const results = statements.map((statement) => (statement as LocalStatement).syncRun()); sqlite.exec('COMMIT'); return results; }
    catch (cause) { sqlite.exec('ROLLBACK'); throw cause; }
  } };
  env = { DB: db, WRITE_TOKEN_SHA256: await digest(writeToken), READ_TOKEN_SHA256: await digest(readToken) };
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
