import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';
import { createMirrorHarness } from './lib/mirror-test-harness.mjs';
const directory = path.join(ROOT, '.verify/v02'); fs.mkdirSync(directory, { recursive: true });
const report = { generatedAt: new Date().toISOString(), steps: [], errors: [] };
const check = (name, valid) => { assert.ok(valid, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const harness = await createMirrorHarness(ROOT, directory);
const attempt = await launchBestEffort(BROWSERS.find((row) => row.name === 'Chrome') ?? BROWSERS[0], prepareProfile(directory, 'v02'));
const browser = attempt.browser, page = await browser.newPage();
page.on('pageerror', (error) => report.errors.push(String(error)));
const base = `chrome-extension://${attempt.extId}`;
async function click(text, target = page) {
  await target.waitForFunction((needle) => [...document.querySelectorAll('button,summary')].some((node) => node.textContent.trim() === needle && !node.disabled), {}, text);
  await target.evaluate((needle) => [...document.querySelectorAll('button,summary')].find((node) => node.textContent.trim() === needle && !node.disabled).click(), text);
}
const waitText = (text, target = page) => target.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 20000 }, text);
const route = async (value) => { await page.evaluate((next) => { window.location.hash = next; }, value); await page.waitForFunction((next) => window.location.hash === `#${next}`, {}, value); };
async function dump(target = page) { return target.evaluate(async () => { const db = await new Promise((resolve, reject) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const names = [...db.objectStoreNames], tx = db.transaction(names), requests = names.map((name) => tx.objectStore(name).getAll());
  const result = await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(Object.fromEntries(names.map((name, index) => [name, requests[index].result]))); tx.onerror = () => reject(tx.error); }); db.close(); return result; }); }
try {
  await page.goto(`${base}/workspace.html`); await waitText('把好东西');
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction(['bookmarks', 'categories', 'readingItems'], 'readwrite'), now = new Date().toISOString();
    const publicId = crypto.randomUUID(), privateId = crypto.randomUUID();
    for (const [id, name] of [[publicId, '公开分类'], [privateId, '私人分类']]) tx.objectStore('categories').put({ id, name, parentId: null, description: '', revision: 1, createdAt: now, updatedAt: now });
    for (let index = 0; index < 65; index++) {
      const categoryId = index === 1 ? privateId : index < 5 ? publicId : null;
      tx.objectStore('bookmarks').put({ id: crypto.randomUUID(), originalUrl: `https://example.com/book${index}`, canonicalUrl: `https://example.com/book${index}`, title: index === 1 ? '仅本机的资料' : `示例收藏 ${String(index).padStart(2, '0')}`,
        sourceDescription: '本地保存的说明', note: '不默认发送的备注', selectedText: '不默认发送的摘录', aiPurpose: '', categoryId, categoryKey: categoryId ?? 'uncategorized', tagIds: [], inboxUnread: true, pinned: index === 0, lastOpenedAt: null,
        privacy: { localOnly: index === 1, aiBlocked: index === 2 }, lockedFields: [], sources: [], revision: 1, localRevision: 1, changeVersion: null, lifeState: 'active', unreadFlag: 1, createdAt: now, updatedAt: now, deletedAt: null, sortOrder: index * 1024 });
    }
    tx.objectStore('readingItems').put({ id: crypto.randomUUID(), originalUrl: 'https://example.com/reading', canonicalUrl: 'https://example.com/reading', title: '待读资料', note: '本机待看备注', status: 'pending', addedAt: now, completedAt: null, relatedBookmarkId: null, sources: [], revision: 1, localRevision: 1, changeVersion: null });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
  });
  await page.reload(); await waitText('65');
  const popup = await browser.newPage(); await popup.setViewport({ width: 370, height: 590 }); popup.on('pageerror', (error) => report.errors.push(String(error)));
  await popup.goto(`${base}/popup.html`); await popup.waitForSelector('input[placeholder="https://"]');
  await setReactInput(popup, 'input[placeholder="https://"]', 'https://example.com/unsaved');
  await click('快速访问', popup); await waitText('匹配 65 条', popup);
  check('快速访问保留本机私密记录且一页只显示 20 条', await popup.$$eval('.quick-link', (rows) => rows.length) === 20);
  await click('下一页', popup); check('快速访问分页可切换', await popup.$eval('.quick-tabs:last-child', (node) => node.textContent.includes('2 / 4')));
  await setReactInput(popup, 'section input', '仅本机'); await waitText('匹配 1 条', popup);
  check('快速访问搜索在本地生效', await popup.$$eval('.quick-link', (rows) => rows.length) === 1);
  await popup.evaluate(() => { window.opened = []; chrome.tabs.create = async (details) => { window.opened.push(details.url); return { id: 123 }; }; });
  await popup.click('.quick-link'); await popup.waitForFunction(() => window.opened.length === 1);
  check('快速访问直接打开网址并记入最近打开', (await popup.evaluate(() => window.opened[0])) === 'https://example.com/book1' && (await dump(popup)).bookmarks.some((row) => row.lastOpenedAt));
  await click('收藏当前页', popup); check('切换页签保留未保存表单', await popup.$eval('input[placeholder="https://"]', (node) => node.value) === 'https://example.com/unsaved');
  await click('快速访问', popup); await popup.reload(); await waitText('匹配 65 条', popup);
  check('插件记住上次快速访问页签', await popup.$('section[aria-label="快速访问收藏"]') !== null);
  await popup.screenshot({ path: path.join(directory, 'quick-access.png') });
  await popup.close(); await page.bringToFront(); await page.setViewport({ width: 1400, height: 1000 });

  await page.exposeFunction('localMirrorRequest', (url, init) => harness.request(url, init));
  await page.evaluate(() => {
    chrome.permissions.request = async () => true;
    const nativeFetch = window.fetch.bind(window); window.aiRequests = []; window.aiWait = false;
    window.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith('https://mirror.test/')) { const value = await window.localMirrorRequest(url, { method: init.method, headers: init.headers, body: init.body }); return new Response(value.body, { status: value.status, headers: value.headers }); }
      if (url.startsWith('https://api.deepseek.com/')) {
        const payload = JSON.parse(init.body); window.aiRequests.push(payload);
        if (window.aiLate) return new Promise((resolve) => { window.releaseLate = () => resolve(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'SHIYE_OK' } }] }))); });
        if (window.aiWait) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Abort', 'AbortError')), { once: true }));
        const instruction = payload.messages[0].content;
        let content;
        if (instruction.includes('SHIYE_OK')) content = 'SHIYE_OK';
        else if (instruction.includes('{"ok":true}')) content = '{"ok":true}';
        else { const material = JSON.parse(payload.messages[1].content);
          content = material.kind === 'ask' ? '依据本地材料 [1]，这里是测试回答。' : JSON.stringify({ protocolVersion: 2, batchId: material.batchId, part: 1, results: material.items.map((row) => ({ n: row.n, domain: new URL(row.url).hostname, titleEcho: row.title, patch: { aiPurpose: '本地资料检索参考' }, reason: '按已给资料', status: 'ok' })) }); }
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
      }
      return nativeFetch(input, init);
    };
  });
  await route('aiconfig'); await waitText('测试文本连接');
  await setReactInput(page, 'input[type=password]', 'synthetic-api-key');
  await click('测试文本连接'); await waitText('文本测试通过');
  await click('测试整理输出'); await waitText('整理 JSON 测试通过');
  await click('开启内置 AI'); await waitText('关闭内置 AI');
  check('内置 AI 合成测试没有携带收藏数据', await page.evaluate(() => window.aiRequests.length === 2 && window.aiRequests.every((request) => !JSON.stringify(request).includes('示例收藏'))));
  await setReactInput(page, 'input[list=ai-models]', 'changed-model');
  check('改变模型使测试与开启状态失效', await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '开启内置 AI')?.disabled));
  await page.evaluate(() => { window.aiLate = true; });
  await click('测试文本连接'); await page.waitForFunction(() => Boolean(window.releaseLate));
  await setReactInput(page, 'input[list=ai-models]', 'final-model');
  await page.evaluate(() => { window.aiLate = false; window.releaseLate(); });
  await waitText('请求已取消或超时');
  check('配置改变后迟到测试不能启用新配置', await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '开启内置 AI')?.disabled));
  await click('测试文本连接'); await waitText('文本测试通过'); await click('测试整理输出'); await waitText('整理 JSON 测试通过'); await click('开启内置 AI');
  await route('ask'); await waitText('生成提问包');
  await setReactInput(page, 'textarea', '概括这些收藏'); await click('选择资料'); await click('全选匹配集'); await click('完成选择');
  await click('生成提问包'); await waitText('确认发送提问材料'); await click('确认发送提问材料'); await page.waitForFunction(() => document.querySelector('.ai-answer')?.textContent.includes('这里是测试回答')); await page.$eval('.ai-answer', (node) => node.scrollIntoView());
  check('内置问答显示回答和资料编号，默认排除隐私与备注', await page.evaluate(() => {
    const material = JSON.parse(window.aiRequests.at(-1).messages[1].content); return material.items.length === 63 && !JSON.stringify(material).includes('仅本机的资料') && material.items.every((row) => row.note === '' && row.selectedText === '');
  }));
  const beforeCancel = await page.evaluate(() => { window.aiWait = true; return window.aiRequests.length; });
  await click('确认发送提问材料'); await page.waitForFunction((count) => window.aiRequests.length === count + 1, {}, beforeCancel);
  await click('取消 AI 请求'); await waitText('请求已取消或超时');
  check('用户取消后请求退出忙碌状态且不自动重试', await page.evaluate(() => window.aiRequests.length) === beforeCancel + 1);
  await page.evaluate(() => { window.aiWait = false; });
  const beforeGuard = await page.evaluate(() => window.aiRequests.length);
  await page.evaluate(async () => { const db = await new Promise((resolve) => { const req = indexedDB.open('shiye'); req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('bookmarks', 'readwrite'), store = tx.objectStore('bookmarks'), req = store.getAll(); req.onsuccess = () => { const row = req.result.find((row) => row.title === '示例收藏 00'); store.put({ ...row, privacy: { localOnly: true, aiBlocked: false }, localRevision: row.localRevision + 1 }); }; await new Promise((resolve) => { tx.oncomplete = resolve; }); db.close(); });
  await click('确认发送提问材料'); await waitText('隐私已变化');
  check('发送前重新核对隐私，旧材料没有发出网络请求', await page.evaluate(() => window.aiRequests.length) === beforeGuard);

  await route('organize'); await waitText('生成材料包 →'); await click('生成材料包 →'); await waitText('确认发送整理材料');
  await click('确认发送整理材料'); await waitText('回复已收到'); await click('校验并预览 →'); await waitText('逐条确认修改');
  await click('应用勾选项'); await waitText('已应用 20 条');
  check('整理回复经过校验预览后才写入', (await dump()).bookmarks.filter((row) => row.aiPurpose === '本地资料检索参考').length === 20);
  await click('撤销本次应用'); await waitText('已撤销 20 条修改');
  check('内置整理复用受版本保护的撤销', (await dump()).bookmarks.every((row) => !row.aiPurpose));

  await route('cloud'); await waitText('测试连接（不上传）');
  await setReactInput(page, 'input[placeholder="https://shiye.example.com"]', 'https://mirror.test');
  await setReactInput(page, 'input[type=password]', harness.publisher); await click('测试连接（不上传）'); await waitText('连接通过');
  check('后端测试连接没有发布收藏', harness.db.prepare('SELECT COUNT(*) AS n FROM mirror_chunks').get().n === 0);
  await click('准备发布预览'); await waitText('预览已准备');
  await click('确认上传并发布镜像'); await waitText('镜像已发布');
  const bodies = JSON.stringify(harness.db.prepare('SELECT body FROM mirror_chunks').all());
  check('镜像发布只包含白名单，排除本机专用与备注、Key', !/仅本机的资料|示例收藏 00|私人分类|不默认发送|synthetic-api-key|synthetic_publisher/.test(bodies));
  check('凭据没有进入主库或普通配置存储', !JSON.stringify(await dump()).includes('synthetic-api-key') && !JSON.stringify(await dump()).includes(harness.publisher));
  await page.screenshot({ path: path.join(directory, 'cloud.png') });
  const mobile = await browser.newPage(); await mobile.setViewport({ width: 375, height: 812 });
  mobile.on('pageerror', (error) => report.errors.push(String(error)));
  await mobile.setRequestInterception(true);
  mobile.on('request', async (request) => { try { if (request.url().startsWith('https://mirror.test/')) { const value = await harness.request(request.url(), { method: request.method(), headers: request.headers(), ...(request.postData() ? { body: request.postData() } : {}) }); await request.respond({ status: value.status, headers: value.headers, body: value.body }); } else await request.abort(); } catch { await request.abort().catch(() => undefined); } });
  await mobile.goto('https://mirror.test/'); await waitText('需要登录', mobile); await mobile.type('#token', harness.reader); await mobile.click('#login button'); await waitText('匹配 63 条', mobile);
  check('手机只读页面登录、分片读取和分页可用', await mobile.$$eval('.link', (rows) => rows.length) === 50);
  await mobile.type('#query', '示例收藏 64'); await waitText('匹配 1 条', mobile);
  check('手机搜索和小屏布局正常', await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await mobile.screenshot({ path: path.join(directory, 'mobile.png') }); await mobile.click('#logout'); await waitText('已退出', mobile);
  check('手机退出后清除显示内容和只读 cookie', await mobile.$$eval('.link', (rows) => rows.length) === 0 && !(await mobile.cookies()).some((cookie) => cookie.name === '__Host-shiye_reader'));
  await mobile.close(); await page.bringToFront();
  await route('aiconfig'); await waitText('清除 Key'); await page.reload(); await page.waitForSelector('input[type=password]');
  check('刷新工作台后 Key 清除且内置 AI 关闭', await page.$eval('input[type=password]', (node) => node.value === '') && await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '开启内置 AI')?.disabled));
  check('整轮没有页面脚本异常', report.errors.length === 0);
} catch (error) { report.failure = String(error); report.alerts = await page.$$eval('.alert', (nodes) => nodes.map((node) => node.textContent)); report.aiCount = await page.evaluate(() => window.aiRequests?.length); console.log(JSON.stringify({ alerts: report.alerts, aiCount: report.aiCount, answer: await page.$eval('.ai-answer', (node) => node.textContent).catch(() => null), lastSystem: await page.evaluate(() => window.aiRequests?.at(-1)?.messages[0].content) })); await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => undefined); throw error; }
finally { fs.mkdirSync(path.join(ROOT, '.verify/reports'), { recursive: true }); fs.writeFileSync(path.join(ROOT, '.verify/reports/v02.json'), JSON.stringify(report, null, 2)); await browser.close(); harness.close(); }
