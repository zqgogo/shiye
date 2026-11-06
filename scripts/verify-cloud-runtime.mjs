import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, '.verify/cloud-runtime'); fs.mkdirSync(directory, { recursive: true });
process.env.WRANGLER_SEND_METRICS = 'false'; process.env.WRANGLER_LOG_PATH = path.join(directory, 'wrangler.log');
const { createTestHarness } = await import('wrangler');
const publisher = 'runtime_test_publisher_0123456789abcdefghijklmnop', reader = 'runtime_test_reader_0123456789abcdefghijklmnop';
const submitter = 'runtime_test_submitter_0123456789abcdefghijklmnop';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const server = createTestHarness({ root, workers: [{ config: { name: 'shiye-runtime-test', main: path.join(root, 'apps/worker/src/index.ts'), compatibility_date: '2026-11-04',
  d1_databases: [{ binding: 'DB', database_name: 'runtime-test', database_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', migrations_dir: path.join(root, 'apps/worker/migrations') }],
  assets: { directory: path.join(root, 'apps/worker/public'), binding: 'ASSETS', run_worker_first: true } },
  secrets: { WRITE_TOKEN_SHA256: hash(publisher), READ_TOKEN_SHA256: hash(reader), SUBMIT_TOKEN_SHA256: hash(submitter) } }] });
const report = { generatedAt: new Date().toISOString(), runtime: 'Cloudflare workerd + local D1', steps: [] };
const check = (name, condition) => { assert.ok(condition, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const controller = new AbortController();
try {
  await server.listen(); const worker = server.getWorker(); await worker.applyD1Migrations('DB');
  await build({ entryPoints: [path.join(root, 'packages/sync/src/client.ts')], outfile: path.join(directory, 'client.mjs'), bundle: true, format: 'esm', platform: 'node' });
  const { MirrorClient, planMirror } = await import(pathToFileURL(path.join(directory, 'client.mjs')).href);
  const transport = (input, init) => server.fetch(input, init);
  const client = new MirrorClient('https://mirror.test', publisher, transport);
  const info = await client.info(controller.signal);
  check('官方 workerd 中迁移后可鉴权握手', info.protocol === 1 && info.revision === 0 && !info.activeGeneration);
  check('未授权访问不能读取镜像', (await server.fetch('https://mirror.test/v1/info')).status === 401);
  const sample = (id) => ({ kind: 'bookmark', id: String(id), title: `记录 ${id}`, url: `https://example.com/${id}`, categoryId: null, tagIds: [], pinned: false, unread: false });
  const first = await planMirror([sample('old')], info); await client.publish(first, controller.signal, () => undefined);
  const before = await client.info(controller.signal);
  const plan = await planMirror(Array.from({ length: 1000 }, (_, index) => sample(index)), before);
  let failed = false;
  const interrupted = new MirrorClient('https://mirror.test', publisher, async (input, init) => {
    const response = await server.fetch(input, init);
    if (!failed && new URL(String(input)).pathname.endsWith('/chunks/1')) { failed = true; throw new Error('synthetic response lost'); }
    return response;
  });
  await assert.rejects(interrupted.publish(plan, controller.signal, () => undefined));
  check('上传已写入后丢响应仍保留上一份完整发布', (await client.info(controller.signal)).activeGeneration === before.activeGeneration);
  let retransmitted = 0;
  const resuming = new MirrorClient('https://mirror.test', publisher, (input, init) => { if (/\/chunks\//.test(String(input))) retransmitted++; return server.fetch(input, init); });
  const after = await resuming.publish(plan, controller.signal, () => undefined);
  check('真实 D1 根据服务器分片状态续传，只补剩余 18 片', retransmitted === 18);
  const env = await worker.getEnv();
  const chunks = await env.DB.prepare('SELECT body FROM mirror_chunks WHERE generation_id=?').bind(plan.declaration.generationId).all();
  check('实际 D1 完整发布 1000 条并清理旧镜像', after.revision === before.revision + 1 && chunks.results.flatMap((row) => JSON.parse(row.body)).length === 1000 && (await env.DB.prepare('SELECT COUNT(*) AS n FROM mirror_generations').first()).n === 1);
  check('已发布计划重试不推进版本', (await client.publish(plan, controller.signal, () => undefined)).revision === after.revision);
  const tokenRequest = (url, value, token = publisher) => server.fetch(`https://mirror.test${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const a = await planMirror([sample('A')], after), b = await planMirror([sample('B')], after);
  for (const next of [a, b]) {
    assert.equal((await tokenRequest('/v1/generations', next.declaration)).status, 200);
    assert.equal((await tokenRequest(`/v1/generations/${next.declaration.generationId}/chunks/0`, { identity: next.declaration.identity, ...next.parts[0] })).status, 200);
  }
  const publish = (next) => tokenRequest(`/v1/generations/${next.declaration.generationId}/publish`, { identity: next.declaration.identity });
  const raced = await Promise.all([publish(a), publish(b)]);
  check('真实 D1 batch 并发 CAS 只允许一个发布者成功', raced.filter((response) => response.status === 200).length === 1 && (await client.info(controller.signal)).revision === after.revision + 1);
  const cancelPlan = await planMirror([sample('cancel')], await client.info(controller.signal));
  await tokenRequest('/v1/generations', cancelPlan.declaration);
  await tokenRequest(`/v1/generations/${cancelPlan.declaration.generationId}/chunks/0`, { identity: cancelPlan.declaration.identity, ...cancelPlan.parts[0] });
  await client.cancel(cancelPlan, controller.signal);
  check('实际 D1 取消未发布暂存不影响 active 镜像', !(await env.DB.prepare('SELECT id FROM mirror_generations WHERE id=?').bind(cancelPlan.declaration.generationId).first()) && (await client.info(controller.signal)).activeGeneration !== null);
  check('只读令牌不能发布', (await tokenRequest('/v1/generations', a.declaration, reader)).status === 401);
  const login = await server.fetch('https://mirror.test/v1/session', { method: 'POST', headers: { Origin: 'https://mirror.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: reader }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  const privateRead = await server.fetch('https://mirror.test/v1/info', { headers: { Cookie: cookie } });
  check('只读登录 Cookie 可读且私有响应禁缓存', login.status === 200 && privateRead.status === 200 && privateRead.headers.get('cache-control').includes('no-store'));
  check('Cookie 不能调用写接口', (await server.fetch('https://mirror.test/v1/mirror', { method: 'DELETE', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status === 401);
  const page = await server.fetch('https://mirror.test/');
  check('实际静态绑定提供手机页面和严格 CSP', page.status === 200 && (await page.text()).includes('只读或提交凭据') && page.headers.get('content-security-policy').includes("script-src 'self'"));
  await assert.rejects(client.clear(before, controller.signal));
  check('过期清空请求不影响当前发布', (await client.info(controller.signal)).activeGeneration !== null);
  const identity = await client.info(controller.signal);
  const inbound = { identity: { serverId: identity.serverId, libraryId: identity.libraryId, epoch: identity.epoch }, deviceId: crypto.randomUUID(), deviceKey: 'runtime_device_0123456789abcdefghijklmnop', id: crypto.randomUUID(), payload: { destination: 'bookmark', url: 'https://example.com/mobile', title: '手机提交', sourceDescription: '', note: '暂存笔记', categoryId: null, categoryPath: '', tagIds: [], tagNames: [], pinned: false, unread: true, aiBlocked: false } };
  const submitted = await Promise.all([tokenRequest('/v1/inbox', inbound, submitter), tokenRequest('/v1/inbox', inbound, submitter)]);
  check('真实 D1 并发提交同一编号幂等，独立提交凭据不能发布', submitted.every((response) => response.status === 200) && (await env.DB.prepare('SELECT COUNT(*) AS n FROM capture_inbox').first()).n === 1 && (await tokenRequest('/v1/generations', a.declaration, submitter)).status === 401);
  await client.clear(await client.info(controller.signal), controller.signal);
  check('清空当前云库实际删除 D1 数据', (await env.DB.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').first()).n === 0 && !(await client.info(controller.signal)).activeGeneration);
  const pending = await client.inbox(controller.signal);
  check('真实 D1 清镜像不会清待接收记录', pending.entries.length === 1 && pending.entries[0].payload.note === '暂存笔记');
  const receipt = { status: 'received', recordKind: 'bookmark', recordId: 'runtime-local', message: '已接收' };
  await client.acknowledge(pending.entries[0], receipt, controller.signal); await client.acknowledge(pending.entries[0], receipt, controller.signal);
  const saved = await env.DB.prepare('SELECT payload,status FROM capture_inbox WHERE id=?').bind(inbound.id).first();
  check('真实 D1 回执重试幂等且清除正文', saved.payload === null && saved.status === 'received' && (await client.inbox(controller.signal)).entries.length === 0);
  const sharedInfo = await (await server.fetch('https://mirror.test/v2/info', { headers: { Authorization: `Bearer ${publisher}` } })).json();
  check('真实 D1 新同步库独立初始化，未自动迁移个人镜像内容', sharedInfo.protocol === 3 && sharedInfo.revision === 0 && !sharedInfo.enabled);
  const sharedIdentity = { serverId: sharedInfo.serverId, libraryId: sharedInfo.libraryId, epoch: sharedInfo.epoch };
  let sharedRevision = 0, firstOperation;
  const sharedRows = [];
  for (let index = 0; index < 120; index++) sharedRows.push({ key: `b:${hash(`https://example.com/shared/${index}`)}`, expected: 0, data: { kind: 'bookmark', publicId: `runtime-${index}`, url: `https://example.com/shared/${index}`, title: `共享${index}`, sourceDescription: '', note: '同步正文不向手机暴露', selectedText: '', aiPurpose: '', category: null, tags: [], pinned: false, unread: true, aiBlocked: false, lockedFields: [], order: index } });
  for (let index = 0; index < sharedRows.length; index += 50) {
    const value = { identity: sharedIdentity, deviceId: crypto.randomUUID(), operationId: crypto.randomUUID(), baseRevision: sharedRevision, changes: sharedRows.slice(index, index + 50) };
    firstOperation ??= value;
    const response = await tokenRequest('/v2/changes', value); assert.equal(response.status, 200); sharedRevision = (await response.json()).revision;
  }
  check('真实 D1 分批同步 120 条，丢确认同编号重试不推进版本', (await env.DB.prepare('SELECT COUNT(*) AS n FROM shared_entities').first()).n === 120 && (await (await tokenRequest('/v2/changes', firstOperation)).json()).revision === 1 && (await env.DB.prepare('SELECT revision FROM shared_state').first()).revision === 3);
  const publicRows = await server.fetch('https://mirror.test/v2/public', { headers: { Authorization: `Bearer ${reader}` } }); const publicText = await publicRows.text();
  const privateRows = await server.fetch('https://mirror.test/v2/changes', { headers: { Authorization: `Bearer ${reader}` } });
  check('真实 D1 手机只能读取同步白名单，不读取备注正文', publicRows.status === 200 && !publicText.includes('同步正文不向手机暴露') && privateRows.status === 401);
  const changed = { ...sharedRows[0], expected: 1, data: { ...sharedRows[0].data, title: '另一台修改' } };
  const sharedWrite = () => ({ identity: sharedIdentity, deviceId: crypto.randomUUID(), operationId: crypto.randomUUID(), baseRevision: sharedRevision, changes: [changed] });
  const sharedRace = await Promise.all([tokenRequest('/v2/changes', sharedWrite()), tokenRequest('/v2/changes', sharedWrite())]);
  check('真实 D1 双机相同基线并发只成功一次，提交凭据不能同步', sharedRace.filter((response) => response.status === 200).length === 1 && (await tokenRequest('/v2/changes', sharedWrite(), submitter)).status === 401);
  await client.clear(await client.info(controller.signal), controller.signal);
  check('旧镜像清空不会删除双机同步收藏', (await env.DB.prepare('SELECT COUNT(*) AS n FROM shared_entities WHERE body IS NOT NULL').first()).n === 120);
} catch (error) { report.failure = String(error); throw error; }
finally { fs.mkdirSync(path.join(root, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(root, '.verify/reports/cloud-runtime.json'), JSON.stringify(report, null, 2)); await server.close(); }
