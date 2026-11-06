import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
import { createMirrorHarness } from './lib/mirror-test-harness.mjs';
const directory = path.join(ROOT, '.verify/connections'); fs.mkdirSync(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), steps: [], errors: [] }, check = (name, value) => { assert.ok(value, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const harness = await createMirrorHarness(ROOT, directory), requests = [];
const attempt = await launchBestEffort(BROWSERS.find((row) => row.name === 'Edge') ?? BROWSERS[0], prepareProfile(directory, 'connections'));
const browser = attempt.browser, page = await browser.newPage(); await page.setViewport({ width: 1400, height: 1100 }); page.on('pageerror', (error) => report.errors.push(String(error)));
await page.exposeFunction('connectionRequest', async (url, init) => { assert.equal(new URL(url).origin, 'https://mirror.test'); requests.push(new URL(url).pathname); return harness.request(url, init); });
await page.evaluateOnNewDocument(() => {
  chrome.permissions.request = async () => true; chrome.permissions.contains = async () => true;
  window.permissionListeners = []; chrome.permissions.onRemoved.addListener = (fn) => window.permissionListeners.push(fn); chrome.permissions.onRemoved.removeListener = (fn) => { window.permissionListeners = window.permissionListeners.filter((entry) => entry !== fn); };
  window.aiRequests = []; window.textFail = false; window.jsonFail = false; window.aiHold = false; window.cloudHold = false;
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin === 'https://mirror.test') {
      if (window.cloudHold && url.pathname === '/v1/info') await new Promise((resolve) => { window.releaseCloud = resolve; });
      const result = await window.connectionRequest(url.href, { method: init.method, headers: init.headers, body: init.body }); return new Response(result.body, { status: result.status, headers: result.headers });
    }
    if (!['https://api.deepseek.com', 'https://compatible.example'].includes(url.origin)) throw new Error('unexpected network target');
    if (url.pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'synthetic-chat' }, { id: 'synthetic-second' }] }));
    const request = JSON.parse(init.body); window.aiRequests.push(request);
    const json = request.messages[0].content.includes('只返回 JSON');
    if (window.aiHold) await new Promise((resolve) => { window.releaseAi = resolve; });
    if (!json && window.textFail) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: json ? window.jsonFail ? 'invalid-json' : '{"ok":true}' : 'SHIYE_OK' } }] }));
  };
});
const text = (needle) => page.waitForFunction((value) => document.body.innerText.includes(value), { polling: 100, timeout: 20000 }, needle);
async function click(label) { await page.waitForFunction((value) => [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === value && !node.disabled), { polling: 100 }, label); await page.evaluate((value) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === value && !node.disabled).click(), label); }
async function route(value) { await page.evaluate((next) => { location.hash = next; }, value); await page.waitForFunction((next) => location.hash === `#${next}`, { polling: 100 }, value); }
const disabled = (label) => page.evaluate((value) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === value)?.disabled, label);
const aiKey = 'synthetic-ai-key-config-only', secondKey = 'synthetic-compatible-key-config-only';
try {
  await page.goto(`chrome-extension://${attempt.extId}/workspace.html#aiconfig`); await text('尚未配置 Key');
  await setReactInput(page, 'input[list=ai-models]', 'synthetic-chat'); await setReactInput(page, 'input[type=password]', aiKey);
  await click('保存普通设置（不含 Key）'); await text('普通设置已保存');
  check('保存 AI 普通配置不等于验证或开启，也不持久保存 Key', await disabled('开启内置 AI') && await page.evaluate((key) => { const value = localStorage.getItem('shiye:ai-preferences'); return value.includes('synthetic-chat') && !value.includes(key) && !value.includes('apiKey'); }, aiKey));
  await click('测试文本连接'); await text('文本测试通过'); await click('测试整理输出'); await text('整理 JSON 测试通过'); await click('开启内置 AI'); await text('已开启 · 问答与整理可用');
  check('问答、整理和通道开启分别明确显示，已验证配置默认收起', await page.evaluate(() => !document.querySelector('.connection-editor').open && document.querySelector('.connection-checks').textContent.includes('问答连接：已通过') && document.querySelector('.connection-checks').textContent.includes('整理输出：已通过')));
  await page.screenshot({ path: path.join(directory, 'ai.png'), fullPage: true });
  const calls = await page.evaluate(() => window.aiRequests.length); await route('settings'); await text('查看 / 修改 AI 配置');
  check('设置总览及侧栏能看到 AI 已开启，切页不丢配置或自动发请求', await page.$eval('.connection-overview', (node) => node.textContent.includes('已开启 · 问答与整理可用')) && await page.evaluate((before) => window.aiRequests.length === before, calls));
  await click('查看 / 修改 AI 配置'); await text('修改 AI 配置'); await click('修改 AI 配置');
  check('修改入口展开配置并保留当前工作台 Key', await page.$eval('.connection-editor', (node) => node.open) && await page.$eval('input[type=password]', (node) => node.value) === aiKey);
  await setReactInput(page, '.two input[type=number]', '80000'); await text('配置已修改');
  check('修改预算立即关闭通道并使问答、整理测试失效', await disabled('开启内置 AI') && await page.$eval('.connection-checks', (node) => node.textContent.includes('问答连接：待测试') && node.textContent.includes('整理输出：待测试')));
  await click('测试文本连接'); await text('文本测试通过'); await click('开启内置 AI'); await page.evaluate(() => { window.jsonFail = true; }); await click('测试整理输出'); await text('严格 JSON 测试');
  check('整理复测失败立即失效，仍明确区分问答可用与整理不可用', await page.$eval('.connection-checks', (node) => node.textContent.includes('问答连接：已通过') && node.textContent.includes('整理输出：待测试')) && await page.$eval('.connection-card', (node) => node.textContent.includes('已开启 · 问答可用')));
  await page.evaluate(() => { window.textFail = true; }); await click('测试文本连接'); await text('连接测试未通过');
  check('文本复测失败清除旧通过标记与开启状态，不继续冒充可用', await disabled('开启内置 AI') && await page.$eval('.connection-checks', (node) => node.textContent.includes('问答连接：待测试') && node.textContent.includes('通道：已关闭')));
  await page.evaluate(() => { window.textFail = false; window.jsonFail = false; window.aiHold = true; }); await click('测试文本连接'); await page.waitForFunction(() => Boolean(window.releaseAi), { polling: 100 });
  await click('修改 AI 配置'); await setReactInput(page, 'input[list=ai-models]', 'edited-model'); await page.evaluate(() => { window.aiHold = false; window.releaseAi(); }); await text('配置已修改');
  check('修改后迟到测试不会恢复通过状态或旧成功提示', await disabled('开启内置 AI') && await page.$eval('[role=status]', (node) => !node.textContent.includes('文本测试通过')));
  await click('读取模型列表'); await text('模型列表已读取'); check('读取模型列表独立于测试与开启状态', await page.$$eval('#ai-models option', (nodes) => nodes.length) === 2 && await disabled('开启内置 AI'));
  await page.select('.two select', 'compatible'); await setReactInput(page, '.two label:nth-child(2) input', 'https://compatible.example');
  check('更换服务清除旧 Key 和旧模型列表，不携带旧密钥到新地址', await page.$eval('input[type=password]', (node) => node.value === '') && await page.$$eval('#ai-models option', (nodes) => nodes.length) === 0 && await disabled('测试文本连接'));
  await setReactInput(page, 'input[type=password]', secondKey); await click('保存普通设置（不含 Key）'); await click('测试文本连接'); await text('文本测试通过'); await click('开启内置 AI');
  await route('cloud'); await text('Cloudflare 连接状态'); await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test'); await click('保存后端地址'); await text('后端地址已保存');
  check('保存后端地址明确提示待填凭据，不伪装已连接', await page.$eval('.connection-card', (node) => node.textContent.includes('已保存地址 · 待填凭据')) && requests.length === 0);
  await setReactInput(page, 'input[type=password]', harness.reader); await click('测试连接（不上传）'); await text('连接验证未通过');
  check('只读凭据不能被误判为可同步的发布连接', await page.evaluate(() => ![...document.querySelectorAll('button')].some((node) => node.textContent.trim() === '检查两台电脑同步')));
  await setReactInput(page, 'input[type=password]', harness.publisher); await click('测试连接（不上传）'); await text('连接通过');
  check('发布凭据验证权限和同步协议后显示已连接与同步版本', await page.$eval('.connection-card', (node) => node.textContent.includes('已连接 · 当前工作台可用') && node.textContent.includes('共享收藏同步版本 0')) && await page.$eval('.connection-editor', (node) => !node.open));
  const connectedRequests = requests.length; await route('settings'); await text('已连接 · 当前工作台可用'); await page.screenshot({ path: path.join(directory, 'overview.png'), fullPage: true });
  await click('查看 / 修改云端配置'); await text('Cloudflare 连接状态');
  check('云端连接在同一工作台切页后保留，返回不自动同步或重发握手', requests.length === connectedRequests && await page.$eval('input[type=password]', (node) => node.value) === harness.publisher);
  await click('修改地址或凭据'); await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://other.example');
  check('修改后端地址清除凭据及原验证，未保存新地址有单独提示', await page.$eval('input[type=password]', (node) => node.value === '') && await page.$eval('.connection-card', (node) => node.textContent.includes('地址未保存')) && requests.length === connectedRequests);
  await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test'); await setReactInput(page, 'input[type=password]', harness.publisher);
  await page.evaluate(() => { window.cloudHold = true; }); await click('测试连接（不上传）'); await page.waitForFunction(() => Boolean(window.releaseCloud), { polling: 100 });
  await setReactInput(page, 'input[type=password]', 'different_publisher_0123456789_abcdefghijklmnopqrstuvwxyz'); await page.evaluate(() => { window.cloudHold = false; window.releaseCloud(); });
  await text('原连接已失效'); check('旧握手迟到不能重新启用已修改的云端配置', await page.evaluate(() => ![...document.querySelectorAll('button')].some((node) => node.textContent.trim() === '检查两台电脑同步')));
  await setReactInput(page, 'input[type=password]', harness.publisher); await click('测试连接（不上传）'); await text('连接通过');
  await page.evaluate(() => { for (const callback of [...window.permissionListeners]) callback({ origins: ['https://mirror.test/*'] }); }); await text('访问权限已撤销');
  check('撤销域名权限后全局连接状态立即失效，不保留旧成功提示', await page.$eval('.connection-card', (node) => node.textContent.includes('连接验证未通过')) && await page.$eval('[role=status]', (node) => !node.textContent.includes('连接通过')));
  await click('修改地址或凭据'); await setReactInput(page, 'input[type=password]', harness.publisher);
  await click('测试连接（不上传）'); await text('连接通过'); await page.screenshot({ path: path.join(directory, 'cloud.png'), fullPage: true });
  await click('修改地址或凭据'); await page.click('[aria-label="在此设备记住发布凭据"]');
  check('主动勾选后保存本机发布凭据', await page.$eval('[aria-label="在此设备记住发布凭据"]', n=>n.checked));
  const beforeRememberReload = requests.length;
  await page.reload(); await text('连接通过');
  check('刷新恢复发布凭据并自动验证', await page.$eval('input[type=password]', (n)=>Boolean(n.value)) && requests.length > beforeRememberReload);
  check('自动恢复只做身份查询，不上传收藏', harness.db.prepare('SELECT COUNT(*) AS n FROM shared_entities').get().n === 0);
  await click('修改地址或凭据'); await page.click('[aria-label="在此设备记住发布凭据"]');
  check('取消记住删除保存记录但保留当前页面连接', await page.evaluate(()=>!localStorage.getItem('shiye:remembered-cloud-credential')) && await page.$eval('input[type=password]', n=>Boolean(n.value)));
  await click('断开并清除凭据'); await text('已断开'); check('主动断开清除当前工作台凭据，保留地址且不自动重连', await page.$eval('input[type=password]', (node) => node.value === '') && await page.$eval('.connection-card', (node) => node.textContent.includes('已保存地址 · 待填凭据')));
  await route('settings'); const beforeReload = requests.length; await page.reload(); await text('已保存设置 · 待填 Key'); await text('已保存地址 · 待填凭据');
  check('刷新只恢复普通设置，测试与开启状态不恢复，不自动联网', requests.length === beforeReload && await page.$eval('.connection-overview', (node) => !node.textContent.includes('已连接 · 当前工作台可用') && !node.textContent.includes('已开启')));
  check('本机存储不含 Cloudflare 发布凭据或 AI Key', await page.evaluate((secrets) => secrets.every((secret) => !JSON.stringify(localStorage).includes(secret)), [harness.publisher, aiKey, secondKey]));
  await click('查看 / 修改 AI 配置'); await text('API Key'); check('保存的模型地址预算仍保留，Key 为空且必须重新测试', await page.$eval('input[list=ai-models]', (node) => node.value === 'edited-model') && await page.$eval('.two label:nth-child(2) input', (node) => node.value === 'https://compatible.example') && await page.$eval('input[type=password]', (node) => node.value === '') && await disabled('开启内置 AI'));
  await route('settings'); await page.setViewport({ width: 390, height: 844 }); await page.screenshot({ path: path.join(directory, 'mobile-overview.png'), fullPage: true }); check('设置总览小屏无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('整轮检查未上传收藏、未发真实 AI 请求、无页面异常', harness.db.prepare('SELECT COUNT(*) AS n FROM shared_entities').get().n === 0 && report.errors.length === 0);
} catch (error) { report.failure = String(error); report.diagnostics = await page.evaluate(() => ({ route: location.hash, status: [...document.querySelectorAll('.connection-card')].map((node) => node.innerText), passwordChanged: document.querySelector('input[type=password]')?.value?.startsWith('different_publisher_') ?? false, buttons: [...document.querySelectorAll('button')].map((node) => node.textContent.trim()) })); console.log(JSON.stringify(report.diagnostics)); console.log(await page.$$eval('[role=status]', (nodes) => nodes.map((node) => node.textContent))); await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => undefined); throw error; }
finally { fs.mkdirSync(path.join(ROOT, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.verify/reports/connections.json'), JSON.stringify(report, null, 2)); await browser.close(); harness.close(); }
