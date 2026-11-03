/**
 * P3 浏览器验证：扩展收集、粘贴与书签导入。
 *
 * 对应 docs/ROADMAP.md：
 * - P3.1 收集入口：popup 的待看/收藏保存与分类搜索、首页多链接粘贴、文件导入独立入口；
 * - P3.2 解析预览：按目标去重，逐行保留新增/重复/无效及原因，统计与来源；
 * - P3.3 目录映射与安全：Chrome / Edge / Firefox 脱敏书签格式、目录映射、不执行脚本、不加载外部资源；
 * - P3.4 原子提交：只写入勾选的可新增行，批次可核对；
 * - P3.5 收集失败与限制：受限页面手填、单批条数、文件大小、粘贴不联网抓标题、导入不自动完成待看。
 *
 * 右键菜单与「读取所选文字」依赖浏览器原生 UI / 用户手势，自动化无法触发，如实记为未验证。
 * 所有断言回读 IndexedDB 主库或页面上真实渲染的文本，不信任 toast 文案。
 *
 * 每个阶段单独 try/catch：某一阶段抛错只记一条 FAIL，后续阶段继续跑，
 * 避免一次运行只暴露一个失败点。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSERS,
  DIST,
  ROOT,
  findServiceWorker,
  launchBestEffort,
  prepareProfile,
  readImportBatches,
  readMainLibrary,
  setReactInput,
  sleep,
  waitForSelectorGone,
  waitForSelectorReady,
  waitForText,
  writeReport,
} from './lib/launch-extension.mjs';

const VERIFY_DIR = path.join(ROOT, '.verify');
const OUT_DIR = path.join(VERIFY_DIR, 'reports');
const TMP_DIR = path.join(VERIFY_DIR, 'tmp');
const FIXTURES = {
  chrome: path.join(ROOT, 'fixtures', 'bookmarks-chrome.html'),
  edge: path.join(ROOT, 'fixtures', 'bookmarks-edge.html'),
  firefox: path.join(ROOT, 'fixtures', 'bookmarks-firefox.html'),
  hostile: path.join(ROOT, 'fixtures', 'bookmarks-hostile.html'),
  malformed: path.join(ROOT, 'fixtures', 'bookmarks-malformed.html'),
  deep: path.join(ROOT, 'fixtures', 'bookmarks-deep.html'),
};

const CATEGORY_NAME = 'P3 验证分类';
const URL_EXISTING = 'https://example.com/p3-new-b';
const URL_READING_KEEP = 'https://example.net/firefox/notes';
const URL_SW_BOOKMARK = 'https://example.com/p3-sw-message';
const URL_SW_READING = 'https://example.com/p3-sw-reading';
/** P3.1 弹窗样本也落在同一个分类下，统计目录映射结果时必须排除。 */
const URL_POPUP_BOOKMARK = 'https://example.com/p3-popup-bookmark';

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail: detail ?? '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
};

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 240);
}

function setReactInputAt(page, selector, index, value) {
  return page.evaluate(
    (sel, at, val) => {
      const nodes = [...document.querySelectorAll(sel)];
      const input = nodes[at];
      if (!input) throw new Error(`缺少第 ${at} 个输入框：${sel}（实际 ${nodes.length} 个）`);
      const proto =
        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    index,
    value
  );
}

async function clickIn(page, container, text) {
  const ok = await page.evaluate(
    (sel, needle) => {
      const scope = sel ? document.querySelector(sel) : document.body;
      if (!scope) return false;
      const nodes = [...scope.querySelectorAll('button, a, [role="button"]')];
      const hit =
        nodes.find((node) => (node.textContent ?? '').trim() === needle) ??
        nodes.find((node) => (node.textContent ?? '').trim().includes(needle));
      if (!hit) return false;
      hit.click();
      return true;
    },
    container,
    text
  );
  if (!ok) throw new Error(`未找到可点击元素：${container ?? 'body'} → ${text}`);
}

function goto(page, route, expectText) {
  return page
    .evaluate((next) => {
      window.location.hash = next;
    }, route)
    .then(() => (expectText ? waitForText(page, expectText, 15_000) : sleep(400)));
}

/**
 * 从扩展页面给 service worker 发消息。
 *
 * MV3 里 service worker 用 chrome.runtime.sendMessage 发给自己是收不到的
 * （Chrome 不会把消息投递给发送方所在的上下文），必须由一个扩展页面发起。
 * 这里统一捕获异常，让「通道不通」表现为一条 FAIL 而不是整轮中断。
 */
function sendRuntimeMessage(page, message) {
  return page.evaluate(async (payload) => {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }, message);
}

/** 读预览面板的统计（总条数 / 可新增 / 重复 / 无效 / 需确认）。 */
function previewStats(page) {
  return page.evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((node) => node.querySelector('.capturetable'));
    if (!panel) return null;
    const output = {};
    for (const stat of panel.querySelectorAll('.stat')) {
      const label = (stat.querySelector('span')?.textContent ?? '').trim();
      const value = Number((stat.querySelector('strong')?.textContent ?? '').trim());
      if (label) output[label] = value;
    }
    return output;
  });
}

/** 读「导入完成」面板的新增 / 跳过数。 */
function resultStats(page) {
  return page.evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((node) =>
      (node.innerText ?? '').includes('导入完成')
    );
    if (!panel) return null;
    const output = {};
    for (const stat of panel.querySelectorAll('.stat')) {
      const label = (stat.querySelector('span')?.textContent ?? '').trim();
      const value = Number((stat.querySelector('strong')?.textContent ?? '').trim());
      if (label) output[label] = value;
    }
    return output;
  });
}

/**
 * 预览表格的逐行快照：勾选状态、状态列与原因列。
 * 同页还有一张「目录与分类」映射表也用了 .capturetable，靠表头是否含「状态」把它排除掉。
 */
function previewRows(page) {
  return page.evaluate(() => {
    const table = [...document.querySelectorAll('.capturetable')].find((node) =>
      (node.querySelector('thead')?.innerText ?? '').includes('状态')
    );
    if (!table) return [];
    return [...table.querySelectorAll('tbody tr')].map((tr) => {
      const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText ?? '').replace(/\s+/g, ' ').trim());
      return {
        checked: tr.querySelector('input[type="checkbox"]')?.checked ?? false,
        disabled: tr.querySelector('input[type="checkbox"]')?.disabled ?? false,
        titleAndUrl: cells[1] ?? '',
        status: cells[2] ?? '',
        reason: cells[3] ?? '',
      };
    });
  });
}

function selectedCount(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    const match = /已选\s*(\d+)\s*条/.exec(text);
    return match ? Number(match[1]) : null;
  });
}

function toggleRowByUrl(page, urlFragment) {
  return page.evaluate((needle) => {
    const tr = [...document.querySelectorAll('.capturetable tbody tr')].find((row) =>
      (row.innerText ?? '').includes(needle)
    );
    const input = tr?.querySelector('input[type="checkbox"]');
    if (!input) return false;
    input.click();
    return true;
  }, urlFragment);
}

async function uploadFixture(page, filePath) {
  await waitForSelectorReady(page, 'input[type="file"]', 15_000);
  const input = await page.$('input[type="file"]');
  // 同一个文件再导一次时，input 的值没变化就不会触发 change，预览也不会重建。
  // 先清空 value 再上传，保证每次选择都被当成新的选择。
  await input.evaluate((node) => {
    node.value = '';
  });
  await input.uploadFile(filePath);
}

async function waitPreview(page) {
  await waitForText(page, '核对导入内容', 20_000);
  await sleep(400);
}

async function ensureCategory(page, name) {
  await goto(page, 'rules', '分类少一点');
  await clickIn(page, '.heading', '管理分类');
  await waitForSelectorReady(page, '.modal.wide', 10_000);
  await setReactInput(page, '.modal.wide input[placeholder="分类名称"]', name);
  await clickIn(page, '.modal.wide', '创建');
  await sleep(800);
  const id = await page.evaluate(
    (needle) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['categories'], 'readonly');
          const req = tx.objectStore('categories').getAll();
          tx.oncomplete = () => {
            const hit = req.result.find((row) => row.name === needle);
            resolve(hit?.id ?? null);
            db.close();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    name
  );
  await clickIn(page, '.modal.wide', '完成');
  return id;
}

/** 读「最近清理」面板里实际渲染出来的快照行，不信任任何计数文案。 */
function readPurgeSnapshots(page) {
  return page.evaluate(() => {
    // 按标题定位，不按全文：页面别处的说明里也会提到「最近清理」，
    // 用 innerText.includes 会把「最近导入」面板当成它，读到一堆批次行。
    const panels = [...document.querySelectorAll('.panel')];
    const panel = panels.find((node) =>
      [...node.querySelectorAll('h2')].some((heading) => (heading.textContent ?? '').trim() === '最近清理')
    );
    const rows = [...(panel?.querySelectorAll('article.bookmark') ?? [])].map((row) =>
      (row.innerText ?? '').replace(/\s+/g, ' ').trim()
    );
    return { count: rows.length, rows: rows.slice(0, 3) };
  });
}

async function createBookmark(page, { url, title }) {
  await clickIn(page, '.topbar', '收藏链接');
  await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
  await setReactInput(page, 'input[placeholder="https://"]', url);
  await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', title);
  await clickIn(page, '.modal', '保存到收件箱');
  await waitForSelectorGone(page, '.modal input[placeholder="https://"]', 20_000);
  await sleep(600);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const target = BROWSERS.find(
    (b) => b.name.toLowerCase() === (process.env.P0_BROWSER ?? 'chrome').toLowerCase()
  );
  if (!target) {
    throw new Error('未找到可用的 Chrome / Edge。请安装其中之一，或用 SHIYE_CHROME / SHIYE_EDGE 指定路径。');
  }

  const limitations = [
    '右键菜单（「加入拾页待看」「保存到拾页收藏」）依赖浏览器原生菜单，自动化无法点击；本轮由扩展页面向 service worker 发送 CAPTURE_LINK 消息验证同一写入路径（菜单回调调用的是同一个 service 方法），菜单本身仍需人工点一次。',
    '「读取页面所选文字」需要 activeTab 授权（由点击工具栏图标触发生成），自动化打开 popup 页面时不具备该授权；本轮只验证受限时的提示文案。',
    '导入事务中途失败的整体回滚无法在不注入故障的前提下从界面触发；本轮验证「只写勾选行」与「重复提交返回 ALREADY_APPLIED」，回滚由 Dexie 事务保证但未单独取证。',
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    task: 'P3',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    fixtures: Object.fromEntries(Object.entries(FIXTURES).map(([key, value]) => [key, path.relative(ROOT, value)])),
    counts: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-p3`);
  const attempt = await launchBestEffort(target, profileDir, limitations);
  report.browser.version = await attempt.browser.version();
  report.browser.headless = attempt.headless;
  report.browser.extensionId = attempt.extId;
  const { extId } = attempt;
  let { browser } = attempt;
  const base = `chrome-extension://${attempt.extId}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));

  const page = await browser.newPage();
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('devtools:')) {
      externalRequests.push(url);
    }
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${base}/workspace.html#home`, { waitUntil: 'domcontentloaded' });
  await waitForSelectorReady(page, '.brand-mark', 25_000);

  /** 阶段间共享的数据。 */
  const ctx = { categoryId: null };
  const phases = [];
  const phase = (label, fn) => phases.push({ label, fn });

  phase('P3.1 入口与预置数据', async () => {
    const homeEntry = await page.evaluate(() => ({
      pasteBox: Boolean(document.querySelector('textarea[aria-label="粘贴多个链接"]')),
      fileButton: [...document.querySelectorAll('button')].some((node) =>
        (node.textContent ?? '').includes('从浏览器书签导入')
      ),
      hubCard: [...document.querySelectorAll('.hubgrid .hubcard')].some((node) =>
        (node.textContent ?? '').includes('粘贴 / 导入')
      ),
    }));
    record(
      'P3.1 首页同时提供多链接粘贴与独立的书签文件入口',
      homeEntry.pasteBox && homeEntry.fileButton && homeEntry.hubCard,
      `粘贴框=${homeEntry.pasteBox}｜文件入口=${homeEntry.fileButton}｜快捷卡片=${homeEntry.hubCard}`
    );

    ctx.categoryId = await ensureCategory(page, CATEGORY_NAME);
    record('P3.3 可创建分类供目录映射使用', Boolean(ctx.categoryId), `categoryId=${ctx.categoryId}`);
    if (!ctx.categoryId) throw new Error('分类创建失败，后续映射断言无法进行');

    // 预先收藏一条，用来验证「保存到收藏库」时的跨批次去重
    await goto(page, 'home', '快速操作');
    await createBookmark(page, { url: URL_EXISTING, title: 'P3 已存在样本' });
  });

  phase('P3.1 弹窗收集', async () => {
    const popup = await browser.newPage();
    popup.on('pageerror', (error) => errors.push(`popup: ${String(error)}`));
    await popup.setViewport({ width: 420, height: 640 });
    await popup.goto(`${base}/popup.html`, { waitUntil: 'domcontentloaded' });
    await waitForText(popup, '收藏当前页面', 25_000);
    await sleep(600);

    const restrictedNotice = await popup.evaluate(
      () => document.querySelector('.popupframe .notice')?.textContent ?? ''
    );
    record(
      'P3.5 受限页面上弹窗提示手动填写合法网址',
      /手动填写合法网址/.test(restrictedNotice),
      `提示=「${restrictedNotice.trim()}」`
    );

    const selectionButton = await popup.evaluate(() =>
      [...document.querySelectorAll('button')].some((node) => (node.textContent ?? '').includes('读取页面所选文字'))
    );
    await clickIn(popup, '.popupframe', '读取页面所选文字');
    await sleep(500);
    const selectionError = await popup.evaluate(
      () => document.querySelector('.popupframe .alert')?.textContent ?? ''
    );
    record(
      'P3.5 受限页面读取所选文字给出明确拒绝',
      selectionButton && /不允许读取所选文字|读取所选文字失败/.test(selectionError),
      `错误=「${selectionError.trim()}」`
    );

    const POPUP_READING_URL = 'https://example.com/p3-popup-reading';
    await setReactInputAt(popup, '.popupframe .field input', 0, POPUP_READING_URL);
    await setReactInputAt(popup, '.popupframe .field input', 1, '弹窗待看样本');
    await clickIn(popup, '.popupframe', '仅加入待看');
    await waitForText(popup, '已保存到待看', 20_000);
    const afterReading = await page.evaluate(readMainLibrary);
    const popupReading = afterReading.readings.find((row) => row.originalUrl === POPUP_READING_URL);
    record(
      'P3.1 弹窗「仅加入待看」写入独立队列',
      popupReading?.status === 'pending',
      `status=${popupReading?.status}｜title=「${popupReading?.title}」`
    );

    const POPUP_BOOKMARK_URL = URL_POPUP_BOOKMARK;
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await waitForText(popup, '收藏当前页面', 25_000);
    await sleep(500);
    await setReactInputAt(popup, '.popupframe .field input', 0, POPUP_BOOKMARK_URL);
    await setReactInputAt(popup, '.popupframe .field input', 1, '弹窗收藏样本');
    // 分类搜索：先搜到目标分类，再从下拉里选
    await setReactInput(popup, 'input[aria-label="搜索分类"]', 'P3 验证');
    await sleep(400);
    const categoryOptions = await popup.evaluate(() =>
      [...document.querySelectorAll('.popupframe .field select option')].map((node) => node.textContent ?? '')
    );
    await popup.select('.popupframe .field select', ctx.categoryId);
    await clickIn(popup, '.popupframe', '保存收藏');
    await waitForText(popup, '已保存到收件箱', 20_000);
    await sleep(600);
    const afterPopupBookmark = await page.evaluate(readMainLibrary);
    const popupBookmark = afterPopupBookmark.bookmarks.find((row) => row.originalUrl === POPUP_BOOKMARK_URL);
    record(
      'P3.1 弹窗分类搜索能筛出目标分类并保存',
      categoryOptions.some((text) => text.includes(CATEGORY_NAME)) && categoryOptions.length < 5,
      `下拉选项=${JSON.stringify(categoryOptions)}`
    );
    record(
      'P3.1 弹窗「保存收藏」写入收件箱并带分类',
      popupBookmark?.unreadFlag === 1 && popupBookmark?.categoryId === ctx.categoryId,
      `unreadFlag=${popupBookmark?.unreadFlag}｜categoryId=${popupBookmark?.categoryId}`
    );

    await popup.reload({ waitUntil: 'domcontentloaded' });
    await waitForText(popup, '收藏当前页面', 25_000);
    await sleep(500);
    await setReactInputAt(popup, '.popupframe .field input', 0, POPUP_BOOKMARK_URL);
    await setReactInputAt(popup, '.popupframe .field input', 1, '弹窗收藏样本（重复）');
    await clickIn(popup, '.popupframe', '保存收藏');
    await sleep(1200);
    const popupDupError = await popup.evaluate(
      () => document.querySelector('.popupframe .alert')?.textContent ?? ''
    );
    const afterDupSave = await page.evaluate(readMainLibrary);
    record(
      'P3.1 弹窗重复保存同 URL 提示已收藏且不新建',
      /收藏|重复|已存在/.test(popupDupError) &&
        afterDupSave.bookmarks.filter((row) => row.originalUrl === POPUP_BOOKMARK_URL).length === 1,
      `提示=「${popupDupError.trim().slice(0, 30)}」｜同 URL 条数=${afterDupSave.bookmarks.filter((row) => row.originalUrl === POPUP_BOOKMARK_URL).length}`
    );
    await popup.close();
  });

  phase('P3.1 service worker 消息通道', async () => {
    // 先 PING：既验证通道，也把休眠的 service worker 唤醒，后面才找得到目标。
    const ping = await sendRuntimeMessage(page, { type: 'PING' });
    record(
      'P3.1 扩展页面到 service worker 的消息通道可用',
      ping?.ok === true && ping?.result?.version === manifest.version,
      `响应=${JSON.stringify(ping)}｜manifest=${manifest.version}`
    );

    const swTarget = await findServiceWorker(browser, attempt.extId);
    record(
      'P3.1 service worker 处于运行状态',
      Boolean(swTarget),
      swTarget ? swTarget.url() : '未找到 service worker 目标'
    );

    const capture = await sendRuntimeMessage(page, {
      type: 'CAPTURE_LINK',
      destination: 'library',
      url: URL_SW_BOOKMARK,
      title: 'SW 消息样本',
    });
    await sleep(800);
    const afterSw = await page.evaluate(readMainLibrary);
    const swRow = afterSw.bookmarks.find((row) => row.originalUrl === URL_SW_BOOKMARK);
    record(
      'P3.1 CAPTURE_LINK 写入收藏（与右键菜单同一路径）',
      capture?.ok === true && capture?.result?.ok === true && Boolean(swRow) && swRow?.unreadFlag === 1,
      `响应=${JSON.stringify(capture)}｜入库=${Boolean(swRow)}｜未读=${swRow?.unreadFlag}`
    );

    const captureReading = await sendRuntimeMessage(page, {
      type: 'CAPTURE_LINK',
      destination: 'reading',
      url: URL_SW_READING,
      title: 'SW 待看样本',
    });
    await sleep(800);
    const afterSwReading = await page.evaluate(readMainLibrary);
    const swReading = afterSwReading.readings.find((row) => row.originalUrl === URL_SW_READING);
    record(
      'P3.1 CAPTURE_LINK 写入待看（对应右键「加入待看」）',
      captureReading?.ok === true && swReading?.status === 'pending',
      `响应=${JSON.stringify(captureReading)}｜status=${swReading?.status}`
    );

    const bad = await sendRuntimeMessage(page, { type: 'NOT_A_MESSAGE' });
    record(
      'P3.1 未定义的消息类型被运行时校验拒绝',
      bad?.ok === false,
      `响应=${JSON.stringify(bad)}`
    );
  });

  phase('P3.2 粘贴预览', async () => {
    await goto(page, 'home', '快速操作');
    const pasteText = [
      'https://example.com/p3-new-a',
      URL_EXISTING,
      'https://example.com/p3-new-a',
      'invalid-link',
    ].join('\n');
    await setReactInput(page, 'textarea[aria-label="粘贴多个链接"]', pasteText);
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    const readingStats = await previewStats(page);
    report.counts.pasteReading = readingStats;
    record(
      'P3.2 粘贴预览按目标给出新增 / 重复 / 无效统计',
      readingStats?.['总条数'] === 4 && readingStats?.['可新增'] === 2 && readingStats?.['重复'] === 1 && readingStats?.['无效'] === 1,
      JSON.stringify(readingStats)
    );
    const pasteRows = await previewRows(page);
    record(
      'P3.2 每行保留状态与原因',
      pasteRows.some((row) => row.status === '重复' && /本次输入重复/.test(row.reason)) &&
        pasteRows.some((row) => row.status === '无效' && row.reason.length > 0) &&
        pasteRows.filter((row) => row.status === '新增').length === 2,
      pasteRows.map((row) => `${row.status}:${row.reason}`).join(' | ')
    );
    record(
      'P3.5 粘贴不联网抓标题，用域名占位',
      /example\.com\/p3-new-a/.test(pasteRows.find((row) => row.status === '新增')?.titleAndUrl ?? ''),
      `首行=「${pasteRows[0]?.titleAndUrl}」`
    );

    // 切到收藏库：已收藏的那条应变成重复，勾选要被重置
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(1200);
    const libraryStats = await previewStats(page);
    report.counts.pasteLibrary = libraryStats;
    const libraryRows = await previewRows(page);
    const switchHint = await page.evaluate(() => document.body.innerText.includes('切换目标会重新去重并重置勾选'));
    record(
      'P3.2 切换保存目标会重新去重',
      libraryStats?.['可新增'] === 1 && libraryStats?.['重复'] === 2,
      JSON.stringify(libraryStats)
    );
    record(
      'P3.2 目标切换前说明会重置勾选，且重算后只勾可新增行',
      switchHint && libraryRows.filter((row) => row.checked).length === 1,
      `说明存在=${switchHint}｜已勾选=${libraryRows.filter((row) => row.checked).length}`
    );
    record(
      'P3.2 已有收藏的行给出「已经收藏为」原因',
      libraryRows.some((row) => row.status === '重复' && /已经收藏为/.test(row.reason)),
      libraryRows.find((row) => row.status === '重复' && /已经收藏为/.test(row.reason))?.reason ?? '未找到'
    );

    // 取消预览：输入保留，不写入
    const bookmarksBeforeCancel = (await page.evaluate(readMainLibrary)).bookmarks.length;
    await clickIn(page, '.batchbar', '取消预览');
    await waitForSelectorGone(page, '.capturetable', 10_000);
    const keptText = await page.evaluate(
      () => document.querySelector('textarea[aria-label="粘贴链接"]')?.value ?? ''
    );
    const bookmarksAfterCancel = (await page.evaluate(readMainLibrary)).bookmarks.length;
    record(
      'P3.5 取消预览不写入且保留输入',
      keptText.includes('p3-new-a') && bookmarksAfterCancel === bookmarksBeforeCancel,
      `输入保留=${keptText.split('\n').length} 行｜收藏数 ${bookmarksBeforeCancel}→${bookmarksAfterCancel}`
    );
  });

  phase('P3.3/P3.4 Chrome 书签导入', async () => {
    await goto(page, 'capture:file', '选择浏览器导出的书签 HTML');
    await uploadFixture(page, FIXTURES.chrome);
    await waitPreview(page);
    // 默认目标必须是收藏库：书签本质是收藏。默认成待看会让整批书签静默进待看，
    // 而待看没有分类字段，目录映射区也不渲染，用户看到的表象就是「分类全丢了」。
    const defaultDestination = await page.$eval(
      'select[aria-label="保存目标"]',
      (node) => node.value
    );
    record(
      'P3.3 导入收藏夹默认保存到收藏库（不是待看）',
      defaultDestination === 'library',
      `默认目标=${defaultDestination}`
    );
    const folderSectionVisible = await page.evaluate(() =>
      document.body.innerText.includes('目录与分类')
    );
    record(
      'P3.3 默认目标下「目录与分类」映射区直接可见',
      folderSectionVisible,
      `可见=${folderSectionVisible}`
    );
    const chromeStats = await previewStats(page);
    report.counts.chromeFixture = chromeStats;
    record(
      'P3.3 Chrome 书签 HTML 解析出 12 条（9 新增 / 1 重复 / 2 无效）',
      chromeStats?.['总条数'] === 12 && chromeStats?.['可新增'] === 9 && chromeStats?.['重复'] === 1 && chromeStats?.['无效'] === 2,
      JSON.stringify(chromeStats)
    );
    const chromeRows = await previewRows(page);
    record(
      'P3.3 多层目录被保留为来源目录',
      chromeRows.some((row) => /原目录：书签栏 \/ 开发 \/ 前端/.test(row.titleAndUrl)),
      chromeRows.map((row) => /原目录：(.*)$/.exec(row.titleAndUrl)?.[1] ?? '-').slice(0, 4).join(' | ')
    );
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(1200);
    const folderSelects = await page.evaluate(() =>
      [...document.querySelectorAll('.capturetable select')].map((node) => node.getAttribute('aria-label'))
    );
    await page.select('select[aria-label="其他书签 的目标分类"]', ctx.categoryId);
    await sleep(400);
    record(
      'P3.3 目录映射按原目录分组给出选择器',
      folderSelects.length >= 4 && folderSelects.some((label) => label === '其他书签 的目标分类'),
      folderSelects.join(' / ')
    );

    // 取消勾选「相同标题」那条，验证只写勾选行
    const uncheckedOk = await toggleRowByUrl(page, 'https://example.com/same-title');
    await sleep(400);
    const beforeCommitSelected = await selectedCount(page);
    record(
      'P3.4 可以取消勾选单行，已选计数同步',
      uncheckedOk && beforeCommitSelected === 8,
      `取消勾选=${uncheckedOk}｜已选=${beforeCommitSelected}`
    );
    const beforeCommit = await page.evaluate(readMainLibrary);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 30_000);
    await sleep(600);
    const result = await resultStats(page);
    const afterCommit = await page.evaluate(readMainLibrary);
    const addedCount = afterCommit.bookmarks.length - beforeCommit.bookmarks.length;
    report.counts.chromeResult = result;
    record(
      'P3.4 只写入勾选的可新增行',
      result?.['条新增'] === 8 && addedCount === 8,
      `结果面板=${JSON.stringify(result)}｜主库新增=${addedCount}`
    );
    record(
      'P3.4 未勾选、重复与无效行都不入库',
      !afterCommit.bookmarks.some((row) => row.originalUrl === 'https://example.com/same-title')
    );
    // P3.1 的弹窗样本也带着这个分类，统计映射结果时剔除，只看本批写入的条目。
    const mapped = afterCommit.bookmarks.filter(
      (row) => row.categoryId === ctx.categoryId && row.originalUrl !== URL_POPUP_BOOKMARK
    );
    record(
      'P3.3 目录映射到已有分类后写入生效',
      mapped.length === 3,
      `该分类下=${mapped.length} 条（不含 P3.1 弹窗样本；其他书签 4 条中取消了 1 条）`
    );
    const batches1 = await page.evaluate(readImportBatches);
    report.counts.batches = batches1;
    record(
      'P3.4 写入后保留可核对的批次记录',
      batches1.length === 1 &&
        batches1[0]?.status === 'applied' &&
        batches1[0]?.inserted === 8 &&
        batches1[0]?.fileName === 'bookmarks-chrome.html',
      JSON.stringify(batches1.map((row) => [row.fileName, row.status, row.inserted, row.total]))
    );
  });

  phase('P3.3 同一文件再导', async () => {
    // 上一次只写了 8 条，没勾选的 same-title 仍是「可新增」；其余 8 条应全部转为重复。
    await clickIn(page, '.panel', '继续导入');
    await sleep(500);
    await uploadFixture(page, FIXTURES.chrome);
    await waitPreview(page);
    const secondStats = await previewStats(page);
    const secondRows = await previewRows(page);
    report.counts.chromeSecondImport = secondStats;
    const stillNew = secondRows.filter((row) => row.status === '新增');
    record(
      'P3.3 同一文件再导：已写入的 8 条全部转为重复',
      secondStats?.['总条数'] === 12 &&
        secondStats?.['可新增'] === 1 &&
        secondStats?.['重复'] === 9 &&
        secondStats?.['无效'] === 2,
      JSON.stringify(secondStats)
    );
    record(
      'P3.3 再导时只剩上次没勾选的那条仍可新增',
      stillNew.length === 1 && /same-title/.test(stillNew[0]?.titleAndUrl ?? ''),
      stillNew.map((row) => row.titleAndUrl.replace(/\s+/g, ' ').slice(0, 80)).join(' | ') || '未找到'
    );

    const beforeSecond = await page.evaluate(readMainLibrary);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 30_000);
    await sleep(600);
    const secondResult = await resultStats(page);
    const afterSecond = await page.evaluate(readMainLibrary);
    report.counts.chromeSecondResult = secondResult;
    record(
      'P3.3 再导只写入剩下的 1 条，不重复写已入库的',
      secondResult?.['条新增'] === 1 && afterSecond.bookmarks.length === beforeSecond.bookmarks.length + 1,
      `结果面板=${JSON.stringify(secondResult)}｜收藏 ${beforeSecond.bookmarks.length}→${afterSecond.bookmarks.length}`
    );

    // 第三次：同一文件全部条目都已入库，界面上应没有任何可写入内容。
    await clickIn(page, '.panel', '继续导入');
    await sleep(500);
    await uploadFixture(page, FIXTURES.chrome);
    await waitPreview(page);
    const thirdStats = await previewStats(page);
    const thirdSelected = await selectedCount(page);
    const commitDisabled = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('.batchbar button')].find((node) =>
        (node.textContent ?? '').includes('确认写入')
      );
      return hit ? hit.disabled : null;
    });
    report.counts.chromeThirdImport = thirdStats;
    record(
      'P3.3 同一文件第三次导入：可新增为 0，写入按钮不可用',
      thirdStats?.['可新增'] === 0 &&
        thirdStats?.['重复'] === 10 &&
        thirdSelected === 0 &&
        commitDisabled === true,
      `统计=${JSON.stringify(thirdStats)}｜已选=${thirdSelected}｜按钮禁用=${commitDisabled}`
    );
    await clickIn(page, '.batchbar', '取消预览');
    await waitForSelectorGone(page, '.capturetable', 10_000);
  });

  phase('P3.3 Edge 书签格式', async () => {
    // 上一阶段结束时可能已经取消预览，结果面板不在了：「继续导入」只在它存在时才需要点。
    await page.evaluate(() => {
      const hit = [...document.querySelectorAll('.panel button')].find(
        (node) => (node.textContent ?? '').trim() === '继续导入'
      );
      if (hit instanceof HTMLElement) hit.click();
    });
    await sleep(500);
    await uploadFixture(page, FIXTURES.edge);
    await waitPreview(page);
    const edgeStats = await previewStats(page);
    const edgeRows = await previewRows(page);
    report.counts.edgeFixture = edgeStats;
    record(
      'P3.3 Edge 书签 HTML 解析出 6 条（4 新增 / 1 重复 / 1 无效）',
      edgeStats?.['总条数'] === 6 && edgeStats?.['可新增'] === 4 && edgeStats?.['重复'] === 1 && edgeStats?.['无效'] === 1,
      JSON.stringify(edgeStats)
    );
    record(
      'P3.3 Edge 的内部页面链接被判无效',
      edgeRows.some((row) => row.status === '无效' && /edge:\/\/settings/.test(row.titleAndUrl)),
      edgeRows.find((row) => row.status === '无效')?.titleAndUrl ?? '未找到'
    );
    await clickIn(page, '.batchbar', '取消预览');
    await waitForSelectorGone(page, '.capturetable', 10_000);
  });

  phase('P3.3/P3.5 Firefox 与待看保留', async () => {
    await goto(page, 'home', '快速操作');
    await clickIn(page, '.hubgrid', '加入待看');
    await waitForSelectorReady(page, '.modal input[placeholder="https://"]', 10_000);
    await setReactInput(page, '.modal input[placeholder="https://"]', URL_READING_KEEP);
    await setReactInput(page, '.modal input[placeholder="给它一个容易想起的名字"]', '导入前的待看样本');
    await clickIn(page, '.modal', '加入待看');
    await waitForSelectorGone(page, '.modal input[placeholder="https://"]', 20_000);
    await sleep(600);

    await goto(page, 'capture:file', '选择浏览器导出的书签 HTML');
    await uploadFixture(page, FIXTURES.firefox);
    await waitPreview(page);
    // 先切到收藏库再统计：目标为待看时同一 URL 已在队列里会被算作重复。
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(1200);
    const firefoxStats = await previewStats(page);
    const firefoxRows = await previewRows(page);
    report.counts.firefoxFixture = firefoxStats;
    record(
      'P3.3 Firefox 书签 HTML 解析出 5 条（4 新增 / 1 无效）',
      firefoxStats?.['总条数'] === 5 && firefoxStats?.['可新增'] === 4 && firefoxStats?.['无效'] === 1,
      JSON.stringify(firefoxStats)
    );
    record(
      'P3.3 Firefox 的 place: 智能书签被判无效',
      firefoxRows.some((row) => row.status === '无效' && /place:/.test(row.titleAndUrl)),
      firefoxRows.find((row) => row.status === '无效')?.titleAndUrl ?? '未找到'
    );
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 30_000);
    await sleep(600);
    const afterFirefox = await page.evaluate(readMainLibrary);
    const keptReading = afterFirefox.readings.find((row) => row.originalUrl === URL_READING_KEEP);
    record(
      'P3.5 普通导入收藏不会自动完成相同 URL 的待看',
      afterFirefox.bookmarks.some((row) => row.originalUrl === URL_READING_KEEP) && keptReading?.status === 'pending',
      `收藏已建=${afterFirefox.bookmarks.some((row) => row.originalUrl === URL_READING_KEEP)}｜待看=${keptReading?.status}`
    );
    const batches2 = await page.evaluate(readImportBatches);
    record(
      'P3.4 每批导入各自留下批次记录',
      batches2.length === 3 &&
        batches2.every((row) => row.status === 'applied') &&
        batches2
          .filter((row) => row.fileName === 'bookmarks-chrome.html')
          .map((row) => row.inserted)
          .sort((left, right) => left - right)
          .join(',') === '1,8' &&
        batches2.filter((row) => row.fileName === 'bookmarks-firefox.html').length === 1,
      JSON.stringify(batches2.map((row) => [row.fileName, row.inserted]))
    );
  });

  phase('P3.4 撤销刚导入的一批', async () => {
    const before = await page.evaluate(readMainLibrary);
    const clicked = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('button')].find((node) =>
        (node.textContent ?? '').includes('撤回这次导入')
      );
      if (!hit) return false;
      hit.click();
      return true;
    });
    if (!clicked) throw new Error('结果面板里没有「撤回这次导入」按钮');

    // 撤回改成两步：先预演，把「会移除几条、保留几条」摆在确认按钮旁边。
    await waitForText(page, '将移除', 20_000);
    const previewText = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('将移除')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    report.counts.resultUndoPreview = previewText.slice(0, 160);
    record(
      'P3.4 撤回前先预演移除 / 保留条数',
      /将移除 4 条，保留 0 条/.test(previewText),
      previewText.slice(0, 120)
    );

    await clickIn(page, '', '确认撤回');
    await waitForText(page, '已撤回这次导入', 20_000);
    await sleep(800);

    const after = await page.evaluate(readMainLibrary);
    record(
      'P3.4 撤销导入移除这一批新建的收藏',
      before.bookmarks.length - after.bookmarks.length === 4,
      `收藏 ${before.bookmarks.length}→${after.bookmarks.length}`
    );
    const batches = await page.evaluate(readImportBatches);
    const revertedBatch = batches.find((row) => row.fileName === 'bookmarks-firefox.html');
    record(
      'P3.4 撤销后批次状态记为 reverted',
      revertedBatch?.status === 'reverted',
      JSON.stringify(batches.map((row) => [row.fileName, row.status]))
    );
    // 撤回会清掉 importItems，之后只能靠批次上留的三个字段回看，必须确实写进去了。
    record(
      'P3.4 撤回时间与三类计数写进批次',
      Boolean(revertedBatch?.revertedAt) &&
        revertedBatch?.undoCounts?.removed === 4 &&
        revertedBatch?.undoCounts?.kept === 0 &&
        revertedBatch?.undoCounts?.missing === 0,
      `revertedAt=${revertedBatch?.revertedAt ?? '无'}｜undoCounts=${JSON.stringify(revertedBatch?.undoCounts)}`
    );

    // 重新解析同一份文件：还能算成「可新增」才说明撤销没有留下挡住重导的墓碑。
    // 先把 file input 清空——同一个路径再 uploadFile 一次不会触发 change，页面不会有反应。
    await page.evaluate(() => {
      const input = document.querySelector('input[type="file"]');
      if (input instanceof HTMLInputElement) input.value = '';
    });
    await uploadFixture(page, FIXTURES.firefox);
    await waitPreview(page);
    await sleep(1000);
    const againStats = await previewStats(page);
    record(
      'P3.4 撤销后同一批书签可以重新导入（未留下删除标记）',
      againStats?.['可新增'] === 4,
      JSON.stringify(againStats)
    );
    await clickIn(page, '.batchbar', '取消预览');
    await waitForSelectorGone(page, '.capturetable', 10_000);
  });

  phase('P3.3 恶意内容', async () => {
    // 上一阶段可能已经撤销导入，结果面板不在了：「继续导入」只在它存在时才需要点。
    await page.evaluate(() => {
      const hit = [...document.querySelectorAll('.panel button')].find(
        (node) => (node.textContent ?? '').trim() === '继续导入'
      );
      if (hit instanceof HTMLElement) hit.click();
    });
    await sleep(400);
    externalRequests.length = 0;
    await uploadFixture(page, FIXTURES.hostile);
    await waitPreview(page);
    await sleep(1200);
    const hostileStats = await previewStats(page);
    const hostileRequests = externalRequests.filter((url) => url.includes('127.0.0.1:9'));
    const hostileRan = await page.evaluate(() => Boolean(window.__p3_hostile_ran));
    report.counts.hostileFixture = hostileStats;
    record(
      'P3.3 恶意书签文件不执行脚本、不加载图片样式',
      hostileRequests.length === 0 && hostileRan === false,
      `外部请求=${JSON.stringify(hostileRequests)}｜脚本执行=${hostileRan}`
    );
    record(
      'P3.3 javascript: 与 data: 链接被判无效，只留 1 条可新增',
      hostileStats?.['无效'] === 2 && hostileStats?.['可新增'] === 1,
      JSON.stringify(hostileStats)
    );
    await clickIn(page, '.batchbar', '取消预览');
    await waitForSelectorGone(page, '.capturetable', 10_000);
  });

  phase('P3.3 损坏文件', async () => {
    const bookmarksBeforeBroken = (await page.evaluate(readMainLibrary)).bookmarks.length;
    await uploadFixture(page, FIXTURES.malformed);
    await waitPreview(page);
    const brokenWarning = await page.evaluate(() => document.body.innerText.includes('未正常闭合'));
    const brokenStats = await previewStats(page);
    await clickIn(page, '.batchbar', '取消预览');
    await sleep(500);
    const bookmarksAfterBroken = (await page.evaluate(readMainLibrary)).bookmarks.length;
    record(
      'P3.3 损坏文件给出结构警告且不写入',
      brokenWarning && Boolean(brokenStats) && bookmarksAfterBroken === bookmarksBeforeBroken,
      `警告=${brokenWarning}｜统计=${JSON.stringify(brokenStats)}｜收藏数 ${bookmarksBeforeBroken}→${bookmarksAfterBroken}`
    );
  });

  phase('P3.3 深层目录上限', async () => {
    // 40 层嵌套、最底层挂 1 条收藏：应给出层级告警，且条目保留、来源目录截断到 32 层。
    const bookmarksBeforeDeep = (await page.evaluate(readMainLibrary)).bookmarks.length;
    await uploadFixture(page, FIXTURES.deep);
    await waitPreview(page);
    const deepText = await page.evaluate(() => document.body.innerText);
    const deepStats = await previewStats(page);
    const deepRows = await previewRows(page);
    report.counts.deepFixture = deepStats;
    record(
      'P3.3 超过 32 层的目录给出层级告警',
      /目录层级超过 32 层/.test(deepText),
      deepText.includes('目录层级超过 32 层')
        ? '界面提示「目录层级超过 32 层，更深的目录会合并到上限层级。」'
        : '未找到层级告警文案'
    );
    const deepCell = deepRows[0]?.titleAndUrl ?? '';
    record(
      'P3.3 超限深度的条目不被丢弃，来源目录截断到第 32 层',
      deepStats?.['总条数'] === 1 &&
        deepStats?.['可新增'] === 1 &&
        /第 32 层/.test(deepCell) &&
        !/第 33 层/.test(deepCell) &&
        /最底层的那条收藏/.test(deepCell),
      `统计=${JSON.stringify(deepStats)}｜目录末段=${/原目录：.*$/.exec(deepCell)?.[0]?.slice(-24) ?? '未找到'}`
    );
    await clickIn(page, '.batchbar', '取消预览');
    await sleep(500);
    const bookmarksAfterDeep = (await page.evaluate(readMainLibrary)).bookmarks.length;
    record(
      'P3.3 深层目录预览不写入主库',
      bookmarksAfterDeep === bookmarksBeforeDeep,
      `收藏数 ${bookmarksBeforeDeep}→${bookmarksAfterDeep}`
    );
  });

  phase('P3.5 批量与文件大小限制', async () => {
    await goto(page, 'capture', '一次收下多个链接');
    const tooMany = Array.from({ length: 1001 }, (_, index) => `https://example.com/p3-bulk-${index}`).join('\n');
    await setReactInput(page, 'textarea[aria-label="粘贴链接"]', tooMany);
    await clickIn(page, '.panel', '预览链接 →');
    await sleep(1500);
    const tooManyError = await page.evaluate(() => document.querySelector('.panel .alert')?.textContent ?? '');
    record(
      'P3.5 超过单批 1000 条时明确拒绝',
      /1000/.test(tooManyError),
      `错误=「${tooManyError.trim()}」`
    );

    const bigFile = path.join(TMP_DIR, 'bookmarks-oversize.html');
    fs.writeFileSync(
      bigFile,
      `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n${'<!-- padding -->\n'.repeat(220000)}</DL><p>\n`,
      'utf8'
    );
    await goto(page, 'capture:file', '选择浏览器导出的书签 HTML');
    await uploadFixture(page, bigFile);
    await sleep(1500);
    const bigFileError = await page.evaluate(() => document.querySelector('.panel .alert')?.textContent ?? '');
    record(
      'P3.5 超过 3 MB 的书签文件被拒绝',
      /3 MB/.test(bigFileError),
      `错误=「${bigFileError.trim()}」｜文件=${(fs.statSync(bigFile).size / 1024 / 1024).toFixed(2)} MB`
    );
  });

  phase('P3.5 清空待看', async () => {
    await goto(page, 'reading', '先留着，稍后再看。');
    const before = await page.evaluate(readMainLibrary);
    const pendingBefore = before.readings.filter((row) => row.status === 'pending').length;
    await clickIn(page, '.toolbar', '清空待看…');
    await waitForText(page, '确认清空待看的', 10_000);
    await clickIn(page, '', '确认清空');
    await sleep(900);
    const after = await page.evaluate(readMainLibrary);
    record(
      'P3.5 清空待看只清队列，收藏数量不变',
      pendingBefore > 0 &&
        after.readings.filter((row) => row.status === 'pending').length === 0 &&
        after.bookmarks.length === before.bookmarks.length,
      `待看 ${pendingBefore}→${after.readings.filter((row) => row.status === 'pending').length}｜收藏 ${before.bookmarks.length}→${after.bookmarks.length}`
    );
  });

  phase('P3.4 彻底清空收藏库', async () => {
    await goto(page, 'all', '全部收藏');
    // 先删一条进回收站：清空会连它一起删，确认框必须把这个数字算进去并说明。
    await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="删除收藏"]');
      if (button instanceof HTMLElement) button.click();
    });
    await waitForText(page, '移到回收站', 10_000);
    await sleep(300);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.modal button')].find(
        (node) => (node.textContent ?? '').trim() === '移到回收站'
      );
      if (button instanceof HTMLElement) button.click();
    });
    await sleep(900);

    const before = await page.evaluate(readMainLibrary);
    // readMainLibrary 投影出来的是派生键 lifeState，没有 deletedAt 字段。
    const trashedBefore = before.bookmarks.filter((row) => row.lifeState === 'deleted').length;
    await clickIn(page, '.toolbar', '彻底清空…');
    await waitForText(page, '确认彻底清空', 10_000);
    await waitForText(page, '条记录（在库', 10_000);
    const dialogText = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('确认彻底清空')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ');
    });
    const breakdown = /将删除 (\d+) 条记录（在库 (\d+) · 回收站 (\d+)），并清掉 (\d+) 条删除标记/.exec(
      dialogText
    );
    report.counts.purgeDialog = {
      text: dialogText,
      total: breakdown ? Number(breakdown[1]) : null,
      active: breakdown ? Number(breakdown[2]) : null,
      trashed: breakdown ? Number(breakdown[3]) : null,
      tombstones: breakdown ? Number(breakdown[4]) : null,
    };
    record(
      'P3.4 清空确认框拆出在库 / 回收站 / 删除标记，且与实删数量一致',
      Boolean(breakdown) &&
        Number(breakdown[1]) === before.bookmarks.length &&
        Number(breakdown[2]) + Number(breakdown[3]) === Number(breakdown[1]) &&
        Number(breakdown[3]) === trashedBefore &&
        trashedBefore === 1 &&
        Number(breakdown[4]) === trashedBefore,
      `对话框=${dialogText.slice(0, 90)}｜主库=${before.bookmarks.length}（回收站 ${trashedBefore}）`
    );

    await clickIn(page, '', '确认清空');
    await sleep(1200);

    // 墓碑必须是 0：只删记录不清墓碑的话，重新导入同一批书签会全被挡住。
    const tombstones = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => resolve(-1);
          request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('tombstones')) {
              db.close();
              resolve(0);
              return;
            }
            const tx = db.transaction('tombstones', 'readonly');
            const all = tx.objectStore('tombstones').getAll();
            tx.oncomplete = () => {
              resolve(all.result.length);
              db.close();
            };
          };
        })
    );
    const after = await page.evaluate(readMainLibrary);
    record(
      'P3.4 彻底清空后收藏与删除标记都归零',
      before.bookmarks.length > 0 && after.bookmarks.length === 0 && tombstones === 0,
      `收藏 ${before.bookmarks.length}→${after.bookmarks.length}｜墓碑=${tombstones}`
    );
  });

  phase('P3.4 从数据页撤销最近一次导入', async () => {
    // 用户导入完关掉页面之后，唯一找得回来的入口就在这里：数据页的「最近导入」。
    await goto(page, 'capture', '一次收下多个链接');
    await setReactInput(
      page,
      'textarea[aria-label="粘贴链接"]',
      'https://example.com/undo-a\nhttps://example.com/undo-b'
    );
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(1000);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 30_000);
    await sleep(600);
    const imported = await page.evaluate(readMainLibrary);
    const listedOk = await page.evaluate(() => document.body.innerText.includes('导入完成'));

    await goto(page, 'data', '数据在手里');
    // 「最近导入」是异步加载的，页面标题一出现就点按钮会扑空。
    await waitForText(page, '撤回这次导入', 15_000);
    const panelShown = await page.evaluate(() =>
      document.body.innerText.includes('最近导入')
    );
    await clickIn(page, '', '撤回这次导入');
    // 数据页同样先预演：同一个入口不能有的先问、有的直删。
    await waitForText(page, '将移除', 15_000);
    const dataPreview = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('将移除')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    report.counts.dataUndoPreview = dataPreview.slice(0, 160);
    record(
      'P3.4 数据页撤回前同样先预演',
      /将移除 2 条，保留 0 条/.test(dataPreview),
      dataPreview.slice(0, 120)
    );

    await clickIn(page, '', '确认撤回');
    await sleep(1200);
    const after = await page.evaluate(readMainLibrary);
    const resultPanel = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('已撤回')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    record(
      'P3.4 数据页列出导入批次并可从那里整批撤销',
      listedOk && panelShown && after.bookmarks.length === imported.bookmarks.length - 2,
      `导入后面板=${panelShown}｜收藏 ${imported.bookmarks.length}→${after.bookmarks.length}`
    );
    record(
      'P3.4 撤回后结果常驻在页面上（不是几秒就消失的提示）',
      /已撤回/.test(resultPanel) && /移除 2 条/.test(resultPanel),
      resultPanel.slice(0, 120)
    );

    // 刷新页面：结果面板会消失（那是本次会话的），但批次行上的时间与三类计数必须还在。
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 25_000);
    await waitForText(page, '已撤回', 15_000);
    const persisted = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('article.bookmark')];
      const hit = rows.find((row) => (row.innerText ?? '').includes('已撤回'));
      return (hit?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    report.counts.revertedBatchRow = persisted.slice(0, 160);
    record(
      'P3.4 刷新后仍能查到这次撤回的时间与条数',
      /已撤回/.test(persisted) && /移除 2/.test(persisted) && /保留 0/.test(persisted),
      persisted.slice(0, 120)
    );

    // 批次多了以后不能只给最近几批：搜索必须能按文件名把那一份找出来。
    await setReactInput(page, 'input[aria-label="搜索导入批次"]', 'bookmarks-firefox');
    await sleep(600);
    // 只看「最近导入」面板里的行：页面上「最近清理」也是 article.bookmark，不能被算进来。
    const filtered = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('.panel')].find((node) =>
        (node.innerText ?? '').includes('最近导入')
      );
      return [...(panel?.querySelectorAll('article.bookmark') ?? [])].map((row) =>
        (row.innerText ?? '').replace(/\s+/g, ' ').trim()
      );
    });
    record(
      'P3.4 批次列表可按文件名搜索',
      filtered.length >= 1 && filtered.every((text) => text.includes('bookmarks-firefox')),
      `命中 ${filtered.length} 条｜${filtered[0]?.slice(0, 60) ?? '无'}`
    );
    await setReactInput(page, 'input[aria-label="搜索导入批次"]', '');
    await sleep(500);
  });

  phase('P9.4 清理快照与单次恢复', async () => {
    await goto(page, 'data', '最近清理');
    await waitForText(page, '看看能找回什么', 15_000);
    const listed = await readPurgeSnapshots(page);
    report.counts.purgeSnapshots = listed;
    record(
      'P9.4 每次硬删除都在「最近清理」留下快照',
      listed.count >= 1,
      `快照=${listed.count} 条｜首条=${listed.rows[0] ?? '无'}`
    );

    // 页面里有多个 .panel，「最近清理」不是第一个，直接按全文唯一文案点。
    await clickIn(page, '', '看看能找回什么');
    await waitForText(page, '可找回', 15_000);
    const previewText = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('可找回')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    const restorable = Number(/可找回 (\d+) 条/.exec(previewText)?.[1] ?? -1);
    report.counts.purgePreview = previewText.slice(0, 160);
    record(
      'P9.4 恢复前先给出可找回 / 跳过 / 冲突三项',
      restorable >= 0 && /跳过 \d+ 条/.test(previewText) && /冲突 \d+ 条/.test(previewText),
      previewText.slice(0, 120)
    );

    const beforeRestore = await page.evaluate(readMainLibrary);
    await clickIn(page, '', `恢复这 ${restorable} 条`);
    await waitForText(page, '找回', 20_000);
    await sleep(1200);
    const afterRestore = await page.evaluate(readMainLibrary);
    const added = afterRestore.bookmarks.length - beforeRestore.bookmarks.length;
    report.counts.purgeRestore = { restorable, added };
    record(
      'P9.4 恢复只加回这一次删掉的条目，数量与预览一致',
      restorable > 0 && added === restorable,
      `预览可找回=${restorable}｜实际新增=${added}（收藏 ${beforeRestore.bookmarks.length}→${afterRestore.bookmarks.length}）`
    );
    record(
      'P9.4 恢复不产生外部请求也不触发页面错误',
      externalRequests.length === 0,
      `外部请求=${JSON.stringify(externalRequests)}`
    );
  });

  phase('P9.2 查看本批与处理全部匹配', async () => {
    // 造一批 60 条、两个站点各 30 条：用「站点」把其中一半切出来，
    // 验证「处理全部匹配」按的是全部命中，而不是页面上显示的前 50 条。
    await goto(page, 'capture', '一次收下多个链接');
    const lines = [];
    for (let index = 0; index < 30; index += 1) lines.push(`https://work.example.com/item-${index}`);
    for (let index = 0; index < 30; index += 1) lines.push(`https://life.example.com/item-${index}`);
    await setReactInput(page, 'textarea[aria-label="粘贴链接"]', lines.join('\n'));
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(800);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 40_000);
    await sleep(800);

    await goto(page, 'data', '数据在手里');
    await waitForText(page, '查看本批', 20_000);
    await clickIn(page, '', '查看本批');
    await waitForText(page, '本批明细', 20_000);
    await sleep(600);

    const detailText = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('本批明细')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    report.counts.batchDetail = detailText.slice(0, 220);
    record(
      'P9.2 查看本批列出这一批新建的记录，并写明「匹配 60 条、第 1 / 2 页（1–50）」',
      /本批明细/.test(detailText) &&
        /匹配 60 条，当前第 1 \/ 2 页（1–50）/.test(detailText),
      detailText.slice(0, 160)
    );

    // 一页 50 条，剩下 10 条在第二页：截断在展示上，不能变成看不到。
    await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('本批明细')
      );
      const next = [...(notice?.querySelectorAll('button') ?? [])].find((node) =>
        (node.textContent ?? '').includes('下一页')
      );
      if (!next) throw new Error('本批明细里没有下一页按钮');
      next.click();
    });
    await sleep(500);
    const expanded = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('本批明细')
      );
      return {
        text: (notice?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        rows: notice?.querySelectorAll('.listbox .bookmark').length ?? 0,
      };
    });
    record(
      'P9.2 明细翻到第二页补齐剩下 10 条，总数与命中一致',
      /匹配 60 条，当前第 2 \/ 2 页（51–60）/.test(expanded.text) && expanded.rows === 10,
      `列出=${expanded.rows}｜${expanded.text.slice(0, 120)}`
    );

    await page.select('select[aria-label="本批站点"]', 'work.example.com');
    await sleep(600);
    const siteFiltered = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('本批明细')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    record(
      'P9.2 按站点筛选后命中数与可处理数同步收敛，页码回到第一页',
      /匹配 30 条/.test(siteFiltered) && /可移入回收站 30 条/.test(siteFiltered),
      siteFiltered.slice(0, 160)
    );

    const before = await page.evaluate(readMainLibrary);
    const activeBefore = before.bookmarks.filter((row) => row.lifeState === 'active').length;

    // 预览冻结之后，另一个页面改掉其中一条：执行时必须跳过它，不能照旧删。
    await clickIn(page, '', '移入回收站 30 条');
    await waitForText(page, '确认处理 30 条', 15_000);
    const mutated = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readonly');
        const request = tx.objectStore('bookmarks').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = all.find((entry) => entry.originalUrl === 'https://work.example.com/item-7');
      if (!row) return null;
      row.localRevision += 1;
      row.revision += 1;
      row.note = '预览之后改的';
      await new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readwrite');
        tx.objectStore('bookmarks').put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return row.localRevision;
    });
    if (!mutated) throw new Error('没找到用于并发改动的样本');

    await clickIn(page, '', '确认处理 30 条');
    await waitForText(page, '已处理', 25_000);
    await sleep(900);
    const afterTrash = await page.evaluate(readMainLibrary);
    const activeAfterTrash = afterTrash.bookmarks.filter((row) => row.lifeState === 'active').length;
    const keptOne = afterTrash.bookmarks.find(
      (row) => row.originalUrl === 'https://work.example.com/item-7'
    );
    const trashResult = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('已处理')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    report.counts.batchCleanupTrash = trashResult.slice(0, 200);
    record(
      'P9.2 移入回收站按全部匹配执行（29 条），并按最新状态留下被改动的那条',
      activeBefore - activeAfterTrash === 29 &&
        keptOne?.lifeState === 'active' &&
        /跳过 1 条/.test(trashResult) &&
        /预览后被修改/.test(trashResult),
      `在库 ${activeBefore}→${activeAfterTrash}｜${trashResult.slice(0, 120)}`
    );

    // 另一站点整段彻底删除：连删除标记一起清，但先留一份清理快照。
    const snapshotsBefore = await readPurgeSnapshots(page);
    await page.select('select[aria-label="本批站点"]', 'life.example.com');
    await sleep(500);
    await clickIn(page, '', '彻底删除 30 条');
    await waitForText(page, '确认处理 30 条', 15_000);
    await clickIn(page, '', '确认处理 30 条');
    await waitForText(page, '已处理 30 条', 25_000);
    await sleep(1200);
    const snapshotsAfter = await readPurgeSnapshots(page);
    const afterDelete = await page.evaluate(readMainLibrary);
    const activeAfterDelete = afterDelete.bookmarks.filter((row) => row.lifeState === 'active').length;
    record(
      'P9.2 彻底删除留下清理快照，范围写明批次与站点',
      snapshotsAfter.rows[0] !== snapshotsBefore.rows[0] &&
        /批次：/.test(snapshotsAfter.rows[0] ?? '') &&
        /life\.example\.com/.test(snapshotsAfter.rows[0] ?? '') &&
        /收藏 30/.test(snapshotsAfter.rows[0] ?? '') &&
        activeAfterDelete === activeAfterTrash - 30,
      `最新快照=${(snapshotsAfter.rows[0] ?? '').slice(0, 100)}｜在库 ${activeAfterTrash}→${activeAfterDelete}`
    );

    // 误操作后按次找回：这份快照只加回刚删的 30 条，不动回收站里那 29 条。
    await clickIn(page, '', '看看能找回什么');
    await waitForText(page, '可找回', 15_000);
    const restorePreview = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('可找回')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    await clickIn(page, '', '恢复这 30 条');
    await sleep(1600);
    const afterRestore = await page.evaluate(readMainLibrary);
    const activeAfterRestore = afterRestore.bookmarks.filter((row) => row.lifeState === 'active').length;
    record(
      'P9.2 清理后可按次找回这 30 条，回收站里的不被动',
      /可找回 30 条/.test(restorePreview) && activeAfterRestore === activeAfterDelete + 30,
      `在库 ${activeAfterDelete}→${activeAfterRestore}｜${restorePreview.slice(0, 100)}`
    );
  });

  phase('P9.2b 已改动与回收站记录的按批处理', async () => {
    // 三条同一站点：一条改过、两条原样。验证两件事——
    // ① 明确筛「已改动」后能主动清理，不再被当成永久豁免；
    // ② 「先移入回收站看看，确定不要了再按本批彻底删除并重导」这条路走得通。
    await goto(page, 'capture', '一次收下多个链接');
    await setReactInput(
      page,
      'textarea[aria-label="粘贴链接"]',
      ['https://mod.example.com/item-1', 'https://mod.example.com/item-2', 'https://mod.example.com/item-3'].join(
        '\n'
      )
    );
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(700);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 40_000);
    await sleep(800);

    // 在打开批次明细之前改一条：明细才会如实反映「已改动」。
    const edited = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readonly');
        const request = tx.objectStore('bookmarks').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = all.find((entry) => entry.originalUrl === 'https://mod.example.com/item-2');
      if (!row) return null;
      row.localRevision += 1;
      row.revision += 1;
      row.title = '我改过的标题';
      await new Promise((resolve, reject) => {
        const tx = db.transaction('bookmarks', 'readwrite');
        tx.objectStore('bookmarks').put(row);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return row.id;
    });
    if (!edited) throw new Error('没找到用于「已改动」的样本');

    await goto(page, 'data', '数据在手里');
    await waitForText(page, '查看本批', 20_000);

    const undoCopyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    record(
      'P9.2b 撤回说明改为可从最近清理快照找回',
      /按次从本机快照恢复/.test(undoCopyText) && !/撤回本身不可恢复/.test(undoCopyText),
      /按次从本机快照恢复/.test(undoCopyText) ? '已写明可按次找回' : '仍写着不可恢复'
    );

    await clickIn(page, '', '查看本批');
    await waitForText(page, '本批明细', 20_000);
    await sleep(500);

    const detailText = () =>
      page.evaluate(() => {
        const notice = [...document.querySelectorAll('.notice')].find((node) =>
          (node.innerText ?? '').includes('本批明细')
        );
        return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
      });

    const allStates = await detailText();
    record(
      'P9.2b 默认只看未改动：三条里只列出没动过的两条',
      /匹配 2 条/.test(allStates) && !/其中已改动/.test(allStates),
      allStates.slice(0, 180)
    );

    await page.select('select[aria-label="本批状态"]', 'all');
    await sleep(400);
    const everyState = await detailText();
    record(
      'P9.2b 切到全部状态后标出「已改动 1 条」，并给出两种动作各自的可处理数',
      /匹配 3 条/.test(everyState) &&
        /可移入回收站 3 条/.test(everyState) &&
        /可彻底删除 3 条/.test(everyState) &&
        /其中已改动 1 条/.test(everyState),
      everyState.slice(0, 190)
    );

    await page.select('select[aria-label="本批状态"]', 'modified');
    await sleep(400);
    const modifiedOnly = await detailText();
    record(
      'P9.2b 明确筛「已改动」后可以处理，不再是永久豁免',
      /匹配 1 条/.test(modifiedOnly) && /可移入回收站 1 条/.test(modifiedOnly),
      modifiedOnly.slice(0, 180)
    );

    await clickIn(page, '', '移入回收站 1 条');
    await waitForText(page, '确认处理 1 条', 15_000);
    const confirmCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('确认处理')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    record(
      'P9.2b 确认框写明「导入后改过，会按当前内容一起处理」',
      /导入后改过，会按当前内容一起处理/.test(confirmCopy),
      confirmCopy.slice(0, 190)
    );
    await clickIn(page, '', '确认处理 1 条');
    await waitForText(page, '已处理 1 条', 20_000);
    await sleep(900);

    await page.select('select[aria-label="本批状态"]', 'trashed');
    await sleep(500);
    const trashedOnly = await detailText();
    const trashButtonDisabled = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((node) =>
        (node.textContent ?? '').includes('移入回收站')
      );
      return button ? button.disabled : null;
    });
    record(
      'P9.2b 回收站记录只能彻底删除：移入按钮禁用，彻底删除可处理 1 条',
      /可移入回收站 0 条/.test(trashedOnly) &&
        /可彻底删除 1 条/.test(trashedOnly) &&
        trashButtonDisabled === true,
      `${trashedOnly.slice(0, 150)}｜移入按钮禁用=${trashButtonDisabled}`
    );

    await clickIn(page, '', '彻底删除 1 条');
    await waitForText(page, '确认处理 1 条', 15_000);
    const deleteCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('确认处理')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    record(
      'P9.2b 彻底删除的确认框点明包含回收站里的记录',
      /含 1 条已在回收站里的/.test(deleteCopy),
      deleteCopy.slice(0, 200)
    );
    await clickIn(page, '', '确认处理 1 条');
    await waitForText(page, '已处理 1 条', 20_000);
    await sleep(1000);

    const afterHard = await page.evaluate(readMainLibrary);
    const stillThere = afterHard.bookmarks.some(
      (row) => row.originalUrl === 'https://mod.example.com/item-2'
    );
    record('P9.2b 彻底删除后记录连删除标记一起消失', !stillThere, `仍在库=${stillThere}`);

    // 墓碑没了，同一网址重导才不会被自己的删除标记挡住——这是「彻底删除并重导」的落点。
    await goto(page, 'capture', '一次收下多个链接');
    await setReactInput(page, 'textarea[aria-label="粘贴链接"]', 'https://mod.example.com/item-2');
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    const restat = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.stat')].map((node) => [
          (node.querySelector('span')?.textContent ?? '').trim(),
          (node.querySelector('strong')?.textContent ?? '').trim(),
        ])
      )
    );
    record(
      'P9.2b 彻底删除后同一网址重新导入被判为可新增',
      restat['可新增'] === '1' && restat['重复'] === '0',
      `可新增=${restat['可新增']} 重复=${restat['重复']}`
    );
  });

  // 批量选择与「只找回一部分」：一条条点之外最常用的清理方式，必须能撑住。
  phase('P9.6 批量选择与只找回一部分', async () => {
    await goto(page, 'capture', '一次收下多个链接');
    await setReactInput(
      page,
      'textarea[aria-label="粘贴链接"]',
      ['https://bulk.example.com/b1', 'https://bulk.example.com/b2', 'https://bulk.example.com/b3'].join('\n')
    );
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(700);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 40_000);
    await sleep(800);

    await goto(page, 'all', '全部收藏');
    const beforeBulk = await page.evaluate(readMainLibrary);
    const activeBeforeBulk = beforeBulk.bookmarks.filter((row) => row.lifeState === 'active').length;

    await clickIn(page, '.toolbar', '批量选择');
    await sleep(300);
    const picked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.listbox .bookmark')].filter((row) =>
        (row.innerText ?? '').includes('bulk.example.com')
      );
      for (const row of rows) row.querySelector('input[type="checkbox"]')?.click();
      return rows.length;
    });
    await sleep(400);
    const selectedCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('已选')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    record(
      'P9.6 批量选择能勾中同站点的三条，并显示已选数量',
      picked === 3 && /已选 3 \//.test(selectedCopy),
      `勾选=${picked}｜${selectedCopy.slice(0, 120)}`
    );

    await clickIn(page, '', '移入回收站 3 条');
    await waitForText(page, '确认把这 3 条移入回收站', 10_000);
    await clickIn(page, '', '确认移入');
    await waitForText(page, '已移入回收站 3 条', 20_000);
    await sleep(1000);
    const afterBulkTrash = await page.evaluate(readMainLibrary);
    const activeAfterBulkTrash = afterBulkTrash.bookmarks.filter((row) => row.lifeState === 'active').length;
    record(
      'P9.6 勾选移入回收站一次处理三条，在库数量准确减少',
      activeBeforeBulk - activeAfterBulkTrash === 3,
      `在库 ${activeBeforeBulk}→${activeAfterBulkTrash}`
    );

    // 回收站里同样支持勾选批量恢复。
    await goto(page, 'trash', '回收站');
    await sleep(800);
    await clickIn(page, '.toolbar', '批量选择');
    await sleep(300);
    const pickedTrash = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.listbox .bookmark')].filter((row) =>
        (row.innerText ?? '').includes('bulk.example.com')
      );
      for (const row of rows) row.querySelector('input[type="checkbox"]')?.click();
      return rows.length;
    });
    await clickIn(page, '', '恢复选中的 3 条');
    await waitForText(page, '已恢复 3 条', 20_000);
    await sleep(900);
    const afterBulkRestore = await page.evaluate(readMainLibrary);
    const activeAfterBulkRestore = afterBulkRestore.bookmarks.filter((row) => row.lifeState === 'active').length;
    record(
      'P9.6 回收站里勾选批量恢复，三条回到在库',
      pickedTrash === 3 && activeAfterBulkRestore === activeBeforeBulk,
      `回收站勾选=${pickedTrash}｜在库=${activeAfterBulkRestore}`
    );

    // 批量彻底删除：留一份「手动选择的」快照，再从明细里只找回一条。
    await goto(page, 'all', '全部收藏');
    await sleep(600);
    await clickIn(page, '.toolbar', '批量选择');
    await sleep(300);
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.listbox .bookmark')].filter((row) =>
        (row.innerText ?? '').includes('bulk.example.com')
      );
      for (const row of rows) row.querySelector('input[type="checkbox"]')?.click();
    });
    await sleep(300);
    await clickIn(page, '', '彻底删除 3 条');
    await waitForText(page, '确认彻底删除这 3 条', 10_000);
    const purgeCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('确认彻底删除这 3 条')
      );
      return (notice?.innerText ?? '').replace(/\s+/g, ' ').trim();
    });
    await clickIn(page, '', '确认彻底删除');
    await waitForText(page, '已彻底删除 3 条', 20_000);
    await sleep(1200);
    record(
      'P9.6 批量彻底删除的确认框点明「不进回收站、留快照可部分找回」',
      /不进回收站/.test(purgeCopy) && /只找回其中几条/.test(purgeCopy),
      purgeCopy.slice(0, 200)
    );

    await goto(page, 'data', '最近清理');
    await sleep(600);
    const bulkSnapshots = await readPurgeSnapshots(page);
    record(
      'P9.6 批量彻底删除留下「手动选择的 3 条收藏」快照',
      /手动选择的 3 条收藏/.test(bulkSnapshots.rows[0] ?? ''),
      `最新=${(bulkSnapshots.rows[0] ?? '').slice(0, 120)}`
    );

    // 打开明细：逐条列出、可搜索、可只勾一条找回。
    await clickIn(page, '', '看看能找回什么');
    await waitForText(page, '可找回 3 条', 20_000);
    await sleep(600);
    const detailCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('可找回')
      );
      return {
        text: (notice?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        rows: document.querySelectorAll('.snapentry').length,
      };
    });
    record(
      'P9.6 快照明细逐条列出三条，并提供搜索与筛选',
      detailCopy.rows === 3 && /可找回 3 条/.test(detailCopy.text),
      `明细行=${detailCopy.rows}｜${detailCopy.text.slice(0, 140)}`
    );

    await setReactInput(page, 'input[aria-label="搜索清理记录"]', 'b2');
    await sleep(500);
    const searched = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.snapentry')].filter(
        (node) => node.querySelector('input[type="checkbox"]')
      );
      const toolbarText = [...document.querySelectorAll('.toolbar .micro')]
        .map((node) => (node.innerText ?? '').replace(/\s+/g, ' ').trim())
        .join(' ');
      return { rows: rows.length, text: toolbarText };
    });
    record(
      'P9.6 快照明细支持按关键词筛到单条',
      searched.rows === 1 && /匹配 1 条/.test(searched.text),
      `筛出=${searched.rows}｜${searched.text}`
    );

    await page.evaluate(() => {
      document.querySelector('.snapentry input[type="checkbox"]')?.click();
    });
    await sleep(400);
    const beforePickRestore = await page.evaluate(readMainLibrary);
    const activeBeforePick = beforePickRestore.bookmarks.filter((row) => row.lifeState === 'active').length;
    await clickIn(page, '', '恢复选中的 1 条');
    await waitForText(page, '找回 1 条', 20_000);
    await sleep(1200);
    const afterPickRestore = await page.evaluate(readMainLibrary);
    const activeAfterPick = afterPickRestore.bookmarks.filter((row) => row.lifeState === 'active').length;
    const b2Back = afterPickRestore.bookmarks.some(
      (row) => row.originalUrl === 'https://bulk.example.com/b2' && row.lifeState === 'active'
    );
    record(
      'P9.6 只勾一条时只找回一条，另外两条留在快照里',
      activeAfterPick - activeBeforePick === 1 && b2Back,
      `在库 ${activeBeforePick}→${activeAfterPick}`
    );

    // 再打开同一份快照：已找回的标出来，剩下的还能继续找。
    await clickIn(page, '', '看看能找回什么');
    await waitForText(page, '可找回 2 条', 20_000);
    await sleep(600);
    const secondOpen = await page.evaluate(() =>
      [...document.querySelectorAll('.snapentry')].map((node) =>
        (node.innerText ?? '').replace(/\s+/g, ' ').trim()
      )
    );
    record(
      'P9.6 再次打开同一份快照：已找回的标为「已找回」，剩余仍可找',
      secondOpen.some((row) => row.includes('已找回')) &&
        secondOpen.filter((row) => row.includes('可找回')).length === 2,
      `明细=${secondOpen.length} 行`
    );

    await clickIn(page, '', '全选可找回');
    await sleep(300);
    await clickIn(page, '', '恢复选中的 2 条');
    await waitForText(page, '找回 2 条', 20_000);
    await sleep(1200);
    const finalRestore = await page.evaluate(readMainLibrary);
    const bulkActive = finalRestore.bookmarks.filter(
      (row) => row.originalUrl.startsWith('https://bulk.example.com/') && row.lifeState === 'active'
    ).length;
    record('P9.6 同一份快照可以分两次找回，最终三条都回来', bulkActive === 3, `bulk 在库=${bulkActive}`);

    // 待看同样能勾选批量移除，并且会留快照。
    await goto(page, 'capture', '一次收下多个链接');
    await setReactInput(
      page,
      'textarea[aria-label="粘贴链接"]',
      ['https://read.example.com/r1', 'https://read.example.com/r2'].join('\n')
    );
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    await page.select('select[aria-label="保存目标"]', 'reading');
    await sleep(700);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 40_000);
    await sleep(800);

    await goto(page, 'reading', '先留着，稍后再看。');
    await sleep(600);
    const beforeRemove = await page.evaluate(readMainLibrary);
    const pendingBeforeRemove = beforeRemove.readings.filter((row) => row.status === 'pending').length;
    await clickIn(page, '.toolbar', '批量选择');
    await sleep(300);
    const pickedReading = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.listbox .bookmark')].filter((row) =>
        (row.innerText ?? '').includes('read.example.com')
      );
      for (const row of rows) row.querySelector('input[type="checkbox"]')?.click();
      return rows.length;
    });
    await clickIn(page, '', '移出待看 2 条');
    await waitForText(page, '确认移出这 2 条待看', 10_000);
    await clickIn(page, '', '确认移出');
    await waitForText(page, '已移出 2 条待看', 20_000);
    await sleep(1000);
    const afterRemove = await page.evaluate(readMainLibrary);
    const pendingAfterRemove = afterRemove.readings.filter((row) => row.status === 'pending').length;
    record(
      'P9.6 待看勾选批量移出，队列数量准确减少',
      pickedReading === 2 && pendingBeforeRemove - pendingAfterRemove === 2,
      `待看 ${pendingBeforeRemove}→${pendingAfterRemove}`
    );

    await goto(page, 'data', '最近清理');
    await sleep(600);
    const readingSnapshots = await readPurgeSnapshots(page);
    record(
      'P9.6 待看批量移出同样留快照，可在明细里找回',
      /手动移除的 2 条待看/.test(readingSnapshots.rows[0] ?? ''),
      `最新=${(readingSnapshots.rows[0] ?? '').slice(0, 120)}`
    );
  });

  // 每份快照都得先有一次真实的硬删除才会产生，所以这里连续做六轮「新建一条 → 彻底清空」。
  // 列表分页：条数一多就一直往下滚，既找不到位置，也说不清「看到第几条」。
  phase('P9.8 列表分页', async () => {
    const PAGE_URLS = Array.from({ length: 60 }, (_, index) => `https://page.example.com/p${index + 1}`);
    await goto(page, 'capture', '一次收下多个链接');
    await setReactInput(page, 'textarea[aria-label="粘贴链接"]', PAGE_URLS.join('\n'));
    await clickIn(page, '.panel', '预览链接 →');
    await waitPreview(page);
    await page.select('select[aria-label="保存目标"]', 'library');
    await sleep(700);
    await clickIn(page, '.batchbar', '确认写入');
    await waitForText(page, '导入完成', 60_000);
    await sleep(1000);

    // 批次明细也是列表：一批 60 条时同样按页看，而不是「再显示 20 条」。
    await goto(page, 'data', '数据在手里');
    await waitForText(page, '查看本批', 15_000);
    await clickIn(page, '', '查看本批');
    await sleep(900);
    const batchDetail = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('本批明细')
      );
      const rows = notice ? notice.querySelectorAll('.listbox .bookmark').length : 0;
      const pager = notice?.querySelector('.pager');
      return {
        rows,
        text: pager ? (pager.innerText ?? '').replace(/\s+/g, ' ').trim() : '',
        summary: notice ? (notice.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) : '',
      };
    });
    record(
      'P9.8 批次明细同样分页：60 条只渲染一页，不再「再显示 20 条」',
      batchDetail.rows === 50 &&
        /第 1 \/ 2 页/.test(batchDetail.text) &&
        /1–50 \/ 共 60 条/.test(batchDetail.text),
      `${batchDetail.rows} 行｜${batchDetail.text || batchDetail.summary}`
    );

    await goto(page, 'all', '全部收藏');
    await sleep(900);

    const readPager = () =>
      page.evaluate(() => {
        const node = document.querySelector('.pager');
        const rows = [...document.querySelectorAll('.listbox .bookmark')];
        return {
          text: node ? (node.innerText ?? '').replace(/\s+/g, ' ').trim() : '',
          rows: rows.length,
          head: (document.querySelector('.listbox .listhead')?.innerText ?? '').replace(/\s+/g, ' ').trim(),
          labels: rows.map((row) => row.querySelector('input[type="checkbox"]')?.getAttribute('aria-label') ?? ''),
        };
      });

    const totalAll = (await page.evaluate(readMainLibrary)).bookmarks.filter(
      (row) => row.lifeState === 'active'
    ).length;
    const expectedFirst = Math.min(50, totalAll);

    const firstPage = await readPager();
    record(
      'P9.8 列表按页显示：第一页 50 条，分页条写明页码与序号范围',
      firstPage.rows === expectedFirst &&
        /第 1 \/ \d+ 页/.test(firstPage.text) &&
        new RegExp(`1–${expectedFirst} / 共 ${totalAll} 条`).test(firstPage.text),
      `${firstPage.rows} 行｜总 ${totalAll}｜${firstPage.text}`
    );

    await clickIn(page, '.pager', '下一页');
    await sleep(600);
    const secondPage = await readPager();
    const expectedSecond = Math.max(0, Math.min(50, totalAll - 50));
    record(
      'P9.8 点「下一页」换到第二页，条数与序号都接得上',
      secondPage.rows === expectedSecond &&
        /第 2 \/ \d+ 页/.test(secondPage.text) &&
        new RegExp(`51–${50 + expectedSecond} / 共 ${totalAll} 条`).test(secondPage.text),
      `${secondPage.rows} 行｜${secondPage.text}`
    );

    // 勾选跨页保留：翻页只是看同一份列表的另一段，不该把已勾的丢掉；
    // 但提示必须点明「有几条不在这一页」，否则用户以为只处理屏幕上这些。
    await clickIn(page, '.toolbar', '批量选择');
    await sleep(400);
    const tickedOnSecond = await page.evaluate(() => {
      const box = document.querySelector('.listbox .bookmark input[type="checkbox"]');
      if (!box) return false;
      box.click();
      return true;
    });
    await sleep(400);
    await clickIn(page, '.pager', '上一页');
    await sleep(600);
    const crossPageCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('已选')
      );
      return notice ? (notice.innerText ?? '').replace(/\s+/g, ' ').trim() : '';
    });
    record(
      'P9.8 翻页不会丢掉勾选，并写明有几条不在这一页',
      tickedOnSecond && /已选 1 \//.test(crossPageCopy) && /其中 1 条在别的页/.test(crossPageCopy),
      crossPageCopy.slice(0, 160)
    );

    // 「只选本页」是跨页勾选的反面：想处理眼前这一屏时，别把别页的一起带上。
    // 先退出再进入批量选择，保证从「什么都没选」开始。
    await clickIn(page, '.toolbar', '退出批量选择');
    await sleep(300);
    await clickIn(page, '.toolbar', '批量选择');
    await sleep(400);
    await clickIn(page, '', `只选本页 ${firstPage.rows} 条`);
    await sleep(400);
    const pageOnlyCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('已选')
      );
      return notice ? (notice.innerText ?? '').replace(/\s+/g, ' ').trim() : '';
    });
    record(
      'P9.8 「只选本页」只勾当前页，不会把别页的带上',
      new RegExp(`已选 ${firstPage.rows} /`).test(pageOnlyCopy) && !/在别的页/.test(pageOnlyCopy),
      pageOnlyCopy.slice(0, 160)
    );

    // 改每页条数要重排：第 4 页在「一页 20 条」下已经不存在了，必须回到第一页。
    await clickIn(page, '.toolbar', '退出批量选择');
    await sleep(300);
    await page.select('select[aria-label="每页条数"]', '20');
    await sleep(700);
    const smallPage = await readPager();
    record(
      'P9.8 每页改成 20 条后每页 20 行，并回到第一页',
      smallPage.rows === Math.min(20, totalAll) &&
        /第 1 \/ \d+ 页/.test(smallPage.text) &&
        smallPage.text.includes('1–20 / 共'),
      `${smallPage.rows} 行｜${smallPage.text}`
    );

    // 回收站与待看用的是另一套渲染，分页条同样要出现（这里是回收站）。
    await goto(page, 'trash', '回收站');
    await sleep(800);
    const trashPager = await page.evaluate(() => {
      const node = document.querySelector('.pager');
      const countLine = [...document.querySelectorAll('.toolbar .micro')]
        .map((item) => (item.innerText ?? '').replace(/\s+/g, ' ').trim())
        .join(' ');
      const match = /共 (\d+) 条/.exec(countLine);
      return {
        text: node ? (node.innerText ?? '').replace(/\s+/g, ' ').trim() : '',
        total: match ? Number(match[1]) : 0,
        rows: document.querySelectorAll('.listbox .bookmark').length,
      };
    });
    // 回收站会随前面的恢复动作变空；规则是「超过一页才出现分页条」，两种情形都认。
    const trashPages = Math.max(1, Math.ceil(trashPager.total / 20));
    record(
      'P9.8 回收站列表同样分页：超过一页才出现分页条，单页不渲染多余控件',
      trashPager.rows === Math.min(20, trashPager.total) &&
        (trashPager.total > 20
          ? /第 1 \/ \d+ 页/.test(trashPager.text)
          : trashPager.text === ''),
      `${trashPager.rows} 行 / 共 ${trashPager.total} 条 / ${trashPages} 页｜${trashPager.text || '无分页条'}`
    );

    // 每页条数已经改成 20，后面的阶段沿用原来的行数预期，这里恢复默认 50。
    await goto(page, 'settings', '设置与管理');
    await clickIn(page, '', '50 条');
    await sleep(800);
  });

  phase('P9.7 回收站入口与清空后的找回入口', async () => {
    // 侧栏入口：删完东西第一反应是找回收站，它不能只藏在「设置与管理」里。
    await goto(page, 'all', '全部收藏');
    await sleep(500);
    const navTrash = await page.evaluate(() => {
      const nav = [...document.querySelectorAll('aside .nav')].find((node) =>
        (node.innerText ?? '').includes('回收站')
      );
      if (!nav) return null;
      const count = nav.querySelector('.count');
      return {
        text: (nav.innerText ?? '').replace(/\s+/g, ' ').trim(),
        count: (count?.textContent ?? '').trim(),
      };
    });
    const libraryBeforeNav = await page.evaluate(readMainLibrary);
    const trashedBeforeNav = libraryBeforeNav.bookmarks.filter((row) => row.lifeState === 'deleted').length;
    record(
      'P9.7 侧栏日常组直接有「回收站」入口，计数与库里回收站条数一致',
      Boolean(navTrash) && navTrash.count === String(trashedBeforeNav),
      `入口=${JSON.stringify(navTrash)}｜库里回收站=${trashedBeforeNav}`
    );

    await clickIn(page, 'aside', '回收站');
    await sleep(700);
    const trashRoute = await page.evaluate(() => ({
      hash: window.location.hash,
      heading: document.querySelector('h1')?.textContent ?? '',
      countLine: (document.querySelector('.toolbar .micro')?.textContent ?? '').trim(),
    }));
    record(
      'P9.7 点侧栏「回收站」直接进入回收站页',
      trashRoute.hash === '#trash' && /回收站/.test(trashRoute.heading),
      `hash=${trashRoute.hash}｜标题=${trashRoute.heading}｜${trashRoute.countLine}`
    );

    // 第二入口：彻底清空是硬删除，不进回收站，所以清完之后必须就地给出「去哪儿找回」。
    await goto(page, 'all', '全部收藏');
    await sleep(500);
    const beforeEntryPurge = await page.evaluate(readMainLibrary);
    await clickIn(page, '.toolbar', '彻底清空…');
    await waitForText(page, '确认彻底清空', 10_000);
    await clickIn(page, '', '确认清空');
    await sleep(1400);
    const purgeEntryCopy = await page.evaluate(() => {
      const notice = [...document.querySelectorAll('.notice')].find((node) =>
        (node.innerText ?? '').includes('去最近清理找回')
      );
      return notice ? (notice.innerText ?? '').replace(/\s+/g, ' ').trim() : '';
    });
    record(
      'P9.7 清空完成后页面留下「去最近清理找回」按钮，并写清不进回收站',
      /已删除 \d+ 条/.test(purgeEntryCopy) && /不进回收站/.test(purgeEntryCopy),
      `清空前 ${beforeEntryPurge.bookmarks.length} 条｜${purgeEntryCopy.slice(0, 160)}`
    );

    await clickIn(page, '', '去最近清理找回');
    await sleep(1800);
    const cleanupFocus = await page.evaluate(() => {
      const panel = document.querySelector('#recent-cleanup');
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return {
        hash: window.location.hash,
        top: Math.round(rect.top),
        inView: rect.top < window.innerHeight && rect.bottom > 0,
        snapshots: [...document.querySelectorAll('#recent-cleanup .bookmark h3')].length,
      };
    });
    record(
      'P9.7 点「去最近清理找回」进数据页并滚到「最近清理」区块',
      Boolean(cleanupFocus) &&
        cleanupFocus.hash === '#data:cleanup' &&
        cleanupFocus.inView &&
        cleanupFocus.snapshots > 0,
      JSON.stringify(cleanupFocus)
    );
  });

  phase('P9.9 最近清理的明细也分页 + 每页条数设置', async () => {
    // P9.7 刚把整库清空，最新一份快照就是那 60 条，正好用来验证明细分页。
    await goto(page, 'data:cleanup', '数据在手里');
    await waitForText(page, '看看能找回什么', 15_000);
    await clickIn(page, '', '看看能找回什么');
    await waitForText(page, '这次清理共', 15_000);
    await sleep(700);

    const readDetail = () =>
      page.evaluate(() => {
        const view = document.querySelector('#recent-cleanup .snapshotview');
        const notice = view?.querySelector('.notice');
        const match = /共 (\d+) 条/.exec(notice?.innerText ?? '');
        const pager = view?.querySelector('.pager');
        return {
          rows: view ? view.querySelectorAll('.snapentry').length : 0,
          total: match ? Number(match[1]) : 0,
          text: pager ? (pager.innerText ?? '').replace(/\s+/g, ' ').trim() : '',
        };
      });

    const firstPage = await readDetail();
    record(
      'P9.9 清理快照明细同样分页：60 条只渲染第一页，不再「再显示」',
      firstPage.total > 50 &&
        firstPage.rows === 50 &&
        /第 1 \/ \d+ 页/.test(firstPage.text) &&
        new RegExp(`1–50 / 共 ${firstPage.total} 条`).test(firstPage.text),
      `${firstPage.rows} 行 / 共 ${firstPage.total}｜${firstPage.text}`
    );

    await clickIn(page, '#recent-cleanup .snapshotview', '下一页');
    await sleep(600);
    const secondPage = await readDetail();
    record(
      'P9.9 清理明细可翻到第二页，序号接得上',
      secondPage.rows === Math.min(50, firstPage.total - 50) &&
        new RegExp(`51–${Math.min(100, firstPage.total)} / 共 ${firstPage.total} 条`).test(
          secondPage.text
        ),
      `${secondPage.rows} 行｜${secondPage.text}`
    );

    // 设置里手输 27：不是 20/50 的档位也要生效，证明是自由输入而不是写死的选项。
    await goto(page, 'settings', '设置与管理');
    await waitForText(page, '列表显示', 10_000);
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="每页条数设置"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('缺少每页条数输入框');
      // 先聚焦再 blur：未聚焦的元素调用 blur() 不触发 React 的 onBlur，值就不会提交。
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '27');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
    await sleep(1200);

    await goto(page, 'data:cleanup', '数据在手里');
    await waitForText(page, '看看能找回什么', 15_000);
    await clickIn(page, '', '看看能找回什么');
    await waitForText(page, '这次清理共', 15_000);
    await sleep(700);
    const customPage = await readDetail();
    record(
      'P9.9 设置里的每页条数对所有列表生效（改成 27 条后明细分页跟着变）',
      customPage.rows === 27 &&
        new RegExp(`1–27 / 共 ${customPage.total} 条`).test(customPage.text),
      `${customPage.rows} 行｜${customPage.text}`
    );

    // 收尾恢复默认，后面的阶段仍按 50 条一页的预期走。
    await goto(page, 'settings', '设置与管理');
    await clickIn(page, '', '50 条');
    await sleep(800);
  });

  phase('P9.3 从分类 / 未分类 / 待看页带入范围', async () => {
    // 先清空，保证这一阶段的数字只由它自己造出来，不受前面阶段残留影响。
    // 清空同时清墓碑，后面重新建同网址不会被「已删除」挡住。
    await goto(page, 'all', '全部收藏');
    const canPurgeAll = await page.evaluate(() =>
      [...document.querySelectorAll('.toolbar button')].some((node) =>
        (node.textContent ?? '').includes('彻底清空')
      )
    );
    if (canPurgeAll) {
      await clickIn(page, '.toolbar', '彻底清空…');
      await waitForText(page, '确认彻底清空', 10_000);
      await clickIn(page, '', '确认清空');
      await sleep(1200);
    }

    const scopeCat = await ensureCategory(page, '清理范围');
    if (!scopeCat) throw new Error('分类创建失败，按条件清理无法验证');

    await goto(page, 'all', '全部收藏');
    await createBookmark(page, { url: 'https://scope.example.com/a1', title: '范围 A1' });
    await createBookmark(page, { url: 'https://scope.example.com/a2', title: '范围 A2' });
    await createBookmark(page, { url: 'https://scope.example.com/b1', title: '范围 B1' });

    // 归入分类这一步走库：抽屉里点分类要额外处理未保存草稿，和这条断言无关。
    // 写完必须整页重载，否则 React 手里还是旧快照，分类页会显示 0 条。
    const movedIntoCategory = await page.evaluate(
      async ({ catId }) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction('bookmarks', 'readonly');
          const req = tx.objectStore('bookmarks').getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const targets = rows.filter((row) => row.originalUrl.startsWith('https://scope.example.com/a'));
        await new Promise((resolve, reject) => {
          const tx = db.transaction('bookmarks', 'readwrite');
          for (const row of targets) {
            row.categoryId = catId;
            row.categoryKey = catId;
            tx.objectStore('bookmarks').put(row);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
        return targets.length;
      },
      { catId: scopeCat }
    );
    record(
      'P9.3 预置：两条收藏归入「清理范围」，另一条留在未分类',
      movedIntoCategory === 2,
      `归入分类=${movedIntoCategory}`
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 25_000);
    await sleep(600);

    // 待看两条：待看页的范围是另一条独立路径，不能拿收藏的结论套。
    await goto(page, 'reading', '待看');
    for (const [url, title] of [
      ['https://scope.example.com/r1', '待看 R1'],
      ['https://scope.example.com/r2', '待看 R2'],
    ]) {
      await clickIn(page, '.heading', '添加待看');
      await waitForSelectorReady(page, '.modal input[placeholder="https://"]', 10_000);
      await setReactInput(page, '.modal input[placeholder="https://"]', url);
      await setReactInput(page, '.modal input[placeholder="给它一个容易想起的名字"]', title);
      await clickIn(page, '.modal', '加入待看');
      await waitForSelectorGone(page, '.modal input[placeholder="https://"]', 20_000);
      await sleep(500);
    }

    const readCleanupPanel = () =>
      page.evaluate(() => {
        const modal = document.querySelector('.modal.wide');
        return {
          scope: document.querySelector('select[aria-label="清理范围"]')?.value ?? '',
          hasPresence: Boolean(document.querySelector('select[aria-label="清理范围的三态"]')),
          text: (modal?.innerText ?? '').replace(/\s+/g, ' ').trim(),
        };
      });

    // ① 分类页：范围自动带入，命中数就是该分类的条数。
    await goto(page, `cat:${scopeCat}`, '清理范围');
    await clickIn(page, '.toolbar', '按条件清理…');
    await waitForSelectorReady(page, 'select[aria-label="清理范围"]', 10_000);
    await sleep(600);
    const fromCategory = await readCleanupPanel();
    record(
      'P9.3 分类页把自身范围带进清理面板，命中数与该分类一致',
      fromCategory.scope === `cat:${scopeCat}` &&
        /分类：清理范围共 2 条/.test(fromCategory.text) &&
        /可移入回收站 2 条/.test(fromCategory.text),
      `${fromCategory.scope}｜${fromCategory.text.slice(0, 180)}`
    );

    // ② 面板里改范围：切到未分类，命中数跟着变，而不是沿用上一段的数字。
    await page.select('select[aria-label="清理范围"]', 'uncategorized');
    await sleep(800);
    const fromUncategorized = await readCleanupPanel();
    record(
      'P9.3 面板里可以直接改范围，切到未分类后命中数跟着变',
      /未分类共 1 条/.test(fromUncategorized.text) &&
        /可移入回收站 1 条/.test(fromUncategorized.text),
      fromUncategorized.text.slice(0, 180)
    );

    // ③ 切回分类并彻底删除：留快照，范围写得清「哪个分类、什么动作」。
    await page.select('select[aria-label="清理范围"]', `cat:${scopeCat}`);
    await sleep(800);
    await clickIn(page, '.modal.wide', '彻底删除 2 条');
    await waitForText(page, '确认处理 2 条', 10_000);
    await sleep(300);
    const scopeConfirm = await page.evaluate(() =>
      (document.querySelector('.modal.wide')?.innerText ?? '').replace(/\s+/g, ' ').trim()
    );
    record(
      'P9.3 分类范围彻底删除的确认框写明动作与快照',
      /分类：清理范围 · 彻底删除/.test(scopeConfirm) && /清理快照/.test(scopeConfirm),
      scopeConfirm.slice(0, 200)
    );
    await clickIn(page, '.modal.wide', '确认处理 2 条');
    await waitForText(page, '已处理 2 条', 20_000);
    await sleep(900);
    await clickIn(page, '.modal.wide', '完成');
    await sleep(500);

    await goto(page, 'data', '最近清理');
    await sleep(900);
    const scopeSnapshots = await readPurgeSnapshots(page);
    record(
      'P9.3 清理快照记下「分类：清理范围 · 彻底删除」',
      /分类：清理范围 · 彻底删除/.test(scopeSnapshots.rows[0] ?? ''),
      `最新=${(scopeSnapshots.rows[0] ?? '').slice(0, 120)}`
    );

    // ④ 待看页：同一条路径、不同的范围；待看没有回收站，不该出现三态选择。
    await goto(page, 'reading', '待看');
    await sleep(600);
    await clickIn(page, '.toolbar', '按条件清理…');
    await waitForSelectorReady(page, 'select[aria-label="清理范围"]', 10_000);
    await sleep(600);
    const fromReading = await readCleanupPanel();
    record(
      'P9.3 待看页带入待看范围，没有回收站三态，动作是「从待看移除」',
      fromReading.scope === 'reading' &&
        !fromReading.hasPresence &&
        /待看共 2 条/.test(fromReading.text) &&
        /从待看移除 2 条/.test(fromReading.text),
      `${fromReading.scope}｜三态=${fromReading.hasPresence}｜${fromReading.text.slice(0, 180)}`
    );

    await clickIn(page, '.modal.wide', '从待看移除 2 条');
    await waitForText(page, '确认处理 2 条', 10_000);
    await clickIn(page, '.modal.wide', '确认处理 2 条');
    await waitForText(page, '已处理 2 条', 20_000);
    await sleep(900);
    await clickIn(page, '.modal.wide', '完成');
    await sleep(600);
    const afterScopeReading = await page.evaluate(readMainLibrary);
    record(
      'P9.3 待看按条件移除后队列准确减少，收藏不受影响',
      afterScopeReading.readings.filter((row) => row.status === 'pending').length === 0 &&
        afterScopeReading.bookmarks.filter((row) => row.lifeState === 'active').length === 1,
      `待看=${
        afterScopeReading.readings.filter((row) => row.status === 'pending').length
      }｜在库=${afterScopeReading.bookmarks.filter((row) => row.lifeState === 'active').length}`
    );

    await goto(page, 'data', '最近清理');
    await sleep(800);
    const readingSnapshots = await readPurgeSnapshots(page);
    record(
      'P9.3 待看按条件移除同样留快照，范围写成「待看 · 彻底删除」',
      /待看 · 彻底删除/.test(readingSnapshots.rows[0] ?? ''),
      `最新=${(readingSnapshots.rows[0] ?? '').slice(0, 120)}`
    );
  });

  phase('P9.4 清理快照只保留最近 5 份', async () => {
    await goto(page, 'data', '最近清理');
    await waitForText(page, '看看能找回什么', 15_000);
    const beforeEvict = await readPurgeSnapshots(page);
    for (let round = 0; round < 6; round += 1) {
      await createBookmark(page, {
        url: `https://example.com/p9-evict-${round}`,
        title: `第 ${round + 1} 轮清理`,
      });
      await goto(page, 'all', '全部收藏');
      await clickIn(page, '.toolbar', '彻底清空…');
      await waitForText(page, '确认彻底清空', 10_000);
      await clickIn(page, '', '确认清空');
      await sleep(900);
    }
    await goto(page, 'data', '最近清理');
    await sleep(400);
    const afterEvict = await readPurgeSnapshots(page);
    report.counts.purgeEviction = { before: beforeEvict.count, after: afterEvict.count, latest: afterEvict.rows[0] ?? '' };
    record(
      'P9.4 清理快照只保留最近 5 份，超出时挤掉最旧的',
      afterEvict.count === 5 && beforeEvict.count + 6 > 5,
      `淘汰前=${beforeEvict.count} 条｜连做 6 轮后=${afterEvict.count} 条｜最新=${afterEvict.rows[0] ?? '无'}`
    );
  });

  try {
    for (const item of phases) {
      try {
        await item.fn();
      } catch (error) {
        record(`${item.label} 中断`, false, errorText(error));
      }
    }
    record('页面脚本错误检查', errors.length === 0, `errors=${JSON.stringify(errors)}`);

    // ---- P9.4 关掉浏览器、用同一个 profile 重开：快照必须还在，扩展 ID 必须不变 ----
    const beforeRestart = await readPurgeSnapshots(page).catch(() => ({ count: -1, rows: [] }));
    try {
      await browser.close();
      const second = await launchBestEffort(target, profileDir, limitations);
      browser = second.browser;
      const reopened = await browser.newPage();
      const reopenedErrors = [];
      reopened.on('pageerror', (error) => reopenedErrors.push(String(error)));
      await reopened.setViewport({ width: 1280, height: 900 });
      await reopened.goto(`chrome-extension://${second.extId}/workspace.html#data`, {
        waitUntil: 'domcontentloaded',
      });
      await waitForSelectorReady(reopened, '.brand-mark', 25_000);
      await waitForText(reopened, '最近清理', 15_000);
      await sleep(600);
      const afterRestart = await readPurgeSnapshots(reopened);
      const idStable = second.extId === extId;
      report.counts.purgeAfterRestart = {
        before: beforeRestart.count,
        after: afterRestart.count,
        extensionIdStable: idStable,
      };
      record(
        'P9.4 关掉浏览器重开后「最近清理」仍在，扩展 ID 不变',
        beforeRestart.count > 0 &&
          afterRestart.count === beforeRestart.count &&
          idStable &&
          reopenedErrors.length === 0,
        `重启前=${beforeRestart.count} 条｜重启后=${afterRestart.count} 条｜扩展 ID ${
          idStable ? '不变' : `变了（${extId}→${second.extId}）`
        }｜errors=${reopenedErrors.length}`
      );
      await reopened.close();
    } catch (error) {
      record('P9.4 关掉浏览器重开后「最近清理」仍在，扩展 ID 不变', false, errorText(error));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  report.ok = steps.every((step) => step.ok);
  const rel = writeReport(OUT_DIR, 'p3-browser-verification.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
