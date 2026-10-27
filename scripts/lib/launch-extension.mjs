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

export const BROWSERS = [
  {
    name: 'Chrome',
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    strategy: 'cdp',
  },
  {
    name: 'Edge',
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    strategy: 'flag',
  },
];

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

export async function launchWithExtension(target, profileDir, headless, extraArgs = []) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
    ...extraArgs,
  ];
  if (target.strategy === 'cdp') {
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
  if (target.strategy === 'cdp') {
    const client = await browser.target().createCDPSession();
    const result = await client.send('Extensions.loadUnpacked', { path: DIST });
    extId = result.id ?? null;
    idSource = 'CDP Extensions.loadUnpacked';
  }
  if (!extId) {
    try {
      const swTarget = await browser.waitForTarget(
        (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
        { timeout: 20_000 }
      );
      extId = new URL(swTarget.url()).host;
      idSource = 'service_worker target';
    } catch {
      extId = null;
    }
  }
  return { browser, extId, idSource };
}

/** 先无头、失败退回有界面；两种模式都失败时抛错。 */
export async function launchBestEffort(target, profileDir, limitations) {
  let lastError = null;
  for (const headless of [true, false]) {
    try {
      const result = await launchWithExtension(target, profileDir, headless);
      if (result.extId) return { ...result, headless };
      limitations?.push(`${headless ? '无头' : '有界面'}模式下未获得扩展 ID。`);
      await result.browser.close();
    } catch (error) {
      lastError = error;
      limitations?.push(
        `${headless ? '无头' : '有界面'}模式启动失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw lastError ?? new Error('两种启动模式均未获得扩展 ID');
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
            note: row.note,
          })),
          readings: (readingsReq?.result ?? []).map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
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
