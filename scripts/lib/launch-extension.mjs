/**
 * 浏览器验证脚本共用的启动与页面操作工具。
 *
 * Chrome 137+ 移除了 `--load-extension`，因此按浏览器选择加载策略：
 * - cdp：`--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`
 * - flag：`--load-extension` + `--disable-extensions-except`（Edge / 旧版 Chrome）
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DIST = path.join(ROOT, 'apps', 'extension', 'dist');

/**
 * 浏览器可执行文件按「环境变量 → 常见安装路径」的顺序解析，避免换机器后脚本失效。
 * 换平台或装在非默认位置时，设置 SHIYE_CHROME / SHIYE_EDGE 指向可执行文件即可。
 */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
];

function resolveExecutable(envValue, candidates) {
  if (envValue) return envValue;
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function detectBrowsers() {
  const found = [];
  const chrome = resolveExecutable(process.env.SHIYE_CHROME, CHROME_CANDIDATES);
  const edge = resolveExecutable(process.env.SHIYE_EDGE, EDGE_CANDIDATES);
  if (chrome) found.push({ name: 'Chrome', executablePath: chrome });
  if (edge) found.push({ name: 'Edge', executablePath: edge });
  return found;
}

/**
 * `strategy` 是首选策略提示；实际加载方式由 launchBestEffort 逐个尝试后确定，
 * 因为 Chrome 137+ 移除了 `--load-extension`，而 Edge 仍支持，写死任一种都会在另一侧失败。
 */
export const BROWSERS = detectBrowsers().map((browser) => ({
  ...browser,
  strategy: browser.name === 'Chrome' ? 'cdp' : 'flag',
}));

if (BROWSERS.length === 0) {
  console.warn(
    '未找到 Chrome 或 Edge。请安装其中之一，或用 SHIYE_CHROME / SHIYE_EDGE 指定可执行文件路径后再运行浏览器验证。'
  );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 准备一个干净的 profile 目录。上一轮遗留的 profile 可能被系统占用而无法删除，
 * 此时退回带时间戳的新目录，保证「重启沿用同一 profile」这一验证前提成立。
 */
export function prepareProfile(baseDir, name) {
  const base = path.join(baseDir, `p0-profile-${name.toLowerCase()}`);
  if (!fs.existsSync(base)) return base;
  try {
    fs.rmSync(base, { recursive: true, force: true, retries: 3 });
    if (!fs.existsSync(base)) return base;
  } catch {
    // 落到下面的时间戳目录
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function launchWithExtension(target, profileDir, headless, strategy, extraArgs = []) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    ...extraArgs,
  ];
  if (strategy === 'cdp') {
    args.push('--enable-unsafe-extension-debugging');
  } else {
    args.push(
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch'
    );
  }

  const browser = await puppeteer.launch({
    executablePath: target.executablePath,
    headless,
    userDataDir: profileDir,
    args,
    ignoreDefaultArgs: ['--disable-extensions'],
    protocolTimeout: 90_000,
  });

  let extId = null;
  let idSource = null;
  if (strategy === 'cdp') {
    const client = await browser.target().createCDPSession();
    try {
      const result = await client.send('Extensions.loadUnpacked', { path: DIST });
      extId = result.id ?? null;
      idSource = 'CDP Extensions.loadUnpacked';
    } catch (error) {
      extId = null;
    }
  }
  if (!extId) {
    try {
      const swTarget = await browser.waitForTarget(
        (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
        { timeout: 12_000 }
      );
      extId = new URL(swTarget.url()).host;
      idSource = 'service_worker target';
    } catch {
      extId = null;
    }
  }
  return { browser, extId, idSource };
}

/**
 * 依次尝试加载策略（命令行参数 / CDP）与有头无头，第一个拿到扩展 ID 的组合即采用。
 *
 * 不写死策略：Chrome 137+ 不再支持 `--load-extension`，Edge 仍支持，
 * 而 CDP 的 `Extensions.loadUnpacked` 只在带 `--enable-unsafe-extension-debugging` 时可用。
 *
 * 默认先试无头（快、不需要桌面）。设 `SHIYE_HEADED=1` 可强制先开有界面窗口，
 * 用于人工观察自动化在页面里到底点了什么。
 */
export async function launchBestEffort(target, profileDir, limitations) {
  let lastError = null;
  const preferred = target.strategy === 'flag' ? 'flag' : 'cdp';
  const strategies = preferred === 'flag' ? ['flag', 'cdp'] : ['cdp', 'flag'];
  const headlessModes = process.env.SHIYE_HEADED === '1' ? [false, true] : [true, false];

  for (const strategy of strategies) {
    for (const headless of headlessModes) {
      const label = `${strategy === 'cdp' ? 'CDP 加载' : '命令行加载'}·${headless ? '无头' : '有界面'}`;
      try {
        const result = await launchWithExtension(target, profileDir, headless, strategy);
        if (result.extId) return { ...result, headless, strategy };
        limitations?.push(`${label}模式下未获得扩展 ID。`);
        await result.browser.close();
      } catch (error) {
        lastError = error;
        limitations?.push(
          `${label}模式启动失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  throw lastError ?? new Error('所有加载策略均未获得扩展 ID');
}

export async function clickByText(page, text) {
  const clicked = await page.evaluate((needle) => {
    const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
    const hit = nodes.find((node) => (node.textContent ?? '').trim().includes(needle));
    if (!hit) return false;
    hit.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`未找到可点击元素：${text}`);
}

/**
 * 等待页面出现某段文本。
 *
 * 用 Node 侧轮询 + `page.evaluate`，而不是 `page.waitForFunction`：
 * 后者默认按 requestAnimationFrame 轮询，多个标签页时后台页的 rAF 会被节流甚至暂停，
 * 导致提示条（几秒后自动消失）明明出现过却始终等不到。
 */
export async function waitForText(page, text, timeout = 15_000, interval = 150) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    last = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    if (last.includes(text)) return;
    await sleep(interval);
  }
  throw new Error(`等待文本超时：${text}（页面片段：${last.replace(/\s+/g, ' ').slice(0, 160)}）`);
}

/** 同理，用 Node 侧轮询等待元素出现/消失。 */
export async function waitForSelectorReady(page, selector, timeout = 15_000, interval = 150) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate((sel) => Boolean(document.querySelector(sel)), selector).catch(() => false);
    if (found) return;
    await sleep(interval);
  }
  throw new Error(`等待元素超时：${selector}`);
}

export async function waitForSelectorGone(page, selector, timeout = 15_000, interval = 150) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await page.evaluate((sel) => Boolean(document.querySelector(sel)), selector).catch(() => true);
    if (!found) return;
    await sleep(interval);
  }
  throw new Error(`元素未消失：${selector}`);
}

/** 直接设值并派发 input 事件，避免 React 受控组件不响应直接赋值。 */
export function setReactInput(page, selector, value) {
  return page.evaluate(
    (sel, val) => {
      const input = document.querySelector(sel);
      if (!input) throw new Error(`缺少输入框：${sel}`);
      const proto =
        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    value
  );
}

/** 在扩展页面 / worker 上下文中直接读主库（只用原生 IndexedDB，不依赖应用代码）。 */
export function readMainLibrary() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shiye');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const stores = [...db.objectStoreNames];
      if (!stores.includes('bookmarks')) {
        resolve({ version: db.version, stores, bookmarks: [], readings: [] });
        db.close();
        return;
      }
      const hasReading = stores.includes('readingItems');
      const names = hasReading ? ['bookmarks', 'readingItems'] : ['bookmarks'];
      const tx = db.transaction(names, 'readonly');
      const bookmarksReq = tx.objectStore('bookmarks').getAll();
      const readingsReq = hasReading ? tx.objectStore('readingItems').getAll() : null;
      tx.oncomplete = () => {
        resolve({
          version: db.version,
          stores,
          bookmarks: bookmarksReq.result.map((row) => ({
            id: row.id,
            title: row.title,
            originalUrl: row.originalUrl,
            canonicalUrl: row.canonicalUrl,
            lifeState: row.lifeState,
            unreadFlag: row.unreadFlag,
            localRevision: row.localRevision,
            categoryId: row.categoryId,
            localOnly: row.privacy?.localOnly ?? false,
            aiBlocked: row.privacy?.aiBlocked === true,
            pinned: row.pinned === true,
            note: row.note,
            sourceDescription: row.sourceDescription ?? '',
            selectedText: row.selectedText ?? '',
            tagIds: Array.isArray(row.tagIds) ? [...row.tagIds] : [],
            lockedFields: Array.isArray(row.lockedFields) ? [...row.lockedFields] : [],
            lastOpenedAt: row.lastOpenedAt ?? null,
          })),
          readings: (readingsReq?.result ?? []).map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
            originalUrl: row.originalUrl,
          })),
        });
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** 读分类表（原生 IndexedDB，便于断言导入后的分类归属）。 */
export function readCategories() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shiye');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('categories')) {
        resolve([]);
        db.close();
        return;
      }
      const tx = db.transaction(['categories'], 'readonly');
      const req = tx.objectStore('categories').getAll();
      tx.oncomplete = () => {
        resolve(req.result.map((row) => ({ id: row.id, name: row.name })));
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** 读导入批次表，便于断言「批次与结果可核对」。 */
export function readImportBatches() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('shiye');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('importBatches')) {
        resolve([]);
        db.close();
        return;
      }
      const tx = db.transaction(['importBatches'], 'readonly');
      const req = tx.objectStore('importBatches').getAll();
      tx.oncomplete = () => {
        resolve(
          req.result.map((row) => ({
            id: row.id,
            source: row.source,
            fileName: row.fileName,
            destination: row.destination,
            status: row.status,
            total: row.total,
            inserted: row.inserted,
            skipped: row.skipped,
            invalid: row.invalid,
          }))
        );
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function findServiceWorker(browser, extId) {  return browser
    .targets()
    .find((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`));
}

export function writeReport(dir, fileName, report) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return path.relative(ROOT, file);
}
