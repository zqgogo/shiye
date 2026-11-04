import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BROWSERS, ROOT, launchBestEffort, prepareProfile, setReactInput } from './lib/launch-extension.mjs';

const report = { generatedAt: new Date().toISOString(), steps: [], errors: [], externalRequests: [] };
const check = (name, condition) => { assert.ok(condition, name); report.steps.push({ name, ok: true }); console.log(`PASS ${name}`); };
const temp = path.join(ROOT, '.verify', 'import-workbench');
fs.mkdirSync(temp, { recursive: true });
const file = path.join(temp, 'large.html');
fs.writeFileSync(file, `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>收藏夹栏</H3><DL>${Array.from({ length: 60 }, (_, index) =>
  `<DT><H3>目录${index}</H3><DL>${[0, 1].map((item) => `<DT><A HREF="https://example.com/${index}/${item}">样本 ${index}-${item}</A>`).join('')}</DL>`).join('')}</DL></DL>`);

const target = BROWSERS.find((browser) => browser.name === 'Chrome') ?? BROWSERS[0];
if (!target) throw new Error('没有测试浏览器。');
const attempt = await launchBestEffort(target, prepareProfile(temp, 'workbench'));
const browser = attempt.browser;
const page = await browser.newPage();
page.on('pageerror', (error) => report.errors.push(String(error)));
page.on('request', (request) => {
  if (/^https?:/.test(request.url())) report.externalRequests.push(request.url());
});
await page.setViewport({ width: 1400, height: 1000 });
const base = `chrome-extension://${attempt.extId}/workspace.html`;

async function click(text) {
  await page.waitForFunction((needle) => [...document.querySelectorAll('button,summary')].some((node) => node.textContent.trim() === needle), {}, text);
  const found = await page.evaluate((needle) => {
    const node = [...document.querySelectorAll('button,summary')].find((entry) => entry.textContent.trim() === needle);
    if (!node || node.disabled) return false;
    node.click(); return true;
  }, text);
  assert.ok(found, `可点击：${text}`);
}
async function waitText(text) {
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout: 20000 }, text);
}
async function choose(label, value) {
  await page.evaluate((name, next) => {
    const field = [...document.querySelectorAll('label')].find((node) => node.querySelector('span')?.textContent === name);
    const select = field?.querySelector('select');
    if (!select) throw new Error(`找不到选择器 ${name}`);
    select.value = next; select.dispatchEvent(new Event('change', { bubbles: true }));
  }, label, value);
}
async function readDb() {
  return page.evaluate(async () => {
    const request = indexedDB.open('shiye');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const names = ['bookmarks', 'categories', 'meta'];
    const tx = db.transaction(names);
    const requests = names.map((name) => tx.objectStore(name).getAll());
    const result = await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(Object.fromEntries(names.map((name, index) => [name, requests[index].result]))); tx.onerror = () => reject(tx.error); });
    db.close(); return result;
  });
}

try {
  await page.goto(`${base}#capture:file`);
  await page.waitForSelector('input[type=file]');
  await (await page.$('input[type=file]')).uploadFile(file);
  await waitText('120 总条数');
  check('书签明细分页只渲染 50 条', await page.$$eval('.import-records tbody tr', (nodes) => nodes.length) === 50);
  check('目录分页只渲染 50 个节点', await page.$$eval('.import-folder', (nodes) => nodes.length) === 50);
  await page.screenshot({ path: path.join(temp, 'preview.png') });
  await click('保存为待整理导入');
  await waitText('已保存在待整理导入');
  let stored = await readDb();
  check('独立暂存不写正式收藏及分类', stored.bookmarks.length === 0 && stored.categories.length === 0 && stored.meta.some((row) => row.key.startsWith('import-draft:')));
  await page.reload();
  await waitText('待整理导入（1 份）');
  await click('待整理导入（1 份）');
  await click('继续整理');
  await waitText('120 总条数');
  check('刷新后可继续独立暂存', await page.$$eval('.import-records tbody tr', (nodes) => nodes.length) === 50);

  await click('AI 帮我整理（自配服务 / 手动材料包）');
  await click('生成可检查的分批材料');
  const material = JSON.parse(await page.$eval('textarea[aria-label="导入 AI 材料"]', (node) => node.value));
  check('AI 完整分批且不带完整网址或凭据', material.parts.length === 6 && material.parts.every((part) => part.records.length === 20 && part.records.every((row) => row.site === 'example.com' && !row.originalUrl && !row.apiKey)));
  await page.evaluate(() => {
    chrome.permissions.request = async () => true;
    window.syntheticCalls = 0;
    let failedOnce = false;
    window.fetch = async (_url, init) => {
      window.syntheticCalls++;
      const material = JSON.parse(JSON.parse(init.body).messages[1].content);
      if (material.part === 2 && !failedOnce) { failedOnce = true; return new Response('{}', { status: 503 }); }
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ planId: material.planId, draftId: material.draftId, revision: material.revision,
        moves: material.records.map((row) => ({ sourceKey: row.sourceKey, path: row.path })) }) } }] }));
    };
  });
  await click('配置当前页面的 AI 服务');
  await setReactInput(page, 'input[type=password]', 'synthetic-key');
  await click('确认发送 / 重试剩余分片');
  await waitText('完成 5 / 6 份');
  await click('确认发送 / 重试剩余分片');
  await waitText('完成 6 / 6 份');
  check('AI 失败重试只请求缺失分片', await page.evaluate(() => window.syntheticCalls) === 7);
  await click('生成可检查的分批材料');
  await click('校验与预览建议');
  await waitText('回复属于其他版本');
  check('重新生成材料后拒绝旧 AI 回复', !await page.$('.notice strong').then(async (node) => node ? (await node.evaluate((entry) => entry.textContent)).includes('建议调整 120 条') : false));
  await click('确认发送 / 重试剩余分片');
  await page.waitForFunction(() => window.syntheticCalls === 13);
  await waitText('完成 6 / 6 份');
  await click('校验与预览建议');
  await waitText('建议调整 120 条');
  await click('采用到当前草稿');
  check('模拟 AI 完整覆盖且必须预览后采用', (await readDb()).bookmarks.length === 0);
  await choose('导入方式', 'direct');
  await click('预览加入收藏库 120 条');
  await waitText('将新建 61 个分类');
  await click('确认写入');
  await waitText('已新增 120 条');
  stored = await readDb();
  check('原目录入库创建父子结构', stored.bookmarks.length === 120 && stored.categories.length === 61 && stored.categories.filter((row) => row.parentId).length === 60);
  check('全部加入后清除该暂存', !stored.meta.some((row) => row.key.startsWith('import-draft:')));
  check('密钥没有进入本地存储', !JSON.stringify(stored).includes('synthetic-key'));

  const bookmark = stored.bookmarks[0];
  const targetCategory = stored.categories.find((row) => row.parentId && row.id !== bookmark.categoryId);
  const targetPath = `收藏夹栏 / ${targetCategory.name}`;
  await page.evaluate((item, targetPath) => {
    const node = [...document.querySelectorAll('.category-drop')].find((entry) => entry.title === targetPath);
    if (!node) throw new Error('缺少目标分类');
    const transfer = new DataTransfer();
    transfer.setData('application/x-shiye-organization', JSON.stringify([{ kind: 'bookmark', id: item.id, revision: item.localRevision }]));
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  }, bookmark, targetPath);
  await waitText('撤销上次移动 / 排序');
  stored = await readDb();
  check('拖入分类持久保存且保留原来源', stored.bookmarks.find((row) => row.id === bookmark.id).categoryId === targetCategory.id && JSON.stringify(stored.bookmarks.find((row) => row.id === bookmark.id).sources) === JSON.stringify(bookmark.sources));
  await click('撤销上次移动 / 排序');
  await page.waitForFunction(() => !document.body.innerText.includes('撤销上次移动 / 排序'));
  check('撤销移动回到原分类', (await readDb()).bookmarks.find((row) => row.id === bookmark.id).categoryId === bookmark.categoryId);
  const tenThousand = path.join(temp, 'ten-thousand.html');
  fs.writeFileSync(tenThousand, `<DL><DT><H3>一万条</H3><DL>${Array.from({ length: 10000 }, (_, index) =>
    `<DT><A HREF="https://large.example/${index}">大批量 ${index}</A>`).join('')}</DL></DL>`);
  await (await page.$('input[type=file]')).uploadFile(tenThousand);
  await waitText('10000 总条数');
  check('一万条全部解析，明细仍只渲染一页', await page.$$eval('.import-records tbody tr', (nodes) => nodes.length) === 50);
  await choose('导入方式', 'stage');
  await click('保存为待整理导入');
  await waitText('已保存在待整理导入');
  stored = await readDb();
  check('一万条独立暂存完整且不影响原库', stored.bookmarks.length === 120 && stored.meta.some((row) => row.key.startsWith('import-draft:') && row.value.rows.length === 10000));
  await page.reload();
  await waitText('待整理导入（1 份）');
  await click('待整理导入（1 份）');
  await click('继续整理');
  await waitText('10000 总条数');
  check('一万条暂存刷新后继续且分页有效', await page.$$eval('.import-records tbody tr', (nodes) => nodes.length) === 50);
  await choose('导入方式', 'direct');
  await click('预览加入收藏库 10000 条');
  await waitText('将新建 2 个分类');
  await click('确认写入');
  await page.waitForFunction(() => document.body.innerText.includes('已新增 10000 条'), { timeout: 120000 });
  stored = await readDb();
  check('一万条正式入库完整，原库保留且暂存清除', stored.bookmarks.length === 10120 && !stored.meta.some((row) => row.key.startsWith('import-draft:')));
  check('浏览器没有页面异常或外部数据请求', report.errors.length === 0 && report.externalRequests.length === 0);
} catch (error) {
  report.failure = String(error);
  await page.screenshot({ path: path.join(temp, 'failure.png') }).catch(() => undefined);
  throw error;
} finally {
  fs.mkdirSync(path.join(ROOT, '.verify', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.verify', 'reports', 'import-workbench.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
