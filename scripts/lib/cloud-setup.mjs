import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import ts from 'typescript';
export const tokenHash = (value) => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9]{32}$/i, uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const namePattern = /^[a-z][a-z0-9-]{2,62}$/;
export function setupPaths(root) {
  const directory = path.join(root, '.verify/cloudflare-setup');
  return { root, directory, config: path.join(root, 'apps/worker/wrangler.local.jsonc'), state: path.join(directory, 'deployment.json'),
    publisher: path.join(directory, 'publisher.txt'), reader: path.join(directory, 'reader.txt'),
    submitter: path.join(directory, 'submitter.txt'), submitHash: path.join(directory, 'SUBMIT_TOKEN_SHA256.txt'),
    writeHash: path.join(directory, 'WRITE_TOKEN_SHA256.txt'), readHash: path.join(directory, 'READ_TOKEN_SHA256.txt') };
}
export function readConfig(file) {
  const result = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'));
  if (result.error || !result.config || typeof result.config !== 'object') throw new Error('本地 Cloudflare 配置不是有效 JSON/JSONC，请先修正。');
  return result.config;
}
export function writePrivate(file, value, exclusive = false) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('拒绝写入符号链接凭据或配置文件。');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
const writeJson = (file, value, exclusive = false) => writePrivate(file, JSON.stringify(value, null, 2) + '\n', exclusive);
export function prepareCloud(root, options = {}) {
  const files = setupPaths(root); fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(files.config) ? readConfig(files.config) : null;
  const name = options.name ?? existing?.name ?? `shiye-library-${randomBytes(4).toString('hex')}`;
  if (!namePattern.test(name)) throw new Error('名称需以小写字母开头，使用 3–63 位小写字母、数字或短横线。');
  if (options.account && !idPattern.test(options.account)) throw new Error('Cloudflare account ID 格式不正确。');
  if (options.databaseId && !uuidPattern.test(options.databaseId)) throw new Error('D1 database ID 格式不正确。');
  if (existing && ((options.name && name !== existing.name) || (options.account && existing.account_id && options.account !== existing.account_id) || (options.databaseId && existing.d1_databases?.[0]?.database_id !== options.databaseId))) throw new Error('已有配置不会被换名、换账号或换库覆盖，请使用原配置继续。');
  const credentialFiles = [files.publisher, files.reader, files.writeHash, files.readHash];
  const count = credentialFiles.filter((file) => fs.existsSync(file)).length;
  if (count && count !== credentialFiles.length) throw new Error('本地凭据文件不完整，未覆盖或重新生成。请先恢复已有凭据文件。');
  if (!count) {
    const publisher = randomBytes(32).toString('base64url'), reader = randomBytes(32).toString('base64url');
    for (const [file, value] of [[files.publisher, publisher], [files.reader, reader], [files.writeHash, tokenHash(publisher)], [files.readHash, tokenHash(reader)]]) writePrivate(file, value + '\n', true);
    const localVars = path.join(files.directory, 'local.dev.vars');
    if (!fs.existsSync(localVars)) writePrivate(localVars, `WRITE_TOKEN_SHA256=${tokenHash(publisher)}\nREAD_TOKEN_SHA256=${tokenHash(reader)}\n`, true);
  }
  if (!existing) writeJson(files.config, { name, main: 'src/index.ts', compatibility_date: '2026-11-04', workers_dev: true,
    ...(options.account ? { account_id: options.account } : {}), assets: { directory: './public', binding: 'ASSETS', run_worker_first: true },
    d1_databases: options.databaseId ? [{ binding: 'DB', database_name: name, database_id: options.databaseId, migrations_dir: 'migrations' }] : [] }, true);
  const submitCount = [files.submitter, files.submitHash].filter((file) => fs.existsSync(file)).length;
  if (submitCount === 1) throw new Error('本地提交凭据不完整，未自动更换；请恢复原文件。');
  if (!submitCount) { const submitter = randomBytes(32).toString('base64url'); writePrivate(files.submitter, submitter + '\n', true); writePrivate(files.submitHash, tokenHash(submitter) + '\n', true); }
  const result = doctorCloud(root);
  writePrivate(path.join(files.directory, 'local.dev.vars'), `WRITE_TOKEN_SHA256=${result.writeHash}\nREAD_TOKEN_SHA256=${result.readHash}\nSUBMIT_TOKEN_SHA256=${result.submitHash}\n`);
  return result;
}
export function doctorCloud(root) {
  const files = setupPaths(root);
  if (!fs.existsSync(files.config)) throw new Error('尚未准备本地配置，请先运行 npm run cloud:prepare。');
  const config = readConfig(files.config), base = path.dirname(files.config);
  if (!namePattern.test(config.name ?? '') || (config.account_id && !idPattern.test(config.account_id))) throw new Error('本地项目名称或账号编号不合法。');
  if (path.resolve(base, config.main ?? '') !== path.join(root, 'apps/worker/src/index.ts') || path.resolve(base, config.assets?.directory ?? '') !== path.join(root, 'apps/worker/public') || config.assets?.binding !== 'ASSETS' || config.assets?.run_worker_first !== true) throw new Error('部署入口或静态资源路径与拾页工程不一致，请核对本地配置。');
  if (!fs.existsSync(path.resolve(base, config.main)) || !fs.existsSync(path.join(root, 'apps/worker/migrations/0001_mirror.sql'))) throw new Error('缺少 Worker 源码或数据库迁移文件。');
  for (const file of [files.publisher, files.reader, files.writeHash, files.readHash, files.submitter, files.submitHash]) {
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new Error('缺少正常的凭据文件，或文件是符号链接。');
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077)) throw new Error('凭据文件权限过宽，请设置为仅当前用户可读写。');
  }
  const publisher = fs.readFileSync(files.publisher, 'utf8').trim(), reader = fs.readFileSync(files.reader, 'utf8').trim();
  const writeHash = fs.readFileSync(files.writeHash, 'utf8').trim(), readHash = fs.readFileSync(files.readHash, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(publisher) || !/^[A-Za-z0-9_-]{32,256}$/.test(reader) || publisher === reader || tokenHash(publisher) !== writeHash || tokenHash(reader) !== readHash) throw new Error('发布/只读凭据的格式、隔离或哈希校验失败，未自动更换凭据。');
  const submitter = fs.readFileSync(files.submitter, 'utf8').trim(), submitHash = fs.readFileSync(files.submitHash, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(submitter) || [publisher, reader].includes(submitter) || tokenHash(submitter) !== submitHash) throw new Error('提交凭据校验失败，需与发布、只读凭据相互独立。');
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length > 1) throw new Error('本向导只部署单个独立 D1，请核对数据库绑定。');
  const database = config.d1_databases[0] ?? null;
  if (database && (database.binding !== 'DB' || !uuidPattern.test(database.database_id ?? '') || !namePattern.test(database.database_name ?? '') || path.resolve(base, database.migrations_dir ?? 'migrations') !== path.join(root, 'apps/worker/migrations'))) throw new Error('数据库编号、绑定或迁移目录不合法。');
  return { files, config, database, publisher, reader, writeHash, readHash, submitter, submitHash };
}
export function chooseAccount(accounts, requested, configured) {
  const id = requested ?? configured ?? (accounts.length === 1 ? accounts[0]?.id : null);
  if (!id || !idPattern.test(id) || !accounts.some((account) => account.id === id)) throw new Error('请用 --account 指定有权限的 Cloudflare account ID；未选择账号前不会创建资源。');
  if (configured && id !== configured) throw new Error('本地配置已绑定其他账号，未自动切换。');
  return id;
}
export function findWorkersUrl(output, name) {
  for (const raw of output.match(/https:\/\/[^\s<>"']+/g) ?? []) {
    try { const url = new URL(raw.replace(/[),;]+$/, '')); if (url.hostname.startsWith(`${name}.`) && url.hostname.endsWith('.workers.dev') && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash) return url.origin; } catch { /* Ignore unrelated diagnostic links. */ }
  }
  return null;
}
export async function verifyCloud(url, publisher, reader, fetcher = fetch, submitter) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new Error('验证地址需为不含认证信息的 HTTPS 根地址。');
  const send = async (path, token, options = {}) => {
    const result = await fetcher(new URL(path, base).href, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...options });
    return result;
  };
  const writer = await send('/v1/info', publisher), viewer = await send('/v1/info', reader), anonymous = await send('/v1/info');
  if (!writer.ok || !viewer.ok || anonymous.status !== 401 || !writer.headers.get('cache-control')?.includes('no-store')) throw new Error('在线鉴权或私有响应检查未通过，没有上传任何收藏。');
  const first = await writer.json(), second = await viewer.json();
  if (first.protocol !== 1 || !first.serverId || !first.libraryId || !first.epoch || first.serverId !== second.serverId || first.libraryId !== second.libraryId || first.epoch !== second.epoch) throw new Error('后端协议或读写库身份不一致。');
  // Invalid empty declaration is intentional: even a misconfigured server cannot mutate records here.
  const denied = await send('/v1/generations', reader, { method: 'POST', body: '{}' });
  if (denied.status !== 401) throw new Error('只读凭据的写入隔离检查未通过。');
  if (submitter) {
    const capabilities = await send('/v1/capabilities', submitter);
    if (!capabilities.ok || !(await capabilities.json()).canSubmit) throw new Error('提交凭据尚未生效，请重跑部署完成 secret 配置。');
    if ((await send('/v1/generations', submitter, { method: 'POST', body: '{}' })).status !== 401 ||
        (await send('/v1/inbox', reader, { method: 'POST', body: '{}' })).status !== 401 ||
        (await send('/v1/inbox', submitter, { method: 'POST', body: '{}' })).status !== 400) throw new Error('提交与只读/发布权限隔离检查未通过。');
  }
  return { url: base.origin, serverId: first.serverId, libraryId: first.libraryId, epoch: first.epoch, revision: first.revision };
}
export async function deployCloud(root, { run, account, verify = verifyCloud, log = () => {} }) {
  const prepared = doctorCloud(root), { files } = prepared;
  const authResult = await run(['whoami', '--json']);
  let auth; try { auth = JSON.parse(authResult); } catch { throw new Error('无法读取登录状态，请先运行 npm run cloud:login。'); }
  if (!auth.loggedIn || !Array.isArray(auth.accounts)) throw new Error('请先运行 npm run cloud:login 登录自己的 Cloudflare。');
  const accountId = chooseAccount(auth.accounts, account, prepared.config.account_id);
  let config = { ...prepared.config, account_id: accountId };
  const state = fs.existsSync(files.state) ? JSON.parse(fs.readFileSync(files.state, 'utf8')) : {};
  if (state.accountId && state.accountId !== accountId) throw new Error('已有部署状态属于其他账号，未执行部署。');
  if ((state.name && state.name !== config.name) || (state.databaseId && prepared.database && state.databaseId !== prepared.database.database_id)) throw new Error('项目名称或数据库与已有部署状态不一致，未自动迁移。');
  writeJson(files.config, config);
  const checkpoint = (values) => { Object.assign(state, { name: config.name, accountId }, values); writeJson(files.state, state); };
  checkpoint({ stage: 'account_checked' });
  const cli = ['--config', files.config];
  if (!prepared.database) {
    log('检查或创建独立 D1 数据库…');
    let databases; try { databases = JSON.parse(await run(['d1', 'list', '--json', ...cli])); } catch { throw new Error('无法核对 D1 列表，没有盲目重复创建数据库。'); }
    const existing = databases.filter((database) => database.name === config.name);
    if (existing.length > 1) throw new Error('存在多份同名数据库，请先人工核对。');
    if (existing.length === 1) {
      const id = existing[0].uuid ?? existing[0].id; if (!uuidPattern.test(id ?? '')) throw new Error('D1 返回的编号格式不合法。');
      config.d1_databases = [{ binding: 'DB', database_name: config.name, database_id: id, migrations_dir: 'migrations' }]; writeJson(files.config, config);
    } else {
      await run(['d1', 'create', config.name, '--binding', 'DB', '--update-config', ...cli]);
      config = readConfig(files.config);
      if (!config.d1_databases?.[0]?.database_id) throw new Error('D1 已可能创建，但配置未返回编号。请重新运行部署，向导会先核对已有数据库。');
      config.d1_databases[0].migrations_dir = 'migrations'; writeJson(files.config, config);
    }
  }
  const ready = doctorCloud(root); config = ready.config;
  checkpoint({ stage: 'database_ready', databaseId: ready.database.database_id });
  log('应用 D1 迁移…'); await run(['d1', 'migrations', 'apply', 'DB', '--remote', ...cli]); checkpoint({ stage: 'migrated' });
  log('部署 Worker 与私有只读网页…'); const output = await run(['deploy', ...cli]);
  const url = findWorkersUrl(output, config.name);
  checkpoint({ stage: 'code_deployed', url });
  log('配置独立发布/只读凭据哈希…');
  await run(['secret', 'bulk', ...cli], { input: JSON.stringify({ WRITE_TOKEN_SHA256: ready.writeHash, READ_TOKEN_SHA256: ready.readHash, SUBMIT_TOKEN_SHA256: ready.submitHash }) });
  checkpoint({ stage: 'secrets_configured' });
  if (!url) throw new Error('代码及凭据已部署，但未识别服务地址。请从 Cloudflare 控制台获取 HTTPS 地址并运行 cloud:verify -- --url 地址。');
  log('只做在线握手验证，不上传收藏…');
  const result = await verify(url, ready.publisher, ready.reader, undefined, ready.submitter); checkpoint({ stage: 'verified', identity: result });
  return { files, ...result };
}
