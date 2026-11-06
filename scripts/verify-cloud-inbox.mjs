import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
import { createMirrorHarness } from './lib/mirror-test-harness.mjs';
const directory = path.join(ROOT, '.verify/cloud-inbox'); fs.mkdirSync(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), steps: [], errors: [], requests: [] };
const check = (name, condition) => { assert.ok(condition, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const harness = await createMirrorHarness(ROOT, directory);
const attempt = await launchBestEffort(BROWSERS.find((row) => row.name === 'Edge') ?? BROWSERS[0], prepareProfile(directory, 'cloud-inbox'));
const browser = attempt.browser, master = await browser.newPage();
master.on('pageerror', (error) => report.errors.push(String(error)));
let loseReceipt = true, loseSubmit = true, failMobileNetwork = false, holdSubmit = null; const mobileRequests = [];
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
    mobileRequests.push(new URL(request.url()).pathname);
    if (!request.url().startsWith('https://mirror.test/')) { await request.abort(); return; }
    if (failMobileNetwork && new URL(request.url()).pathname === '/v1/info') { await request.abort(); return; }
    if (holdSubmit && request.method()==='POST' && new URL(request.url()).pathname==='/v1/inbox') { const hold=holdSubmit;holdSubmit=null;await hold(); }
    const result = await harness.request(request.url(), { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) });
    if (loseSubmit && request.method() === 'POST' && new URL(request.url()).pathname === '/v1/inbox' && result.status === 200) { loseSubmit = false; await request.abort(); return; }
    await request.respond({ status: result.status, headers: result.headers, body: result.body });
  } catch { await request.abort().catch(() => undefined); } });
  await page.goto('https://mirror.test/'); await waitText(page, '需要登录'); await page.type('#token', harness.submitter); await page.click('#remember-login'); await page.click('#login button'); await page.waitForSelector('#library:not([hidden])'); return page;
}
try {
  await master.goto(`chrome-extension://${attempt.extId}/workspace.html#cloud`); await master.waitForSelector('input[type=password]');
  await master.evaluate(async () => {
    const db = await new Promise((resolve) => { const r = indexedDB.open('shiye'); r.onsuccess = () => resolve(r.result); }); const tx = db.transaction(['categories', 'tags', 'bookmarks'], 'readwrite'), now = new Date().toISOString();
    tx.objectStore('categories').put({ id: 'tech', name: '技术', parentId: null, description: '', revision: 1, createdAt: now, updatedAt: now });
    tx.objectStore('categories').put({ id: 'web', name: '网页', parentId: 'tech', description: '', revision: 1, createdAt: now, updatedAt: now });
    for (let i=0;i<25;i++) tx.objectStore('categories').put({id:`extra-${i}`,name:`测试分类 ${i}`,parentId:null,description:'',revision:1,createdAt:now,updatedAt:now});
    tx.objectStore('tags').put({ id: 'reference', name: '参考', createdAt: now, updatedAt: now });
    tx.objectStore('bookmarks').put({ id: 'existing', originalUrl: 'https://example.com/existing', canonicalUrl: 'https://example.com/existing', title: '原收藏', sourceDescription: '', note: '', selectedText: '', aiPurpose: '', categoryId: 'web', categoryKey: 'web', tagIds: ['reference'], inboxUnread: true, unreadFlag: 1, pinned: false, lastOpenedAt: null, privacy: { localOnly: false, aiBlocked: false }, lockedFields: [], sources: [], revision: 1, localRevision: 1, changeVersion: null, lifeState: 'active', deletedAt: null, createdAt: now, updatedAt: now });
    const original=tx.objectStore('bookmarks').get('existing'); original.onsuccess=()=>{for(let i=0;i<25;i++){const url=`https://sample.example/${i}`; tx.objectStore('bookmarks').put({...original.result,id:`sample-${i}`,title:`样例 ${i}`,originalUrl:url,canonicalUrl:url,categoryId:`extra-${i}`,categoryKey:`extra-${i}`});}};
    await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close();
  });
  await setReactInput(master, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test'); await setReactInput(master, 'input[type=password]', harness.publisher); await click(master, '测试连接（不上传）'); await waitText(master, '连接通过');
  check('左侧顶部保留四个常用入口，更多入口默认收起且功能保留', await master.evaluate(() => document.querySelector('aside .navgroup').querySelectorAll(':scope > button').length === 4 && !document.querySelector('aside .nav-extra').open && document.querySelector('aside .nav-extra').textContent.includes('回收站')));
  await click(master, '准备发布预览'); await waitText(master, '预览已准备'); await click(master, '确认上传并发布镜像'); await waitText(master, '镜像已发布');
  const mobile = await mobilePage();
  const cookies = await mobile.cookies(); const session = cookies.find(row=>row.name==='__Host-shiye_reader');
  check('手机主动保持登录使用 HttpOnly Secure 的 30 天 Cookie', session?.httpOnly && session?.secure && session.expires > Date.now()/1000 + 29*86400);
  failMobileNetwork = true; await mobile.reload(); await waitText(mobile, '未清除登录');
  check('网络错误不显示重新登录，提供保留会话重试', await mobile.$eval('#login',n=>n.hidden) && await mobile.$eval('#retry-load',n=>!n.hidden));
  failMobileNetwork = false; await mobile.click('#retry-load'); await mobile.waitForSelector('#library:not([hidden])');
  check('网络恢复后不用重填凭据即可重新读取', await mobile.$eval('#token',n=>n.value===''));
  const downloads = () => mobileRequests.filter(path=>path==='/v1/mirror'||path==='/v2/public').length;
  const beforeCachedReload = downloads();
  await mobile.reload(); await mobile.waitForSelector('#library:not([hidden])');
  check('两小时内刷新复用缓存，不重新下载镜像分片', downloads()===beforeCachedReload && await mobile.$eval('#cache-status',n=>n.textContent.includes('本机缓存')));
  await mobile.click('#reload'); await waitText(mobile,'刚同步最新');
  check('同步最新按钮绕过缓存立即下载',downloads()>beforeCachedReload);
  const beforeExpired = downloads();
  await mobile.evaluate(async()=>{ const req=indexedDB.open('shiye-mobile-cache',1);const db=await new Promise(r=>req.onsuccess=()=>r(req.result));const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots'),q=store.get('current');q.onsuccess=()=>store.put({...q.result,fetchedAt:Date.now()-3*3600000},'current');await new Promise(r=>tx.oncomplete=r);db.close(); });
  await mobile.reload(); await mobile.waitForSelector('#library:not([hidden])');
  check('缓存超过两小时自动重新拉取',downloads()>beforeExpired && await mobile.$eval('#cache-status',n=>n.textContent.includes('刚同步最新')));

  await mobile.evaluate(()=>{for(let i=0;i<500;i++)categoryNodes.set(`stress-${i}`,{id:`stress-${i}`,name:`压力分类 ${i}`,parentId:null});render();});
  check('500多个子分类也只渲染三条预览',await mobile.$$eval('#folder-rows .folder-row',n=>n.length)===3 && await mobile.$eval('#all-folders',n=>n.textContent.includes('526')));
  await mobile.type('#query','原收藏'); check('搜索时隐藏目录优先展示匹配收藏',await mobile.$eval('#folder-preview',n=>n.hidden) && await mobile.$$eval('#results .link',n=>n.length)===1);
  await mobile.evaluate(()=>{for(let i=0;i<500;i++)categoryNodes.delete(`stress-${i}`);document.getElementById('query').value='';render();});
  await mobile.screenshot({path:path.join(directory,'mobile-explorer.png'),fullPage:false});
  await mobile.setViewport({width:320,height:740});check('320像素窄屏目录及收藏无横向溢出',await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await mobile.setViewport({width:390,height:844});
  check('大量子分类只显示三条预览，记录不被长目录挤走', await mobile.$$eval('#folder-rows .folder-row',n=>n.length)===3 && await mobile.$eval('#all-folders',n=>n.textContent.includes('26')));
  await mobile.click('#toggle-folders'); await mobile.reload(); await mobile.waitForSelector('#library:not([hidden])');
  check('目录收起选择在刷新后保留',await mobile.$eval('#folder-rows',n=>n.hidden));
  await mobile.click('#toggle-folders');
  await mobile.evaluate(()=>window.scrollTo(0,250)); const returnScroll=await mobile.evaluate(()=>window.scrollY);
  await mobile.click('#all-folders'); await mobile.waitForSelector('#directory-panel:not([hidden])');
  check('查看全部进入独立目录页，每页最多20个分类',await mobile.$$eval('#directory-rows .folder-row',n=>n.length)===20 && await mobile.$eval('#browse',n=>n.hidden));
  await mobile.click('#directory-next');check('独立目录支持分页',await mobile.$$eval('#directory-rows .folder-row',n=>n.length)===6);
  await mobile.click('#directory-back');check('返回收藏保留列表位置',Math.abs(await mobile.evaluate(()=>window.scrollY)-returnScroll)<2);
  await mobile.click('#choose-category'); await mobile.type('#directory-search','技术 / 网页');
  check('目录搜索支持完整层级路径',await mobile.$$eval('#directory-rows .folder-row',n=>n.length)===1);
  await mobile.click('[data-folder-id="web"]'); await mobile.click('#directory-use');
  check('选择分类后应用到收藏页',await mobile.$eval('#category',n=>n.value==='web') && await mobile.$$eval('#results .link',n=>n.length)===1);
  await mobile.click('#choose-category'); await mobile.click('#directory-root'); await mobile.type('#directory-search','技术');await mobile.click('[data-folder-id="tech"]');
  check('逐级进入保留紧凑层级路径',await mobile.$eval('#directory-path',n=>n.textContent.includes('技术')) && await mobile.$$eval('#directory-rows .folder-row',n=>n.length)===1);
  await mobile.screenshot({path:path.join(directory,'category-picker.png'),fullPage:false});
  await mobile.click('#directory-use'); await mobile.click('.more-filters summary');
  await mobile.click('#include-descendants');
  check('父分类可区分直属与包含子分类', await mobile.$$eval('#results .link',n=>n.length)===0);
  await mobile.click('#reset-filters'); await mobile.type('#site-filter','github.com');
  check('网站筛选与分类筛选可组合使用', await mobile.$$eval('#results .link',n=>n.length)===0);
  await mobile.click('#reset-filters');
  check('一键清除筛选恢复全部收藏且手机无横向溢出', await mobile.$$eval('#results .link',n=>n.length)===26 && await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mobile.click('#show-add'); await mobile.click('#choose-capture-category'); await mobile.type('#category-search','网页'); await mobile.click('[data-category-id="web"]');
  check('新增记录使用同一层级选择器', await mobile.$eval('#capture-category',n=>n.value==='web') && await mobile.$eval('#choose-capture-category',n=>n.textContent.includes('技术 / 网页')));
  await mobile.screenshot({path:path.join(directory,'category-capture.png'),fullPage:false});
  check('手机使用独立提交凭据登录，分类展示完整层级和标签', await mobile.$eval('#capture-category', (node) => [...node.options].some((option) => option.text === '技术 / 网页')) && await mobile.$eval('#capture-tags', (node) => node.options[0]?.text === '参考'));
  await mobile.type('#capture-url', 'https://phone-submissions.personal-bookmarks.example.com/a-long-address-for-mobile-layout?from=phone'); await mobile.type('#capture-title', '手机新增收藏'); await mobile.select('#capture-category', 'web'); await mobile.select('#capture-tags', 'reference'); await mobile.type('#capture-note', '随提交传送的笔记'); await mobile.type('#capture-description', '来源介绍'); await mobile.click('#capture-pinned'); await mobile.click('#save-local'); await waitText(mobile, '已保存到本机，尚未发送');
  await mobile.evaluate(()=>document.querySelector('.view-tabs').scrollIntoView({block:'start'}));
  await mobile.screenshot({path:path.join(directory,'outbox-layout.png'),fullPage:false});
  check('本机临时页说明默认收起，发送操作突出，窄屏无横向溢出', await mobile.$eval('.local-help',n=>!n.open) && await mobile.$eval('.send-primary',n=>n.textContent==='发送给总机'&&n.getBoundingClientRect().height>=44) && await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  check('普通收藏格式先保存在本机，不自动上传', harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 0 && await mobile.$$eval('.temporary', (nodes) => nodes.length) === 1);
  await mobile.reload(); await mobile.waitForSelector('#library:not([hidden])'); await mobile.click('#show-local');
  check('刷新保留临时记录且不自动发送，应用凭据没有进入本机存储', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 1 && harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 0 && !await mobile.evaluate((token) => JSON.stringify(localStorage).includes(token), harness.submitter));
  await click(mobile, '发送给总机'); await waitText(mobile, '发送未确认'); await click(mobile, '发送给总机'); await waitText(mobile, '发送已确认');
  check('提交丢响应后重试同一编号，服务器只保留一条', harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 1);
  await mobile.click('#show-add'); await mobile.select('#capture-destination', 'reading'); await mobile.type('#capture-url', 'https://example.com/read-later'); await mobile.type('#capture-title', '路上待看'); await mobile.type('#capture-note', '待看备注'); await mobile.click('#save-local'); await click(mobile, '发送给总机'); await waitText(mobile, '发送已确认');
  check('可直接提交待看，记录留在本机临时列表', harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox').get().n === 2 && await mobile.$$eval('.temporary', (nodes) => nodes.length) === 2);
  const context = await browser.createBrowserContext(), other = await mobilePage(context); await other.click('#show-local');
  check('另一设备的临时列表隔离，不显示本设备的添加记录', await other.$$eval('.temporary', (nodes) => nodes.length) === 0); await context.close();
  await click(master, '检查云端收件箱'); await waitText(master, '本页 2 条待接收');
  await master.evaluate(()=>{const card=[...document.querySelectorAll('.cloud-inbox > .notice')].find(node=>node.textContent.includes('手机新增收藏'));card.querySelector('.inbox-editor').open=true;});
  await master.select('.inbox-editor[open] select[aria-label="接收分类"]','tech');
  await master.evaluate(()=>{const input=document.querySelector('.inbox-editor[open] input[maxlength="300"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'电脑确认收藏');input.dispatchEvent(new Event('input',{bubbles:true}));const note=document.querySelector('.inbox-editor[open] textarea[maxlength="10000"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(note,'接收时备注');note.dispatchEvent(new Event('input',{bubbles:true}));});
  await click(master, '接收选中（2）'); await waitText(master, 'synthetic lost receipt');
  let data = await snapshot(); check('总机先事务落库再确认，丢回执不丢记录，分类标签备注均保留', data.books.length === 27 && data.reading.length === 1 && data.books.some((row) => row.title === '电脑确认收藏' && row.categoryId === 'tech' && row.tagIds.includes('reference') && row.note === '接收时备注' && row.sourceDescription === '来源介绍' && row.pinned));
  await click(master, '接收选中（1）'); await waitText(master, '已接收 1 条');
  data = await snapshot(); check('重试接收不重复创建，确认后云端清除提交正文', data.books.length === 27 && data.reading.length === 1 && harness.db.prepare('SELECT COUNT(*) AS n FROM capture_inbox WHERE payload IS NOT NULL').get().n === 0);
  await mobile.bringToFront(); await mobile.click('#refresh-local'); await waitText(mobile, '等待发布');
  check('总机接收后手机显示等待发布，正式镜像尚未被改写', harness.db.prepare('SELECT revision FROM mirror_library').get().revision === 1 && await mobile.$$eval('.temporary', (nodes) => nodes.length) === 2);
  await click(master, '准备发布预览'); await waitText(master, '预览已准备'); await click(master, '确认上传并发布镜像'); await waitText(master, '镜像已发布');
  await mobile.bringToFront(); await mobile.click('#refresh-local'); await waitText(mobile, '这里还没有临时记录'); await mobile.select('#local-filter', 'published'); await mobile.waitForSelector('.temporary .status-published');
  check('总机重新发布后按回执编号核对，临时副本标记已发布而非自动删除', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 2);
  await mobile.screenshot({ path: path.join(directory, 'mobile.png'), fullPage: true });
  await mobile.click('.local-maintenance > summary'); await mobile.click('#clear-published'); await waitText(mobile, '这里还没有临时记录');
  check('手动清理只删除本机临时副本，正式收藏与待看保持', (await snapshot()).books.length === 27 && (await snapshot()).reading.length === 1 && harness.db.prepare('SELECT active_generation FROM mirror_library').get().active_generation !== null);
  await mobile.evaluate(() => { const prefix = Object.keys(localStorage).find((key) => key.startsWith('shiye:outbox:')); window.savedPrefix = prefix; });
  // Use current cloud identity to create enough synthetic local-only drafts for pagination.
  const info = JSON.parse((await harness.request('https://mirror.test/v1/info', { headers: { Authorization: `Bearer ${harness.publisher}` } })).body);
  await mobile.evaluate((identity) => { const prefix = `shiye:outbox:${JSON.stringify([identity.serverId, identity.libraryId, identity.epoch])}:`; for (let index = 0; index < 101; index++) { const id = crypto.randomUUID(); localStorage.setItem(prefix + id, JSON.stringify({ id, createdAt: new Date().toISOString(), status: 'queued', receipt: null, payload: { destination: 'bookmark', url: `https://example.com/draft${index}`, title: `临时${index}`, categoryId:null,categoryPath: '', tagIds:[],tagNames: [], sourceDescription: '', note: '',pinned:false,unread:true,aiBlocked:false } })); } }, info);
  await mobile.select('#local-filter', 'active'); await waitText(mobile, '101 条');
  check('临时列表按 50 条分页，大量添加不会一次渲染全部', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 50);
  await mobile.click('#local-next'); check('临时列表可翻页且适配手机宽度', await mobile.$eval('#local-page', (node) => node.textContent.startsWith('2 / 3')) && await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.click('#local-batch > summary');await mobile.click('#local-select-page');await mobile.click('#local-next');await mobile.click('#local-select-page');
  check('批量勾选可跨页保留',await mobile.$eval('#local-send-selected',node=>node.textContent==='发送选中（51）'));
  loseSubmit=true; await mobile.click('#local-send-selected');await waitText(mobile,'发送未确认');
  check('批量丢响应停止后续发送并保留选中和待发送副本',await mobile.$eval('#local-send-selected',node=>!node.disabled && node.textContent==='发送选中（51）'));
  await mobile.click('#local-send-selected');await waitText(mobile,'已确认发送 51 / 51');
  check('批量重试相同编号不重复，已发送记录仍在本机',harness.db.prepare("SELECT COUNT(*) AS n FROM capture_inbox WHERE payload IS NOT NULL").get().n===51 && await mobile.evaluate(()=>localEntries().length===101 && localEntries().filter(row=>row.status==='queued').length===50));
  let resumeSubmit, markStarted;const started=new Promise(resolve=>markStarted=resolve);holdSubmit=()=>{markStarted();return new Promise(resolve=>resumeSubmit=resolve);};
  await mobile.click('#local-send-all');await started;await mobile.click('#local-stop');resumeSubmit();await waitText(mobile,'已确认发送 1 / 50');
  check('停止批量发送只完成当前一条，剩余记录可继续发送',await mobile.evaluate(()=>localEntries().filter(row=>row.status==='queued').length===49));
  await mobile.click('#local-send-all');await waitText(mobile,'已确认发送 49 / 49');
  check('全部待发送跨分页发送且不重复发送已确认记录',harness.db.prepare("SELECT COUNT(*) AS n FROM capture_inbox WHERE payload IS NOT NULL").get().n===101 && await mobile.$eval('#local-send-all',node=>node.disabled) && await mobile.evaluate(()=>localEntries().length===101));
  await master.setViewport({ width: 1400, height: 1000 }); await master.screenshot({ path: path.join(directory, 'desktop.png'), fullPage: true });
  await mobile.bringToFront(); await mobile.click('#logout'); await waitText(mobile, '已退出'); check('退出清除当前私有内容，临时记录仅在此浏览器保留', await mobile.$$eval('.temporary', (nodes) => nodes.length) === 0 && await mobile.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('shiye:outbox:')).length) === 101);
  const clearedCache=await mobile.evaluate(async()=>{const req=indexedDB.open('shiye-mobile-cache',1);const db=await new Promise(r=>req.onsuccess=()=>r(req.result));const q=db.transaction('snapshots').objectStore('snapshots').get('current');const item=await new Promise(r=>q.onsuccess=()=>r(q.result));db.close();return !item;});
  check('退出登录清除镜像缓存，临时提交副本保持独立',clearedCache);
  check('完整流程没有页面脚本异常', report.errors.length === 0);
} catch (error) { report.failure = String(error); report.local = await Promise.race([snapshot(), new Promise((resolve) => setTimeout(() => resolve('snapshot timeout'), 2000))]); report.cloud = harness.db.prepare('SELECT id,status FROM capture_inbox').all(); console.log(JSON.stringify({ requests: report.requests, local: report.local, cloud: report.cloud })); console.log(await master.$$eval('[role=status]', (nodes) => nodes.map((node) => node.textContent))); await master.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined); throw error; }
finally { fs.mkdirSync(path.join(ROOT, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.verify/reports/cloud-inbox.json'), JSON.stringify(report, null, 2)); await browser.close(); harness.close(); }
