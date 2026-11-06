import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { prepareCloud, doctorCloud, deployCloud, setupPaths, verifyCloud } from './lib/cloud-setup.mjs';
const root = path.resolve(import.meta.dirname, '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: { name: { type: 'string' }, account: { type: 'string' }, 'database-id': { type: 'string' }, url: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log('用法：npm run cloud:prepare [-- --name 名称]；cloud:doctor；cloud:login；cloud:deploy [-- --account 账户编号]；cloud:verify [-- --url HTTPS根地址]。准备和本地检查不连接云端。'); process.exit(0); }
const command = positionals[0] ?? 'doctor', files = setupPaths(root);
fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
const run = (args, { input } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(files.directory, 'wrangler.log'), CI: 'true' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
  // Never echo credential inputs or vendor error bodies into wrapper output.
  child.stderr.on('data', () => {});
  child.on('error', () => reject(new Error('无法启动 Wrangler，请先 npm ci。')));
  child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`Wrangler ${args.slice(0, 2).join(' ')} 未完成（退出码 ${code}）。本地进度已保留；登录问题请运行 cloud:login，详情可在本机日志核对。`)));
  if (input) child.stdin.write(input); child.stdin.end();
});
try {
  if (command === 'prepare') {
    const result = prepareCloud(root, { name: values.name, account: values.account, databaseId: values['database-id'] });
    console.log(`本地准备完成：${result.config.name}\n配置：${path.relative(root, files.config)}\n发布凭据：${path.relative(root, files.publisher)}\n只读凭据：${path.relative(root, files.reader)}\n提交凭据：${path.relative(root, files.submitter)}\n未打印凭据，也未创建远端资源。下一步：npm run cloud:login，然后 npm run cloud:deploy。`);
  } else if (command === 'doctor') {
    const result = doctorCloud(root); console.log(`本地检查通过：${result.config.name}\n凭据隔离、哈希、文件权限和部署路径正常。D1：${result.database ? '已配置' : '将在部署时创建'}。这不是远端部署完成的证明。`);
  } else if (command === 'login') {
    // Login is the one command intentionally attached to a terminal/browser for the user.
    const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'login'], { cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(files.directory, 'wrangler.log') } });
    child.on('error', () => { process.exitCode = 1; }); await new Promise((resolve) => child.on('close', (code) => { process.exitCode = code ?? 1; resolve(); }));
  } else if (command === 'deploy') {
    const result = await deployCloud(root, { run, account: values.account, log: console.log });
    console.log(`部署并握手检查通过：${result.url}\n两台电脑在「云端与收件箱」填写同一地址及 publisher.txt，先检查再确认双向同步。手机仅查看用 reader.txt，新增提交用 submitter.txt。没有自动上传收藏。`);
  } else if (command === 'verify') {
    const local = doctorCloud(root), saved = fs.existsSync(files.state) ? JSON.parse(fs.readFileSync(files.state, 'utf8')) : {};
    const url = values.url ?? saved.url; if (!url) throw new Error('请用 --url 提供部署后的 HTTPS 根地址。');
    const result = await verifyCloud(url, local.publisher, local.reader, undefined, local.submitter); console.log(`在线握手与权限隔离通过：${result.url}，版本 ${result.revision}。没有上传收藏。`);
  } else throw new Error('支持命令：prepare / doctor / login / deploy / verify。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
