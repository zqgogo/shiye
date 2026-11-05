import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
import { createMirrorHarness } from './lib/mirror-test-harness.mjs';
const directory = path.join(ROOT, '.verify/cloud-publication'); fs.mkdirSync(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), steps: [], errors: [], requests: [] };
const check = (name, condition) => { assert.ok(condition, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const harness = await createMirrorHarness(ROOT, directory);
const attempt = await launchBestEffort(BROWSERS.find((row) => row.name === 'Chrome') ?? BROWSERS[0], prepareProfile(directory, 'cloud-publication'));
const browser = attempt.browser, page = await browser.newPage(); await page.setViewport({ width: 1400, height: 1000 });
page.on('pageerror', (error) => report.errors.push(String(error)));
let loseResponse = true, privacyTarget = null;
await page.exposeFunction('publicationRequest', async (url, init) => {
  assert.equal(new URL(url).origin, 'https://mirror.test'); const pathname = new URL(url).pathname;
  report.requests.push({ path: pathname, method: init.method });
  const result = await harness.request(url, init);
  if (loseResponse && pathname.endsWith('/chunks/1') && result.status === 200) { loseResponse = false; throw new Error('synthetic lost response after server commit'); }
  if (privacyTarget && pathname.endsWith('/chunks/0') && result.status === 200) { const target = privacyTarget; privacyTarget = null; await makePrivate(target); }
  return result;
});
await page.evaluateOnNewDocument(() => {
  chrome.permissions.request = async () => true; chrome.permissions.contains = async () => true; window.confirm = () => true;
  window.fetch = async (url, init = {}) => { const result = await window.publicationRequest(String(url), { method: init.method, headers: init.headers, body: init.body }); return new Response(result.body, { status: result.status, headers: result.headers }); };
});
const waitText = (text) => page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 30000 }, text);
async function click(text) { await page.waitForFunction((needle) => [...document.querySelectorAll('button,summary')].some((node) => node.textContent.trim() === needle && !node.disabled), {}, text); await page.evaluate((needle) => [...document.querySelectorAll('button,summary')].find((node) => node.textContent.trim() === needle && !node.disabled).click(), text); }
async function local() { return page.evaluate(async () => {
  const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); });
  const tx = db.transaction(['bookmarks', 'meta']), books = tx.objectStore('bookmarks').getAll(), meta = tx.objectStore('meta').getAll();
  const result = await new Promise((resolve) => { tx.oncomplete = () => resolve({ books: books.result, meta: meta.result }); }); db.close(); return result;
}); }
async function makePrivate(id) { await page.evaluate(async (itemId) => {
  const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); });
  const tx = db.transaction('bookmarks', 'readwrite'), store = tx.objectStore('bookmarks'), req = store.get(itemId);
  req.onsuccess = () => { const row = req.result; store.put({ ...row, privacy: { localOnly: true, aiBlocked: false }, localRevision: row.localRevision + 1 }); };
  await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close();
}, id); }
async function connect() { await setReactInput(page, 'input[type=password]', harness.publisher); await click('测试连接（不上传）'); await waitText('连接通过'); }
try {
  // Keep the browser's native fetch here: a JS replacement hides receiver errors.
  const nativePage = await browser.newPage();
  await nativePage.evaluateOnNewDocument(() => { chrome.permissions.request = async () => true; chrome.permissions.contains = async () => true; });
  await nativePage.setRequestInterception(true);
  nativePage.on('request', async (request) => {
    if (new URL(request.url()).origin !== 'https://mirror.test') { await request.continue(); return; }
    if (request.method() === 'OPTIONS') { await request.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE' } }); return; }
    const result = await harness.request(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() });
    await request.respond({ status: result.status, headers: { ...result.headers, 'Access-Control-Allow-Origin': '*' }, body: result.body });
  });
  await nativePage.goto(`chrome-extension://${attempt.extId}/workspace.html#cloud`);
  await nativePage.waitForSelector('input[type=password]');
  await setReactInput(nativePage, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test');
  await setReactInput(nativePage, 'input[type=password]', harness.publisher);
  await nativePage.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '测试连接（不上传）').click());
  await nativePage.waitForFunction(() => [...document.querySelectorAll('[role=status]')].some((node) => node.textContent.trim()), { timeout: 10000 });
  check('浏览器原生 fetch 可正常握手，不发生 Illegal invocation', await nativePage.evaluate(() => document.body.innerText.includes('连接通过')));
  await nativePage.close();
  await page.goto(`chrome-extension://${attempt.extId}/workspace.html#cloud`); await waitText('测试连接（不上传）');
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('bookmarks', 'readwrite'), now = new Date().toISOString();
    for (let index = 0; index < 120; index++) tx.objectStore('bookmarks').put({ id: crypto.randomUUID(), originalUrl: `https://example.com/${index}`, canonicalUrl: `https://example.com/${index}`, title: `记录${index}`,
      sourceDescription: '', note: '不能上传的人工备注', selectedText: '', aiPurpose: '', categoryId: null, categoryKey: 'uncategorized', tagIds: [], inboxUnread: true, unreadFlag: 1, pinned: false, lastOpenedAt: null,
      privacy: { localOnly: false, aiBlocked: false }, lockedFields: [], sources: [], revision: 1, localRevision: 1, changeVersion: null, lifeState: 'active', deletedAt: null, createdAt: now, updatedAt: now });
    await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close();
  });
  await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test'); await connect();
  await page.evaluate(() => { const summary = [...document.querySelectorAll('summary')].find((node) => node.textContent === '待看与旧版镜像（高级）'); if (summary) summary.parentElement.open = true; }); await click('准备发布预览'); await waitText('预览已准备');
  let data = await local(); const originalId = data.meta.find((row) => row.key === 'cloud-publication:data').value.id;
  check('发布快照在本机保存 120 条，准备预览不上传记录', data.meta.some((row) => row.key === 'cloud-publication:state') && harness.db.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').get().n === 0);
  await click('查看完整发送内容（分页）');
  check('完整发送预览分页，不一次渲染所有记录', (await page.$eval('pre.code', (node) => JSON.parse(node.textContent))).length === 50);
  await click('确认上传并发布镜像'); await waitText('synthetic lost response');
  data = await local();
  check('分片成功但丢响应时快照保留、旧发布指针不切换', data.meta.find((row) => row.key === 'cloud-publication:state').value.state === 'paused' && harness.db.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').get().n === 2 && harness.db.prepare('SELECT active_generation FROM mirror_library').get().active_generation === null);
  const countBeforeReload = report.requests.length; await page.reload(); await waitText('本机保存了一份发布快照');
  check('刷新后恢复快照，凭据清空且不自动发网络请求', report.requests.length === countBeforeReload && await page.$eval('input[type=password]', (node) => node.value === ''));
  await connect(); const beforeResume = report.requests.length;
  await click('继续未完成上传'); await waitText('镜像已发布');
  check('续传只补服务器未收到的第三片', report.requests.slice(beforeResume).filter((request) => request.path.includes('/chunks/')).map((request) => request.path.split('/').at(-1)).join(',') === '2');
  data = await local();
  check('发布确认持久化，凭据及备注不进入快照', data.meta.find((row) => row.key === 'cloud-publication:state').value.state === 'published' && !JSON.stringify(data.meta).includes(harness.publisher) && !JSON.stringify(data.meta).includes('不能上传'));
  const initialChunks = report.requests.filter((request) => request.path.includes('/chunks/')).length;
  await click('核对该快照发布状态'); await waitText('镜像已发布');
  check('已发布结果可以核对，不重新上传或推进版本', report.requests.filter((request) => request.path.includes('/chunks/')).length === initialChunks && harness.db.prepare('SELECT revision FROM mirror_library').get().revision === 1);
  await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://other.test');
  check('换地址清除旧凭据，快照仍绑定原地址且无自动请求', await page.$eval('input[type=password]', (node) => node.value === '') && report.requests.every((request) => request.path.startsWith('/v1/')));
  await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test'); await connect();
  const firstPrivate = (await local()).books[0].id; await makePrivate(firstPrivate);
  await page.evaluate(() => { const summary = [...document.querySelectorAll('summary')].find((node) => node.textContent === '待看与旧版镜像（高级）'); if (summary) summary.parentElement.open = true; }); await click('准备发布预览'); await waitText('预览已准备'); data = await local();
  const snapshot = data.meta.find((row) => row.key === 'cloud-publication:data').value;
  const secondPrivate = snapshot.plan.parts[1].records[0].id; privacyTarget = secondPrivate;
  await click('确认上传并发布镜像'); await waitText('待上传记录已修改');
  check('上传期间变为本地专用的待发记录被逐片拦截', !JSON.stringify(harness.db.prepare('SELECT body FROM mirror_chunks WHERE generation_id=?').all(snapshot.id)).includes(secondPrivate) && harness.db.prepare('SELECT active_generation FROM mirror_library').get().active_generation === originalId);
  await click('取消未发布上传'); await waitText('原已发布镜像保留');
  check('取消未发布上传实际清掉暂存，已发布镜像保留', harness.db.prepare('SELECT COUNT(*) AS n FROM mirror_generations WHERE id=?').get(snapshot.id).n === 0 && harness.db.prepare('SELECT active_generation FROM mirror_library').get().active_generation === originalId);
  await page.evaluate(() => { const summary = [...document.querySelectorAll('summary')].find((node) => node.textContent === '待看与旧版镜像（高级）'); if (summary) summary.parentElement.open = true; }); await click('准备发布预览'); await waitText('预览已准备'); await click('确认上传并发布镜像'); await waitText('镜像已发布');
  const bodies = JSON.stringify(harness.db.prepare('SELECT body FROM mirror_chunks').all());
  check('重新发布后云端实际排除两条本地专用记录，并删除旧版本', !bodies.includes(firstPrivate) && !bodies.includes(secondPrivate) && harness.db.prepare('SELECT COUNT(*) AS n FROM mirror_generations').get().n === 1);
  await click('清空云端镜像'); await waitText('云端镜像与暂存上传已清空');
  check('清空云端同步作废本机快照，但本机收藏不受影响', harness.db.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').get().n === 0 && (await local()).books.length === 120 && !(await local()).meta.some((row) => row.key.startsWith('cloud-publication:')));
  check('没有页面脚本异常', report.errors.length === 0);
  await page.screenshot({ path: path.join(directory, 'cloud.png'), fullPage: true });
} catch (error) { report.failure = String(error); console.log(await page.$$eval('[role=status]', (nodes) => nodes.map((node) => node.textContent))); await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined); throw error; }
finally { fs.mkdirSync(path.join(ROOT, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.verify/reports/cloud-publication.json'), JSON.stringify(report, null, 2)); await browser.close(); harness.close(); }
