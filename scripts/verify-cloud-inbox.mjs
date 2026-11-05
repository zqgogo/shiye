import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
import { createMirrorHarness } from './lib/mirror-test-harness.mjs';
const directory = path.join(ROOT, '.verify/cloud-inbox'); fs.mkdirSync(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), steps: [], errors: [], requests: [] };
const check = (name, condition) => { assert.ok(condition, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const harness = await createMirrorHarness(ROOT, directory);
const attempt = await launchBestEffort(BROWSERS.find((row) => row.name === 'Chrome') ?? BROWSERS[0], prepareProfile(directory, 'cloud-inbox'));
const browser = attempt.browser, master = await browser.newPage();
master.on('pageerror', (error) => report.errors.push(String(error)));
let loseReceipt = true, loseSubmit = true;
await master.exposeFunction('inboxRequest', async (url, init) => { report.requests.push({ url, method: init.method }); const result = await harness.request(url, init); if (loseReceipt && url.endsWith('/receipt') && result.status === 200) { loseReceipt = false; throw new Error('synthetic lost receipt'); } return result; });
await master.evaluateOnNewDocument(() => {
  chrome.permissions.request = async () => true; chrome.permissions.contains = async () => true; window.confirm = () => true;
  window.fetch = async function (url, init = {}) { if (this !== window) throw new Error('Illegal fetch receiver'); const result = await window.inboxRequest(String(url), { method: init.method, headers: init.headers, body: init.body }); return new Response(result.body, { status: result.status, headers: result.headers }); };
});
const waitText = (page, text) => page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 20000, polling: 100 }, text);
async function click(page, text) { await page.bringToFront(); await page.waitForFunction((needle) => [...document.querySelectorAll('button')].some((node) => node.textContent.trim() === needle && !node.disabled), { polling: 100 }, text); await page.evaluate((needle) => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === needle && !node.disabled).click(), text); }
async function snapshot() { return master.evaluate(async () => { const db = await new Promise((resolve) => { const r = indexedDB.open('shiye'); r.onsuccess = () => resolve(r.result); }); const tx = db.transaction(['bookmarks', 'readingItems']); const books = tx.objectStore('bookmarks').getAll(), reading = tx.objectStore('readingItems').getAll(); const result = await new Promise((resolve) => { tx.oncomplete = () => resolve({ books: books.result, reading: reading.result }); }); db.close(); return result; }); }
async function mobilePage(context = browser) {
  const page = await context.newPage(); await page.setViewport({ width: 390, height: 844 }); page.on('pageerror', (error) => report.errors.push(String(error))); page.on('dialog', (dialog) => dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', async (request) => { try {
    if (!request.url().startsWith('https://mirror.test/')) { await request.abort(); return; }
    const result = await harness.request(request.url(), { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) });
    if (loseSubmit && request.method() === 'POST' && new URL(request.url()).pathname === '/v1/inbox' && result.status === 200) { loseSubmit = false; await request.abort(); return; }
    await request.respond({ status: result.status, headers: result.headers, body: result.body });
  } catch { await request.abort().catch(() => undefined); } });
  await page.goto('https://mirror.test/'); await waitText(page, '需要登录'); await page.type('#token', harness.submitter); await page.click('#login button'); await page.waitForSelector('#library:not([hidden])'); return page;
}
try {
  await master.goto(`chrome-extension://${attempt.extId}/workspace.html#cloud`); await master.waitForSelector('input[type=password]');
  await master.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('shiye'); r.onsuccess = () => resolve(r.result); }); const tx = db.transaction(['categories', 'tags', 'bookmarks'], 'readwrite'), now = new Date().toISOString();
    tx.objectStore('categories').put({ id: 'tech', name: '技术', parentId: null, description: '', revision: 1, createdAt: now, updatedAt: now });
    tx.objectStore('categories').put({ id: 'web', name: '网页', parentId: 'tech', description: '', revision: 1, createdAt: now, updatedAt: now });
    tx.objectStore('tags').put({ id: 'reference', name: '参考', createdAt: now, updatedAt: now });
    tx.objectStore('bookmarks').put({ id: 'existing', originalUrl: 'https://example.com/existing', canonicalUrl: 'https://example.com/existing', title: '原收藏', sourceDescription: '', note: '', selectedText: '', aiPurpose: '', categoryId: 'web', categoryKey: 'web', tagIds: ['reference'], inboxUnread: true, unreadFlag: 1, pinned: false, lastOpenedAt: null, privacy: { localOnly: false, aiBlocked: false }, lockedFields: [], sources: [], revision: 1, localRevision: 1, changeVersion: null, lifeState: 'active', deletedAt: null, createdAt: now, updatedAt: now });
    await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close();
  });
  await setReactInput(master, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test'); await setReactInput(master, 'input[type=password]', harness.publisher); await click(master, '测试连接（不上传）'); await waitText(master, '连接通过');
  check('左侧顶部保留四个常用入口，更多入口默认收起且功能保留', await master.evaluate(() => document.querySelector('aside .navgroup').querySelectorAll(':scope > button').length === 4 && !document.querySelector('aside .nav-extra').open && document.querySelector('aside .nav-extra').textContent.includes('回收站')));
  await click(master, '准备发布预览'); await waitText(master, '预览已准备'); await click(master, '确认上传并发布镜像'); await waitText(master, '镜像已发布');
  const mobile = await mobilePage(); await mobile.click('#show-add');
  check('手机使用独立提交凭据登录，分类展示完整层级和标签', await mobile.$eval('#capture-category', (node) => [...node.options].some((option) => option.text === '技术 / 网页')) && await mobile.$eval('#capture-tags', (node) => node.options[0]?.text === '参考'));
  await mobile.type('#capture-url', 'https://example.com/from-phone'); await mobile.type('#capture-title', '手机新增收藏'); await mobile.select('#capture-category', 'web'); await mobile.select('#capture-tags', 'reference'); await mobile.type('#capture-note', '随提交传送的笔记'); await mobile.type('#capture-description', '来源介绍'); await mobile.click('#capture-pinned'); await mobile.click('#save-local'); await waitText(mobile, '已保存到本机，尚未发送');
  check('普通收藏格式先保存在本机，不自动上传', harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 0 && await mobile.$$eval('.temporary', (nodes) => nodes.length) === 1);
  await mobile.reload(); await mobile.waitForSelector('#library:not([hidden])'); await mobile.click('#show-local');
  check('刷新保留临时记录且不自动发送，应用凭据没有进入本机存储', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 1 && harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 0 && !await mobile.evaluate((token) => JSON.stringify(localStorage).includes(token), harness.submitter));
  await click(mobile, '发送给总机'); await waitText(mobile, '发送未确认'); await click(mobile, '发送给总机'); await waitText(mobile, '发送已确认');
  check('提交丢响应后重试同一编号，服务器只保留一条', harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 1);
  await mobile.click('#show-add'); await mobile.select('#capture-destination', 'reading'); await mobile.type('#capture-url', 'https://example.com/read-later'); await mobile.type('#capture-title', '路上待看'); await mobile.type('#capture-note', '待看备注'); await mobile.click('#save-local'); await click(mobile, '发送给总机'); await waitText(mobile, '发送已确认');
  check('可直接提交待看，记录留在本机临时列表', harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 2 && await mobile.$$eval('.temporary', (nodes) => nodes.length) === 2);
  const context = await browser.createBrowserContext(), other = await mobilePage(context); await other.click('#show-local');
  check('另一设备的临时列表隔离，不显示本设备的添加记录', await other.$$eval('.temporary', (nodes) => nodes.length) === 0); await context.close();
  await click(master, '检查云端收件箱'); await waitText(master, '本页 2 条待接收'); await click(master, '接收选中（2）'); await waitText(master, 'synthetic lost receipt');
  let data = await snapshot(); check('总机先事务落库再确认，丢回执不丢记录，分类标签备注均保留', data.books.length === 2 && data.reading.length === 1 && data.books.some((row) => row.title === '手机新增收藏' && row.categoryId === 'web' && row.tagIds.includes('reference') && row.note === '随提交传送的笔记' && row.sourceDescription === '来源介绍' && row.pinned));
  await click(master, '接收选中（1）'); await waitText(master, '已接收 1 条');
  data = await snapshot(); check('重试接收不重复创建，确认后云端清除提交正文', data.books.length === 2 && data.reading.length === 1 && harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox WHERE payload IS NOT NULL').get().n === 0);
  await mobile.bringToFront(); await mobile.click('#refresh-local'); await waitText(mobile, '总机已接收，等待发布');
  check('总机接收后手机显示等待发布，正式镜像尚未被改写', harness.db.prepare('SELECT revision FROM mirror_library').get().revision === 1 && await mobile.$$eval('.temporary', (nodes) => nodes.length) === 2);
  await click(master, '准备发布预览'); await waitText(master, '预览已准备'); await click(master, '确认上传并发布镜像'); await waitText(master, '镜像已发布');
  await mobile.bringToFront(); await mobile.click('#refresh-local'); await waitText(mobile, '这里还没有临时记录'); await mobile.select('#local-filter', 'published'); await waitText(mobile, '已出现在正式发布库');
  check('总机重新发布后按回执编号核对，临时副本标记已发布而非自动删除', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 2);
  await mobile.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
  await mobile.click('#clear-published'); await waitText(mobile, '这里还没有临时记录');
  check('手动清理只删除本机临时副本，正式收藏与待看保持', (await snapshot()).books.length === 2 && (await snapshot()).reading.length === 1 && harness.db.prepare('SELECT active_generation FROM mirror_library').get().active_generation !== null);
  await mobile.evaluate(() => { const prefix = Object.keys(localStorage).find((key) => key.startsWith('shiye:outbox:')); window.savedPrefix = prefix; });
  // Use current cloud identity to create enough synthetic local-only drafts for pagination.
  const info = JSON.parse((await harness.request('https://mirror.test/v1/info', { headers: { Authorization: `Bearer ${harness.publisher}` } })).body);
  await mobile.evaluate((identity) => { const prefix = `shiye:outbox:${JSON.stringify([identity.serverId, identity.libraryId, identity.epoch])}:`; for (let index = 0; index < 101; index++) { const id = crypto.randomUUID(); localStorage.setItem(prefix + id, JSON.stringify({ id, createdAt: new Date().toISOString(), status: 'queued', receipt: null, payload: { destination: 'bookmark', url: `https://example.com/draft${index}`, title: `临时${index}`, categoryPath: '', tagNames: [], sourceDescription: '', note: '' } })); } }, info);
  await mobile.select('#local-filter', 'active'); await waitText(mobile, '101 条');
  check('临时列表按 50 条分页，大量添加不会一次渲染全部', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 50);
  await mobile.click('#local-next'); check('临时列表可翻页且适配手机宽度', await mobile.$eval('#local-page', (node) => node.textContent.startsWith('2 / 3')) && await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await master.setViewport({ width: 1400, height: 1000 }); await master.screenshot({ path: path.join(directory, 'desktop.png'), fullPage: true });
  await mobile.bringToFront(); await mobile.click('#logout'); await waitText(mobile, '已退出'); check('退出清除当前私有内容，临时记录仅在此浏览器保留', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 0 && await mobile.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('shiye:outbox:')).length) === 101);
  check('完整流程没有页面脚本异常', report.errors.length === 0);
} catch (error) { report.failure = String(error); report.local = await Promise.race([snapshot(), new Promise((resolve) => setTimeout(() => resolve('snapshot timeout'), 2000))]); report.cloud = harness.db.prepare('SELECT id,status FROM capture_inbox').all(); console.log(JSON.stringify({ requests: report.requests, local: report.local, cloud: report.cloud })); console.log(await master.$$eval('[role=status]', (nodes) => nodes.map((node) => node.textContent))); await master.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined); throw error; }
finally { fs.mkdirSync(path.join(ROOT, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.verify/reports/cloud-inbox.json'), JSON.stringify(report, null, 2)); await browser.close(); harness.close(); }
