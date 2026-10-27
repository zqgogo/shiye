/**
 * P0.2 / P0.3 真实浏览器验证脚本。
 *
 * 验证目标（对应 docs/ROADMAP.md）：
 * - P0.2：最小 MV3 扩展的 popup、service worker 与工作台页面在同一个扩展 origin
 *   访问同一个 IndexedDB 主库；记录浏览器版本、加载方式、主库物理位置。
 * - P0.3：写入脱敏样例后关闭并重开浏览器（沿用同一 user-data-dir）再读取，验证持久化。
 *
 * 浏览器加载策略见 scripts/lib/launch-extension.mjs。
 * 不做的事：不访问网络、不写入真实用户数据、不修改仓库源码。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSERS,
  DIST,
  ROOT,
  clickByText,
  findServiceWorker,
  launchBestEffort,
  launchWithExtension,
  prepareProfile,
  readMainLibrary,
  setReactInput,
  sleep,
  waitForText,
  writeReport,
} from './lib/launch-extension.mjs';

const VERIFY_DIR = path.join(ROOT, '.verify');
const OUT_DIR = path.join(ROOT, 'docs', 'verification');

const BOOKMARK_URL = 'https://example.com/shiye-p0-bookmark';
const BOOKMARK_TITLE = 'P0 验证·工作台写入';
const POPUP_URL = 'https://example.com/shiye-p0-popup';
const POPUP_TITLE = 'P0 验证·弹窗写入';

/** 走完一个浏览器的完整验证流程，返回该浏览器的报告。 */
async function verifyBrowser(target) {
  const steps = [];
  const report = {
    name: target.name,
    executablePath: target.executablePath,
    strategy: target.strategy,
    version: null,
    headless: null,
    extensionId: null,
    extensionIdSource: null,
    physicalDbPath: null,
    counts: {},
    limitations: [],
    steps,
  };
  const record = (step, ok, detail) => {
    steps.push({ step, ok, detail: detail ?? '' });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
  };

  const profileDir = prepareProfile(VERIFY_DIR, target.name);

  // ---- 启动（先无头，失败退回有界面）----
  let attempt = null;
  try {
    attempt = await launchBestEffort(target, profileDir, report.limitations);
  } catch (error) {
    record('启动浏览器并加载扩展', false, String(error));
    report.ok = false;
    return report;
  }

  let { browser } = attempt;
  report.headless = attempt.headless;
  report.extensionId = attempt.extId;
  report.extensionIdSource = attempt.idSource;
  report.strategy = attempt.strategy;
  report.version = await browser.version();
  record(
    '启动浏览器并加载扩展',
    true,
    `${report.version}｜模式=${attempt.headless ? 'headless' : 'headful'}｜策略=${attempt.strategy}｜id=${attempt.extId}（${attempt.idSource}）`
  );

  const base = `chrome-extension://${attempt.extId}`;

  try {
    // ---- 1. 工作台 ----
    const workspace = await browser.newPage();
    const errorsA = [];
    workspace.on('pageerror', (error) => errorsA.push(String(error)));
    await workspace.goto(`${base}/workspace.html#home`, { waitUntil: 'domcontentloaded' });
    await workspace.waitForSelector('.brand-mark', { timeout: 25_000 });
    const bootText = await workspace.evaluate(() => document.body.innerText);
    if (bootText.includes('主库无法打开')) throw new Error('工作台显示主库无法打开');
    record('工作台加载', true, 'workspace.html 渲染出侧栏与首页');

    // ---- 2. 工作台 UI 新建收藏 ----
    await clickByText(workspace, '收藏链接');
    await workspace.waitForSelector('input[placeholder="https://"]', { timeout: 10_000 });
    await setReactInput(workspace, 'input[placeholder="https://"]', BOOKMARK_URL);
    await setReactInput(workspace, 'input[placeholder="给它一个容易找回的名字"]', BOOKMARK_TITLE);
    await clickByText(workspace, '保存到收件箱');
    await workspace.waitForFunction(() => !document.querySelector('input[placeholder="https://"]'), {
      timeout: 20_000,
    });
    record('工作台写入收藏', true, `创建「${BOOKMARK_TITLE}」`);

    const fromWorkspace = await workspace.evaluate(readMainLibrary);
    record(
      '工作台读取主库',
      fromWorkspace.bookmarks.some((row) => row.title === BOOKMARK_TITLE),
      `dbVersion=${fromWorkspace.version}｜stores=${fromWorkspace.stores.length}｜bookmarks=${fromWorkspace.bookmarks.length}`
    );

    // ---- 3. popup（作为普通标签页打开，手动填网址）----
    const popup = await browser.newPage();
    const errorsB = [];
    popup.on('pageerror', (error) => errorsB.push(String(error)));
    await popup.goto(`${base}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popup.waitForSelector('.popupframe', { timeout: 25_000 });
    record('popup 加载', true, 'popup.html 渲染出收藏表单');

    const popupSees = await popup.evaluate(readMainLibrary);
    record(
      'popup 读到工作台刚写入的收藏',
      popupSees.bookmarks.some((row) => row.title === BOOKMARK_TITLE),
      `popup 侧 bookmarks=${popupSees.bookmarks.length}｜dbVersion=${popupSees.version}`
    );

    // 工作台切到「全部收藏」，此后保持打开不刷新。
    await workspace.evaluate(() => {
      window.location.hash = 'all';
    });
    await waitForText(workspace, BOOKMARK_TITLE);
    record('工作台切到全部收藏', true, '列表包含工作台刚写入的记录');

    await setReactInput(popup, 'input[placeholder="https://"]', POPUP_URL);
    await setReactInput(popup, 'input[placeholder="给它一个容易找回的名字"]', POPUP_TITLE);
    await clickByText(popup, '保存收藏');
    await waitForText(popup, '已保存到收件箱');
    record('popup 写入收藏', true, `创建「${POPUP_TITLE}」`);

    const popupAfter = await popup.evaluate(readMainLibrary);
    record(
      'popup 写入落在同一主库',
      popupAfter.bookmarks.some((row) => row.title === POPUP_TITLE),
      `popup 侧 bookmarks=${popupAfter.bookmarks.length}`
    );

    // 跨上下文同步：工作台未刷新也应看到弹窗写入。
    let liveSync = true;
    try {
      await waitForText(workspace, POPUP_TITLE, 8000);
    } catch {
      liveSync = false;
    }
    record(
      '弹窗写入后已打开的工作台自动更新',
      liveSync,
      liveSync ? '无需手动刷新，列表出现弹窗写入的记录' : '工作台仍显示旧快照（需手动刷新）'
    );

    // ---- 4. service worker 读同一主库（先用 PING 唤醒 worker）----
    const ping = await workspace.evaluate(async () => {
      try {
        return await chrome.runtime.sendMessage({ type: 'PING' });
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    });
    await sleep(800);
    let swTarget = await findServiceWorker(browser, attempt.extId);
    if (!swTarget) {
      await sleep(2000);
      swTarget = await findServiceWorker(browser, attempt.extId);
    }
    if (swTarget) {
      const worker = await swTarget.worker();
      const swResult = await worker.evaluate(readMainLibrary);
      const titles = swResult.bookmarks.map((row) => row.title);
      record(
        'service worker 读到同一主库',
        titles.includes(BOOKMARK_TITLE) && titles.includes(POPUP_TITLE),
        `worker 侧 bookmarks=${swResult.bookmarks.length}｜dbVersion=${swResult.version}｜PING=${JSON.stringify(ping)}`
      );
    } else {
      const targets = browser
        .targets()
        .map((t) => `${t.type()}:${t.url()}`)
        .join(' , ');
      record('service worker 读到同一主库', false, `未找到 worker target（现有 targets：${targets}）`);
    }

    // ---- 5. 真正重新加载工作台后仍可见两条记录 ----
    await workspace.reload({ waitUntil: 'domcontentloaded' });
    await workspace.waitForSelector('.brand-mark', { timeout: 25_000 });
    const listText = await workspace.evaluate(() => document.body.innerText);
    record(
      '工作台重新加载后可见两条记录',
      listText.includes(BOOKMARK_TITLE) && listText.includes(POPUP_TITLE),
      '全部收藏列表同时包含工作台与 popup 写入的记录'
    );

    const beforeClose = await workspace.evaluate(readMainLibrary);
    report.counts.beforeClose = beforeClose.bookmarks.length;
    record(
      '页面脚本错误检查（会话 A）',
      errorsA.length === 0 && errorsB.length === 0,
      `errors=${JSON.stringify([...errorsA, ...errorsB])}`
    );

    await sleep(1500);
  } finally {
    await browser.close().catch(() => {});
  }

  // ---- 6. 主库物理位置 ----
  const idbDir = path.join(profileDir, 'Default', 'IndexedDB');
  let dbPath = null;
  if (fs.existsSync(idbDir)) {
    const dirs = fs.readdirSync(idbDir).filter((name) => name.startsWith('chrome-extension_'));
    const mine = dirs.find((name) => name.includes(attempt.extId));
    if (mine) dbPath = path.join(idbDir, mine);
  }
  report.physicalDbPath = dbPath ? path.relative(ROOT, dbPath) : '未找到（可能延迟落盘）';
  record('定位主库文件', Boolean(dbPath), report.physicalDbPath);

  // ---- 7. 重启（P0.3）----
  let second = null;
  try {
    second = await launchWithExtension(target, profileDir, attempt.headless, attempt.strategy);
  } catch (error) {
    record('重启浏览器', false, `重启失败：${String(error)}`);
    report.ok = false;
    return report;
  }
  if (!second.extId) {
    record('重启浏览器', false, '重启后未获得扩展 ID');
    await second.browser.close().catch(() => {});
    report.ok = false;
    return report;
  }
  browser = second.browser;
  record('重启后扩展 ID 稳定', second.extId === attempt.extId, `重启前=${attempt.extId}｜重启后=${second.extId}`);

  try {
    const page = await browser.newPage();
    const errorsC = [];
    page.on('pageerror', (error) => errorsC.push(String(error)));
    await page.goto(`${base}/workspace.html#all`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.brand-mark', { timeout: 25_000 });
    const persisted = await page.evaluate(readMainLibrary);
    const titles = persisted.bookmarks.map((row) => row.title);
    report.counts.afterRestart = persisted.bookmarks.length;
    record(
      '重启后主库数据仍在',
      titles.includes(BOOKMARK_TITLE) && titles.includes(POPUP_TITLE),
      `bookmarks=${persisted.bookmarks.length}：${titles.join(' / ')}`
    );
    const listText = await page.evaluate(() => document.body.innerText);
    record(
      '重启后工作台列表渲染出记录',
      listText.includes(BOOKMARK_TITLE) && listText.includes(POPUP_TITLE),
      '全部收藏列表包含两条脱敏样例'
    );

    await page.evaluate(async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'PING' });
      } catch {
        /* worker 唤醒失败不影响持久化结论 */
      }
    });
    await sleep(1200);
    const swTargetB = await findServiceWorker(browser, attempt.extId);
    if (swTargetB) {
      const workerB = await swTargetB.worker();
      const swResultB = await workerB.evaluate(readMainLibrary);
      record(
        '重启后 service worker 仍读到同一主库',
        swResultB.bookmarks.some((row) => row.title === BOOKMARK_TITLE),
        `worker 侧 bookmarks=${swResultB.bookmarks.length}`
      );
    } else {
      record('重启后 service worker 仍读到同一主库', false, '未找到 worker target');
      report.limitations.push('重启后未能在 CDP 中获取 worker target（MV3 空闲休眠属预期行为）。');
    }
    record('页面脚本错误检查（会话 B）', errorsC.length === 0, `errors=${JSON.stringify(errorsC)}`);
  } finally {
    await browser.close().catch(() => {});
  }

  report.ok = steps.every((step) => step.ok);
  return report;
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  const only = process.env.P0_BROWSER?.toLowerCase();
  const targets = only ? BROWSERS.filter((b) => b.name.toLowerCase() === only) : BROWSERS;
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));

  const result = {
    generatedAt: new Date().toISOString(),
    extension: {
      manifestVersion: manifest.manifest_version,
      distPath: path.relative(ROOT, DIST),
      permissions: manifest.permissions,
      optionalHostPermissions: manifest.optional_host_permissions,
    },
    browsers: [],
  };

  for (const target of targets) {
    console.log(`\n=== ${target.name} ===`);
    result.browsers.push(await verifyBrowser(target));
  }

  result.ok = result.browsers.every((b) => b.ok);
  const rel = writeReport(OUT_DIR, 'p0-browser-verification.json', result);
  console.log(`\n汇总：${result.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
