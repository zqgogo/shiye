import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
const directory = path.join(ROOT, '.verify/organize-plan'); fs.mkdirSync(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), steps: [], errors: [], destinations: [] };
const check = (name, condition) => { assert.ok(condition, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const attempt = await launchBestEffort(BROWSERS.find((row) => row.name === 'Chrome') ?? BROWSERS[0], prepareProfile(directory, 'organize-plan'));
const browser = attempt.browser, page = await browser.newPage(); await page.setViewport({ width: 1400, height: 1000 });
page.on('pageerror', (error) => report.errors.push(String(error)));
const base = `chrome-extension://${attempt.extId}/workspace.html`;
const calls = []; let failOnce = true;
await page.exposeFunction('syntheticAiReply', (url, payload) => {
  report.destinations.push(new URL(url).origin);
  assert.equal(new URL(url).origin, 'https://api.deepseek.com');
  const system = payload.messages[0].content;
  let content;
  if (system.includes('SHIYE_OK')) content = 'SHIYE_OK';
  else if (system.includes('{"ok":true}')) content = '{"ok":true}';
  else {
    const material = JSON.parse(payload.messages[1].content);
    calls.push({ batchId: material.batchId, count: material.items.length, serialized: JSON.stringify(material) });
    if (calls.length === 2 && failOnce) { failOnce = false; return { status: 503, body: '{}' }; }
    content = JSON.stringify({ protocolVersion: 2, batchId: material.batchId, part: material.part, results: material.items.map((row) => ({ n: row.n, titleEcho: row.title, domain: new URL(row.url).hostname, patch: { aiPurpose: '批量用途建议' }, status: 'ok', reason: '依据已给资料' })) });
  }
  return { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }) };
});
await page.evaluateOnNewDocument(() => {
  chrome.permissions.request = async () => true; chrome.permissions.contains = async () => true;
  window.confirm = () => true;
  window.fetch = async (url, init) => { const result = await window.syntheticAiReply(String(url), JSON.parse(init.body)); return new Response(result.body, { status: result.status }); };
});
const waitText = (text) => page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 30000 }, text);
async function click(text) { await page.waitForFunction((needle) => [...document.querySelectorAll('button,summary')].some((node) => node.textContent.trim() === needle && !node.disabled), {}, text); await page.evaluate((needle) => [...document.querySelectorAll('button,summary')].find((node) => node.textContent.trim() === needle && !node.disabled).click(), text); }
const route = async (value) => { await page.evaluate((next) => { window.location.hash = next; }, value); };
async function dump() { return page.evaluate(async () => { const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); });
  const names = ['bookmarks', 'meta', 'handoffBatches', 'handoffItems'], tx = db.transaction(names), requests = names.map((name) => tx.objectStore(name).getAll());
  const result = await new Promise((resolve) => { tx.oncomplete = () => resolve(Object.fromEntries(names.map((name, index) => [name, requests[index].result]))); }); db.close(); return result; }); }
async function configure() { await route('aiconfig'); await page.waitForSelector('input[type=password]'); await setReactInput(page, 'input[type=password]', 'synthetic-plan-api-key'); await click('测试文本连接'); await waitText('文本测试通过'); await click('测试整理输出'); await waitText('整理 JSON 测试通过'); await click('开启内置 AI'); }
try {
  await page.goto(`${base}#organize:batch`); await waitText('生成完整分片计划');
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('bookmarks', 'readwrite'), now = new Date().toISOString();
    for (let index = 0; index < 303; index++) tx.objectStore('bookmarks').put({ id: crypto.randomUUID(), originalUrl: `https://example.com/${index}`, canonicalUrl: `https://example.com/${index}`, title: index < 300 ? `资料${String(index).padStart(3, '0')}` : '不可发送的资料',
      sourceDescription: '', note: '不默认发送的备注', selectedText: '不默认发送的摘录', aiPurpose: '', categoryId: null, categoryKey: 'uncategorized', tagIds: [], inboxUnread: true, unreadFlag: 1, pinned: false, lastOpenedAt: null, privacy: { localOnly: index === 300, aiBlocked: index === 301 }, lockedFields: [], sources: [], revision: 1, localRevision: 1, changeVersion: null, lifeState: index === 302 ? 'deleted' : 'active', deletedAt: index === 302 ? now : null, createdAt: now, updatedAt: now });
    await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close();
  });
  await page.reload(); await waitText('可发送 300 条'); await click('生成完整分片计划'); await waitText('完整计划：300 条 · 15 片');
  let data = await dump(), saved = data.meta.find((row) => row.key.startsWith('ai-organize-plan:')).value;
  const id = saved.id;
  check('300 条完整规划成 15 片，全部编号映射持久化', saved.parts.length === 15 && data.handoffItems.length === 300 && new Set(data.handoffItems.map((row) => row.bookmarkId)).size === 300);
  check('生成计划没有发送任何 AI 请求', calls.length === 0 && data.bookmarks.every((row) => !row.aiPurpose));
  await configure(); await route('organize:batch'); await waitText('最近 20 份未结束计划'); await click('最近 20 份未结束计划（仅本机）'); await waitText('继续此计划'); await click('继续此计划'); await waitText('完整计划：300 条 · 15 片');
  await click('确认发送／重试全部未完成分片'); await waitText('已保存 1 / 15 片回复');
  data = await dump(); saved = data.meta.find((row) => row.key === `ai-organize-plan:${id}`).value;
  check('第二片失败即暂停，第一片回复已经落库', calls.length === 2 && saved.parts[0].state === 'completed' && saved.parts[1].state === 'unknown' && data.handoffBatches.filter((row) => row.directReply).length === 1);
  await page.reload(); await waitText('最近 20 份未结束计划'); await click('最近 20 份未结束计划（仅本机）'); await waitText('继续此计划');
  check('刷新后不自动发送，也不保存 Key', calls.length === 2 && !JSON.stringify(await dump()).includes('synthetic-plan-api-key'));
  await configure(); await route('organize:batch'); await waitText('最近 20 份未结束计划'); await click('最近 20 份未结束计划（仅本机）'); await waitText('继续此计划'); await click('继续此计划');
  await click('只重试失败／中断分片'); await waitText('已保存 2 / 15 片回复');
  check('仅重试失败片，没有重复发送第一片或触及待发送片', calls.length === 3 && calls[1].batchId === calls[2].batchId && calls[0].batchId !== calls[2].batchId);
  await click('确认发送／重试全部未完成分片'); await waitText('已保存 15 / 15 片回复');
  check('续接只请求剩余分片，300 条无丢失、已完成片不重发', calls.length === 16 && new Set(calls.map((row) => row.batchId)).size === 15);
  check('材料排除私密、删除项和默认备注摘录，所有请求直达 AI', calls.every((row) => !/不可发送|不默认发送/.test(row.serialized)) && report.destinations.every((origin) => origin === 'https://api.deepseek.com'));
  check('回复完成不等于应用，主库尚未改写', (await dump()).bookmarks.every((row) => !row.aiPurpose));
  await click('校验所有已完成回复'); await waitText('可应用 300 条');
  check('300 条建议完整校验，预览一次只渲染 50 条', await page.$$eval('.diff', (rows) => rows.length) === 50);
  await page.click('.diff input[type=checkbox]');
  // Review page's pager is the second pager; use its next control by its actual text.
  await page.evaluate(() => { const pagers = [...document.querySelectorAll('.pager')]; const review = pagers.at(-1); const next = [...review.querySelectorAll('button')].find((node) => node.textContent.includes('下一页')); next.click(); });
  await page.click('.diff input[type=checkbox]');
  await click('确认应用已勾选 298 条建议'); await waitText('已应用 298 条');
  check('跨页取消勾选保留，批量应用仅写选中建议', (await dump()).bookmarks.filter((row) => row.aiPurpose === '批量用途建议').length === 298);
  await click('校验所有已完成回复'); await waitText('可应用 2 条');
  await click('确认应用已勾选 2 条建议'); await waitText('已应用 2 条');
  check('同一分片部分应用后，其余两条仍能继续且不重新请求 AI', (await dump()).bookmarks.filter((row) => row.aiPurpose).length === 300 && calls.length === 16);
  await page.evaluate(async () => { const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); }); const tx = db.transaction('bookmarks', 'readwrite'), store = tx.objectStore('bookmarks'), req = store.getAll(); req.onsuccess = () => { const row = req.result.find((row) => row.aiPurpose); store.put({ ...row, note: '应用后我改过的备注', localRevision: row.localRevision + 1, revision: row.revision + 1 }); }; await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close(); });
  await click('撤销此计划已应用建议'); await waitText('已撤销 299 条；1 条因后续修改而保留');
  check('整计划撤销保护后续人工修改，隐私资料仍未改写', (await dump()).bookmarks.filter((row) => row.aiPurpose).length === 1 && (await dump()).bookmarks.filter((row) => row.title === '不可发送的资料').every((row) => !row.aiPurpose));
  await page.screenshot({ path: path.join(directory, 'plan.png'), fullPage: true });
  check('整轮没有页面脚本异常', report.errors.length === 0);
} catch (error) { report.failure = String(error); report.alerts = await page.$$eval('.alert', (nodes) => nodes.map((node) => node.textContent)); console.log(JSON.stringify({ alerts: report.alerts, calls: calls.length })); await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined); throw error; }
finally { fs.mkdirSync(path.join(ROOT, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.verify/reports/organize-plan.json'), JSON.stringify(report, null, 2)); await browser.close(); }
