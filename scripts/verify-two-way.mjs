import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
import { createMirrorHarness } from './lib/mirror-test-harness.mjs';
const directory = path.join(ROOT, '.verify/two-way'); fs.mkdirSync(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), steps: [], errors: [] };
const check = (name, condition) => { assert.ok(condition, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const harness = await createMirrorHarness(ROOT, directory), browsers = [];
const waitText = (page, text) => page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 30000, polling: 100 }, text);
async function click(page, text) { await page.bringToFront(); await page.waitForFunction((needle) => [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === needle && !node.disabled), { polling: 100 }, text); await page.evaluate((needle) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === needle && !node.disabled).click(), text); }
async function createDevice(name, url, title) {
  const attempt = await launchBestEffort(BROWSERS.find((row) => row.name === 'Chrome') ?? BROWSERS[0], prepareProfile(directory, name)); browsers.push(attempt.browser);
  const page = await attempt.browser.newPage(); await page.setViewport({ width: 1400, height: 1000 }); page.on('pageerror', (error) => report.errors.push(String(error)));
  await page.exposeFunction('sharedRequest', (address, init) => harness.request(address, init));
  await page.evaluateOnNewDocument(() => { chrome.permissions.request = async () => true; chrome.permissions.contains = async () => true; window.confirm = () => true; window.fetch = async function (address, init = {}) { if (this !== window) throw new Error('Illegal fetch receiver'); const result = await window.sharedRequest(String(address), { method: init.method, headers: init.headers, body: init.body }); return new Response(result.body, { status: result.status, headers: result.headers }); }; });
  await page.goto(`chrome-extension://${attempt.extId}/workspace.html#cloud`); await page.waitForSelector('input[type=password]');
  await page.evaluate(async ({ url, title }) => { const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); }); const tx = db.transaction(['bookmarks', 'categories'], 'readwrite'), now = new Date().toISOString(); const categoryId = crypto.randomUUID(); tx.objectStore('categories').put({ id: categoryId, name: '技术', parentId: null, description: '', sortOrder: 1024, revision: 1, createdAt: now, updatedAt: now });
    tx.objectStore('bookmarks').put({ id: crypto.randomUUID(), originalUrl: url, canonicalUrl: url, title, sourceDescription: '', note: `${title}笔记`, selectedText: '', aiPurpose: '', categoryId, categoryKey: categoryId, tagIds: [], inboxUnread: true, unreadFlag: 1, pinned: false, sortOrder: 1024, lastOpenedAt: null, privacy: { localOnly: false, aiBlocked: false }, lockedFields: [], sources: [], revision: 1, localRevision: 1, changeVersion: null, lifeState: 'active', deletedAt: null, createdAt: now, updatedAt: now }); await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close(); }, { url, title });
  await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test'); await setReactInput(page, 'input[type=password]', harness.publisher); await click(page, '测试连接（不上传）'); await waitText(page, '连接通过'); return page;
}
async function dump(page) { return page.evaluate(async () => { const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); }); const tx = db.transaction(['bookmarks', 'categories', 'meta']); const books = tx.objectStore('bookmarks').getAll(), categories = tx.objectStore('categories').getAll(), meta = tx.objectStore('meta').getAll(); const result = await new Promise((resolve) => { tx.oncomplete = () => resolve({ books: books.result, categories: categories.result, meta: meta.result }); }); db.close(); return result; }); }
async function edit(page, url, patch) { await page.evaluate(async ({ url, patch }) => { const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); }); const tx = db.transaction('bookmarks', 'readwrite'), store = tx.objectStore('bookmarks'), req = store.getAll(); req.onsuccess = () => { const row = req.result.find((book) => book.canonicalUrl === url); store.put({ ...row, ...patch, revision: row.revision + 1, localRevision: row.localRevision + 1, updatedAt: new Date().toISOString() }); }; await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close(); }, { url, patch }); }
async function sync(page) { await click(page, '检查两台电脑同步'); await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '确认同步收藏').disabled, { polling: 100 }); await click(page, '确认同步收藏'); await waitText(page, '两台电脑同步完成'); }
try {
  const home = await createDevice('home', 'https://example.com/home', '家里收藏'); const work = await createDevice('work', 'https://example.com/work', '工作收藏');
  await click(home, '检查两台电脑同步'); await waitText(home, '首次连接将合并'); check('首次检查只读预览，不发送收藏或改写云库', harness.db.prepare('SELECT COUNT(*) AS n FROM shared_entities').get().n === 0);
  await click(home, '确认同步收藏'); await waitText(home, '两台电脑同步完成'); await sync(work); await sync(home);
  check('两个独立扩展库首次合并，各自原有收藏都保留', (await dump(home)).books.filter((row) => !row.deletedAt).length === 2 && (await dump(work)).books.filter((row) => !row.deletedAt).length === 2);
  check('不同本机分类编号按路径归并，不重复创建分类', (await dump(home)).categories.length === 1 && (await dump(work)).categories.length === 1);
  const mobile = await browsers[0].newPage(); await mobile.setViewport({ width: 390, height: 844 }); mobile.on('pageerror', (error) => report.errors.push(String(error)));
  await mobile.setRequestInterception(true); mobile.on('request', async (request) => { try { if (!request.url().startsWith('https://mirror.test/')) { await request.abort(); return; } const value = await harness.request(request.url(), { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) }); await request.respond({ status: value.status, headers: value.headers, body: value.body }); } catch { await request.abort().catch(() => undefined); } });
  await mobile.goto('https://mirror.test/'); await waitText(mobile, '需要登录'); await mobile.type('#token', harness.reader); await mobile.click('#login button'); await waitText(mobile, '匹配 2 条');
  check('手机直接读取双机共享收藏，未发布旧镜像也可查看且不暴露备注', await mobile.$$eval('#results .link', (nodes) => nodes.length) === 2 && !await mobile.evaluate(() => document.body.innerText.includes('家里收藏笔记')));
  await mobile.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true }); await mobile.close();
  await edit(work, 'https://example.com/home', { note: '工作电脑补充的备注', pinned: true }); await sync(work); await sync(home);
  check('轮流使用可同步备注和置顶，本机数据真正落库', (await dump(home)).books.some((row) => row.canonicalUrl.endsWith('/home') && row.note === '工作电脑补充的备注' && row.pinned));
  await edit(home, 'https://example.com/home', { deletedAt: new Date().toISOString(), lifeState: 'deleted' }); await sync(home); await sync(work);
  check('一台删除后另一台进入回收站，未按缺失整库覆盖', (await dump(work)).books.some((row) => row.canonicalUrl.endsWith('/home') && row.deletedAt) && (await dump(work)).books.some((row) => row.canonicalUrl.endsWith('/work') && !row.deletedAt));
  await edit(home, 'https://example.com/work', { title: '家里修改' }); await edit(work, 'https://example.com/work', { title: '工作离线修改' }); await sync(home); await click(work, '检查两台电脑同步'); await waitText(work, '待选择 1 项');
  check('离线双边修改被列为冲突，确认按钮禁用且本机未被覆盖', await work.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '确认同步收藏').disabled) && (await dump(work)).books.some((row) => row.title === '工作离线修改'));
  await click(work, '保留云端'); await click(work, '确认同步收藏'); await waitText(work, '两台电脑同步完成');
  check('明确选择云端后才合并冲突，后续检查不重复发送', (await dump(work)).books.some((row) => row.title === '家里修改')); const revision = harness.db.prepare('SELECT revision FROM shared_state').get().revision; await sync(work); check('无变化同步不推进云端版本', harness.db.prepare('SELECT revision FROM shared_state').get().revision === revision);
  await edit(home, 'https://example.com/work', { privacy: { localOnly: true, aiBlocked: false } }); await sync(home); await sync(work);
  check('已共享转本地专用，远端撤回而当前设备保留', (await dump(home)).books.some((row) => row.canonicalUrl.endsWith('/work') && !row.deletedAt && row.privacy.localOnly) && (await dump(work)).books.filter((row) => !row.deletedAt).length === 0);
  const state = JSON.stringify((await dump(home)).meta.filter((row) => row.key.startsWith('cloud-sync:'))); check('同步基线不包含应用凭据或 AI Key', !state.includes(harness.publisher) && !state.includes('apiKey'));
  await home.screenshot({ path: path.join(directory, 'home.png'), fullPage: true }); await work.screenshot({ path: path.join(directory, 'work.png'), fullPage: true });
  await work.bringToFront(); await work.reload(); await work.waitForSelector('input[type=password]'); check('刷新清除凭据但同步基线持久保留', await work.$eval('input[type=password]', (node) => node.value === '') && (await dump(work)).meta.some((row) => row.key.startsWith('cloud-sync:')));
  check('两个浏览器完整流程无页面异常', report.errors.length === 0);
} catch (error) { report.failure = String(error); throw error; }
finally { fs.mkdirSync(path.join(ROOT, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.verify/reports/two-way.json'), JSON.stringify(report, null, 2)); await Promise.all(browsers.map((browser) => browser.close())); harness.close(); }
