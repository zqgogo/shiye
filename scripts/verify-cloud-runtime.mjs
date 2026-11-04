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
const hash = (text) => createHash('sha256').update(text).digest('hex');
const server = createTestHarness({ root, workers: [{ config: { name: 'shiye-runtime-test', main: path.join(root, 'apps/worker/src/index.ts'), compatibility_date: '2026-11-04',
  d1_databases: [{ binding: 'DB', database_name: 'runtime-test', database_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', migrations_dir: path.join(root, 'apps/worker/migrations') }],
  assets: { directory: path.join(root, 'apps/worker/public'), binding: 'ASSETS', run_worker_first: true } },
  secrets: { WRITE_TOKEN_SHA256: hash(publisher), READ_TOKEN_SHA256: hash(reader) } }] });
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
  check('实际静态绑定提供手机页面和严格 CSP', page.status === 200 && (await page.text()).includes('只读访问凭据') && page.headers.get('content-security-policy').includes("script-src 'self'"));
  await assert.rejects(client.clear(before, controller.signal));
  check('过期清空请求不影响当前发布', (await client.info(controller.signal)).activeGeneration !== null);
  await client.clear(await client.info(controller.signal), controller.signal);
  check('清空当前云库实际删除 D1 数据', (await env.DB.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').first()).n === 0 && !(await client.info(controller.signal)).activeGeneration);
} catch (error) { report.failure = String(error); throw error; }
finally { fs.mkdirSync(path.join(root, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(root, '.verify/reports/cloud-runtime.json'), JSON.stringify(report, null, 2)); await server.close(); }
