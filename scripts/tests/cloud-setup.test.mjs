import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepareCloud, doctorCloud, deployCloud, chooseAccount, setupPaths, findWorkersUrl, verifyCloud, tokenHash } from '../lib/cloud-setup.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiye-cloud-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'apps/worker/src'), { recursive: true }); fs.mkdirSync(path.join(root, 'apps/worker/migrations')); fs.mkdirSync(path.join(root, 'apps/worker/public'));
  fs.writeFileSync(path.join(root, 'apps/worker/src/index.ts'), 'export default {};'); fs.writeFileSync(path.join(root, 'apps/worker/migrations/0001_mirror.sql'), 'SELECT 1;');
  return root;
}
const account = 'a'.repeat(32), databaseId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
function remote(root, { existing = false, failAfterCreate = false } = {}) {
  const calls = []; let created = existing, failed = false;
  return { calls, run: async (args, options = {}) => {
    calls.push({ args, input: options.input }); const config = JSON.parse(fs.readFileSync(setupPaths(root).config, 'utf8'));
    if (args[0] === 'whoami') return JSON.stringify({ loggedIn: true, accounts: [{ id: account }] });
    if (args[0] === 'd1' && args[1] === 'list') return JSON.stringify(created ? [{ name: config.name, uuid: databaseId }] : []);
    if (args[0] === 'd1' && args[1] === 'create') {
      created = true;
      if (failAfterCreate && !failed) { failed = true; throw new Error('response lost after creating database'); }
      config.d1_databases = [{ binding: 'DB', database_name: config.name, database_id: databaseId }]; fs.writeFileSync(setupPaths(root).config, JSON.stringify(config)); return '';
    }
    if (args[0] === 'deploy') return `Uploaded code\nhttps://${config.name}.my-account.workers.dev\n`;
    return '';
  } };
}
const verified = async (url) => ({ url, serverId: 'test-server', libraryId: 'test-library', epoch: 'test-epoch', revision: 0 });

test('准备仅写本地私有配置，凭据相互独立，重复执行保持原值', (t) => {
  const root = fixture(t), first = prepareCloud(root), second = prepareCloud(root);
  assert.equal(first.config.name, second.config.name); assert.equal(first.publisher, second.publisher); assert.notEqual(first.publisher, first.reader);
  assert.equal(tokenHash(first.publisher), first.writeHash); assert.equal(tokenHash(first.reader), first.readHash);
  assert.equal(JSON.stringify(first.config).includes(first.publisher), false); assert.equal(first.config.d1_databases.length, 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(first.files.publisher).mode & 0o077, 0);
});
test('不完整凭据、权限过宽、非法路径及换账号不会被悄悄修复覆盖', (t) => {
  const root = fixture(t), ready = prepareCloud(root, { account });
  assert.throws(() => prepareCloud(root, { account: 'b'.repeat(32) }));
  if (process.platform !== 'win32') { fs.chmodSync(ready.files.publisher, 0o644); assert.throws(() => doctorCloud(root), /权限/); fs.chmodSync(ready.files.publisher, 0o600); }
  const config = { ...ready.config, main: '../../other.ts' }; fs.writeFileSync(ready.files.config, JSON.stringify(config)); assert.throws(() => doctorCloud(root));
  fs.writeFileSync(ready.files.config, JSON.stringify(ready.config)); fs.unlinkSync(ready.files.readHash); assert.throws(() => prepareCloud(root), /不完整/);
});
test('多账号必须明确选择，不自动切换已绑定账号', () => {
  assert.throws(() => chooseAccount([{ id: account }, { id: 'b'.repeat(32) }]));
  assert.equal(chooseAccount([{ id: account }]), account);
  assert.throws(() => chooseAccount([{ id: account }, { id: 'b'.repeat(32) }], 'b'.repeat(32), account));
});
test('部署按顺序核对账号、创建资源、迁移、发版和设置哈希；没有传递原始凭据', async (t) => {
  const root = fixture(t), prepared = prepareCloud(root), fake = remote(root);
  const result = await deployCloud(root, { run: fake.run, verify: verified });
  assert.match(result.url, /workers\.dev$/);
  assert.deepEqual(fake.calls.map((call) => call.args.slice(0, 2).join(' ')), ['whoami --json', 'd1 list', 'd1 create', 'd1 migrations', 'deploy --config', 'secret bulk']);
  const bulk = fake.calls.find((call) => call.args[0] === 'secret').input;
  assert.equal(JSON.parse(bulk).WRITE_TOKEN_SHA256, prepared.writeHash);
  assert.equal(JSON.stringify(fake.calls).includes(prepared.publisher), false); assert.equal(JSON.stringify(fake.calls).includes(prepared.reader), false);
  assert.equal(JSON.parse(fs.readFileSync(prepared.files.state)).stage, 'verified');
});
test('创建成功但响应丢失后，重跑先查询并复用已有 D1，不重复创建或换密钥', async (t) => {
  const root = fixture(t), first = prepareCloud(root), fake = remote(root, { failAfterCreate: true });
  await assert.rejects(deployCloud(root, { run: fake.run, verify: verified }));
  await deployCloud(root, { run: fake.run, verify: verified });
  assert.equal(fake.calls.filter((call) => call.args[0] === 'd1' && call.args[1] === 'create').length, 1);
  assert.equal(doctorCloud(root).publisher, first.publisher);
});
test('登录失败时没有资源写入；只识别此项目的 workers.dev 地址', async (t) => {
  const root = fixture(t); prepareCloud(root);
  const calls = []; await assert.rejects(deployCloud(root, { run: async (args) => { calls.push(args); return '{"loggedIn":false}'; } })); assert.equal(calls.length, 1);
  assert.equal(findWorkersUrl('https://docs.example.com https://other.user.workers.dev https://shiye-one.user.workers.dev', 'shiye-one'), 'https://shiye-one.user.workers.dev');
  assert.equal(findWorkersUrl('https://shiye-one.user.workers.dev.attacker.com', 'shiye-one'), null);
});
test('在线验证只发送握手和无效的只读写入探针，不上传记录，不跟随重定向', async () => {
  const requests = [], info = { protocol: 1, serverId: 'server', libraryId: 'library', epoch: 'epoch', revision: 0 };
  const result = await verifyCloud('https://shiye.example.com', 'publisher', 'reader', async (url, init) => {
    requests.push({ url, ...init }); const auth = init.headers.Authorization;
    if (!auth || new URL(url).pathname === '/v1/generations') return new Response('{}', { status: 401 });
    return new Response(JSON.stringify(info), { headers: { 'Cache-Control': 'no-store' } });
  });
  assert.equal(result.revision, 0); assert.equal(requests.length, 4);
  assert.equal(requests.filter((request) => request.method === 'POST')[0].body, '{}');
  assert.ok(requests.every((request) => request.redirect === 'error' && !request.url.includes('publisher') && !request.url.includes('reader')));
  await assert.rejects(verifyCloud('http://example.com', 'publisher', 'reader'));
  await assert.rejects(verifyCloud('https://user:pass@example.com', 'publisher', 'reader'));
});
