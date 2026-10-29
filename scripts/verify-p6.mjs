/**
 * P6 浏览器验证：备份、恢复与手机快照。
 *
 * 对应 docs/ROADMAP.md：
 * - P6.1 备份：从一致的逻辑快照导出完整 JSON，含待看状态、收藏、分类、标签、设置、策略与墓碑，排除凭据；
 * - P6.2 恢复：先预览再选合并/替换；替换前自动备份并展示时间与数量；未知新版拒绝；恢复后数据深度一致；
 * - P6.3 手机只读快照：只导出允许展示的正式收藏，分类与关键词组合筛选，过滤私密与删除，安全渲染；
 * - P6.5 导出隐私与主库身份：本地专用须明确勾选，快照默认排除；替换导致的主库身份切换与旧 AI 映射失效要提示。
 *
 * P6.4（真机打开快照）无法在自动化里完成：本轮把快照另存到
 * `.verify/artifacts/p6-snapshot-mobile.html`，供人工传到手机上打开，报告里如实标注未验证。
 *
 * 导出走浏览器真实下载：用 CDP 的 Browser.setDownloadBehavior 指定目录，再读磁盘上的文件，
 * 断言的是用户真正拿到的那份 JSON / HTML，而不是内存里的字符串。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSERS,
  DIST,
  ROOT,
  launchBestEffort,
  prepareProfile,
  setReactInput,
  sleep,
  waitForSelectorReady,
  waitForText,
  writeReport,
} from './lib/launch-extension.mjs';

const VERIFY_DIR = path.join(ROOT, '.verify');
const OUT_DIR = path.join(VERIFY_DIR, 'reports');
const DOWNLOAD_DIR = path.join(VERIFY_DIR, 'downloads-p6');
const FIXTURE_DIR = path.join(VERIFY_DIR, 'fixtures-p6');
const ARTIFACT_DIR = path.join(VERIFY_DIR, 'artifacts');

const T_TEMPLATE = 'P6 模板收藏';
const T_NORMAL = 'P6 普通收藏';
const T_LOCAL_ONLY = 'P6 本地专用';
const T_AI_BLOCKED = 'P6 禁止AI';
const T_DELETED = 'P6 已删除';
const NOTE = '人工备注 P6';
const SELECTED_TEXT = '选中文字 P6';
const CATEGORY_NAME = 'P6 研究分类';
const NEW_LIBRARY_ID = 'p6-library-restored';

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail: detail ?? '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
};

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 240);
}

/** 在若干容器里点一个按钮：一页常有多块 panel，只取第一个会漏。 */
async function clickIn(page, container, text) {
  const ok = await page.evaluate(
    (sel, needle) => {
      const scopes = sel ? [...document.querySelectorAll(sel)] : [document.body];
      if (scopes.length === 0) return false;
      const nodes = scopes.flatMap((scope) => [...scope.querySelectorAll('button, a, [role="button"]')]);
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

/** 勾选或取消「按文本找到的那一行」复选框。 */
async function toggleCheckbox(page, labelText) {
  const ok = await page.evaluate((needle) => {
    const labels = [...document.querySelectorAll('label.checkline')];
    const hit = labels.find((label) => (label.innerText ?? '').includes(needle));
    const box = hit?.querySelector('input[type="checkbox"]');
    if (!box) return false;
    box.click();
    return true;
  }, labelText);
  if (!ok) throw new Error(`未找到复选框：${labelText}`);
  await sleep(250);
}

function goto(page, route, expectText) {
  return page
    .evaluate((next) => {
      window.location.hash = next;
    }, route)
    .then(() => (expectText ? waitForText(page, expectText, 15_000) : sleep(400)));
}

/** 整页重新加载：只有 hash 不同属同文档跳转，React 不会重挂载。 */
async function reloadWorkspace(page, base, hash = 'data') {
  const url = `${base}/workspace.html#${hash}`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      if (attempt === 9) throw error;
      await sleep(300);
    }
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSelectorReady(page, '.brand-mark', 25_000);
  await sleep(700);
}

function readStores(page, names) {
  return page.evaluate(
    (list) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(list, 'readonly');
          const out = {};
          for (const name of list) {
            const all = tx.objectStore(name).getAll();
            all.onsuccess = () => {
              out[name] = all.result;
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    names
  );
}

/** 以库里第一条真实收藏为模板复制样本，派生键一并算好。 */
function seedSamples(page, rows) {
  return page.evaluate(
    (samples) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('bookmarks', 'readonly').objectStore('bookmarks').getAll();
          read.onsuccess = () => {
            const template = read.result[0];
            if (!template) {
              db.close();
              reject(new Error('需要先有一条真实收藏作为字段模板'));
              return;
            }
            const now = new Date().toISOString();
            const tx = db.transaction('bookmarks', 'readwrite');
            const store = tx.objectStore('bookmarks');
            const created = {};
            for (const sample of samples) {
              const id = crypto.randomUUID();
              created[sample.title] = id;
              store.put({
                ...template,
                id,
                originalUrl: sample.url,
                canonicalUrl: sample.url,
                title: sample.title,
                sourceDescription: sample.description ?? '',
                aiPurpose: '',
                note: sample.note ?? '',
                selectedText: sample.selectedText ?? '',
                categoryId: null,
                categoryKey: 'uncategorized',
                tagIds: [],
                inboxUnread: true,
                unreadFlag: 1,
                pinned: false,
                lastOpenedAt: null,
                lifeState: sample.deleted === true ? 'deleted' : 'active',
                deletedAt: sample.deleted === true ? now : null,
                lockedFields: [],
                privacy: {
                  ...template.privacy,
                  localOnly: sample.localOnly === true,
                  aiBlocked: sample.aiBlocked === true,
                },
                createdAt: now,
                updatedAt: now,
              });
            }
            tx.oncomplete = () => {
              db.close();
              resolve(created);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
    rows
  );
}

/** 分类、标签、待看、墓碑、在途 AI 批次各造一条，并给普通收藏挂上分类与标签。 */
function seedExtras(page) {
  return page.evaluate(
    (input) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const now = new Date().toISOString();
          const categoryId = crypto.randomUUID();
          const tagId = crypto.randomUUID();
          const readingId = crypto.randomUUID();
          const tombstoneId = crypto.randomUUID();
          const tx = db.transaction(
            ['bookmarks', 'categories', 'tags', 'readingItems', 'tombstones', 'handoffBatches'],
            'readwrite'
          );
          tx.objectStore('categories').put({
            id: categoryId,
            name: input.categoryName,
            description: '回归用分类',
            revision: 1,
            createdAt: now,
            updatedAt: now,
          });
          tx.objectStore('tags').put({ id: tagId, name: 'P6 标签', revision: 1, createdAt: now });
          tx.objectStore('readingItems').put({
            id: readingId,
            originalUrl: 'https://example.com/p6-reading',
            canonicalUrl: 'https://example.com/p6-reading',
            title: 'P6 待看样本',
            note: '',
            status: 'pending',
            addedAt: now,
            completedAt: null,
            relatedBookmarkId: null,
            sources: [],
            revision: 1,
            localRevision: 1,
            changeVersion: null,
          });
          tx.objectStore('tombstones').put({
            entityType: 'bookmark',
            id: tombstoneId,
            revision: 1,
            changeVersion: null,
            deletedAt: now,
            privacyScope: 'main',
            canonicalUrl: 'https://example.com/p6-tombstone',
            title: 'P6 墓碑',
          });
          tx.objectStore('handoffBatches').put({
            id: crypto.randomUUID(),
            protocolVersion: 2,
            createdAt: now,
            policyVersion: 1,
            libraryId: 'p6-library-original',
            status: 'exported',
            parts: 1,
            itemCount: 1,
            materialText: '{}',
          });

          const read = tx.objectStore('bookmarks').getAll();
          read.onsuccess = () => {
            const target = read.result.find((row) => row.title === input.title);
            if (!target) {
              tx.abort();
              reject(new Error(`没有找到样本：${input.title}`));
              return;
            }
            tx.objectStore('bookmarks').put({
              ...target,
              categoryId,
              categoryKey: categoryId,
              tagIds: [tagId],
              note: input.note,
              selectedText: input.selectedText,
              updatedAt: now,
            });
          };
          tx.oncomplete = () => {
            db.close();
            resolve({ categoryId, tagId, readingId, tombstoneId });
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    { title: 'P6 普通收藏', categoryName: CATEGORY_NAME, note: NOTE, selectedText: SELECTED_TEXT }
  );
}

async function createBookmark(page, { url, title }) {
  await goto(page, 'home', '快速操作');
  await clickIn(page, '.topbar', '收藏链接');
  await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
  await setReactInput(page, 'input[placeholder="https://"]', url);
  await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', title);
  await clickIn(page, '.modal', '保存到收件箱');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="https://"]');
      if (!input) return { saved: true, message: '' };
      return { saved: false, message: (document.querySelector('.modal .alert')?.textContent ?? '').trim() };
    });
    if (state.saved) return;
    if (state.message) throw new Error(`新建收藏失败：${state.message}`);
    await sleep(150);
  }
  throw new Error('新建收藏等待写入结果超时');
}

/* ---------- 下载目录：只认磁盘上真实落盘的导出文件 ---------- */

/** CDP 的下载事件流水，用来区分「点了没反应」和「下载了但没落在这里」。 */
const downloadTrail = [];

function listDownloads() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs
    .readdirSync(DOWNLOAD_DIR)
    .filter((name) => !name.endsWith('.crdownload'))
    .map((name) => path.join(DOWNLOAD_DIR, name));
}

/** 等一个新文件出现、且大小连续两次一致（浏览器写完才算完整）。 */
async function waitForDownload(known, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const fresh = listDownloads().filter((file) => !known.includes(file));
    if (fresh.length > 0) {
      const newest = fresh.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      const size = fs.statSync(newest).size;
      if (last === newest && stable > 0 && size > 0) return newest;
      if (last === newest) stable += 1;
      else {
        last = newest;
        stable = 0;
      }
    }
    await sleep(200);
  }
  // 超时时把「磁盘上有什么」「浏览器报了什么」一起带出去，省得下次还要猜。
  const partial = fs.existsSync(DOWNLOAD_DIR)
    ? fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.crdownload')).length
    : 0;
  const trail = downloadTrail.length === 0 ? '无下载事件' : downloadTrail.slice(-3).join(' / ');
  throw new Error(
    `等待下载超时：没有出现新的导出文件（目录内已有 ${listDownloads().length} 个、未完成 ${partial} 个；下载事件：${trail}）`
  );
}

function readDownloaded(file) {
  const text = fs.readFileSync(file, 'utf8');
  return { text, size: Buffer.byteLength(text, 'utf8') };
}

/** 导出按钮在导出期间是 disabled 的：disabled 上的 click() 什么都不会发生，先等它可用。 */
async function clickExport(page, buttonText) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((needle) => {
      const nodes = [...document.querySelectorAll('.griddata button')];
      const hit = nodes.find((node) => (node.textContent ?? '').trim().includes(needle));
      return Boolean(hit) && !hit.disabled;
    }, buttonText);
    if (ready) break;
    await sleep(150);
  }
  await clickIn(page, '.griddata', buttonText);
}

/** 点一次导出，返回落盘文件内容。 */
async function exportVia(page, buttonText, expectExt) {
  const known = listDownloads();
  await clickExport(page, buttonText);
  const file = await waitForDownload(known);
  if (expectExt && !file.endsWith(expectExt)) {
    throw new Error(`导出文件类型不符：${path.basename(file)}`);
  }
  return { file, ...readDownloaded(file) };
}

/** 前置导出失败时，后续阶段不该抛 TypeError，直接说清缺什么。 */
function requireContext(ctx, key, label) {
  if (!ctx[key]) throw new Error(`缺少前置数据：${label} 未取得，本项无法判断`);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  for (const dir of [VERIFY_DIR, OUT_DIR, FIXTURE_DIR, ARTIFACT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const target = BROWSERS.find(
    (browser) => browser.name.toLowerCase() === (process.env.P0_BROWSER ?? 'chrome').toLowerCase()
  );
  if (!target) {
    throw new Error('未找到可用的 Chrome / Edge。请安装其中之一，或用 SHIYE_CHROME / SHIYE_EDGE 指定路径。');
  }

  const limitations = [
    '手机真机打开快照（P6.4）无法自动化：本轮把导出的 HTML 另存为 .verify/artifacts/p6-snapshot-mobile.html，需要人工传到手机浏览器打开并记录设备与结果。',
    '浏览器下载的「是否真的保存到磁盘」只能验证到 Chrome 下载目录里出现了完整文件，用户机器上的下载确认弹窗、磁盘已满等系统级失败未覆盖。',
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    task: 'P6',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    counts: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-p6`);
  const attempt = await launchBestEffort(target, profileDir, limitations);
  report.browser.version = await attempt.browser.version();
  report.browser.headless = attempt.headless;
  report.browser.extensionId = attempt.extId;
  const { browser } = attempt;
  const base = `chrome-extension://${attempt.extId}`;

  // 优先复用浏览器启动时自带的标签页：受限环境里 newPage() 建出来的目标可能立刻失效
  // （随后 setViewport / createCDPSession 都报 Session closed），复用已有标签页则整轮稳定。
  const [existing] = await browser.pages().catch(() => []);
  const page = existing ?? (await browser.newPage());
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    const url = request.url();
    // blob: 是导出时 createObjectURL 生成的本地下载地址，不是外部请求。
    const local =
      url.startsWith('chrome-extension://') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      url.startsWith('about:') ||
      url.startsWith('devtools:');
    if (!local) externalRequests.push(url);
  });
  // 视口只影响排版，不影响本轮任何断言；受限环境里 setViewport 会撞上
  // 「Session closed」，不能让它把整轮验证打断。
  await page.setViewport({ width: 1280, height: 900 }).catch(() => {});

  // 让导出落到约定目录，才能按真实文件断言。
  // Browser.setDownloadBehavior 属于浏览器级域：优先走浏览器目标会话；
  // 老版本退回页面会话上的 Page.setDownloadBehavior。
  let downloadReady = false;
  try {
    const browserSession = await browser.target().createCDPSession();
    // 记下浏览器侧看到的下载：有事件却没文件＝落盘路径不对，没事件＝根本没触发下载。
    browserSession.on('Browser.downloadWillBegin', (event) => {
      downloadTrail.push(`开始 ${event.suggestedFilename ?? '未命名'}`);
    });
    browserSession.on('Browser.downloadProgress', (event) => {
      if (event.state === 'completed') downloadTrail.push(`完成 ${event.totalBytes ?? '?'}B`);
      if (event.state === 'canceled') downloadTrail.push('被取消');
    });
    await browserSession.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DOWNLOAD_DIR,
      eventsEnabled: true,
    });
    downloadReady = true;
  } catch {
    try {
      const pageSession = await page.createCDPSession();
      await pageSession.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DOWNLOAD_DIR,
      });
      downloadReady = true;
    } catch {
      downloadReady = false;
    }
  }
  if (!downloadReady) {
    limitations.push('浏览器拒绝了下载目录设置，导出的文件可能落在默认下载目录，相关断言会因等待新文件超时而失败。');
  }

  await reloadWorkspace(page, base, 'data');

  const ctx = { ids: {}, categoryId: '', backup: null, localOnlyBackup: null, snapshot: null };

  const phases = [];
  const phase = (label, fn) => phases.push({ label, fn });

  // ---- 准备 ----
  phase('准备：样本、分类、待看、墓碑与在途批次', async () => {
    await createBookmark(page, { url: 'https://example.com/p6-template', title: T_TEMPLATE });
    ctx.ids = await seedSamples(page, [
      { url: 'https://example.com/p6-normal', title: T_NORMAL, description: '普通描述' },
      { url: 'https://example.com/p6-local', title: T_LOCAL_ONLY, localOnly: true },
      { url: 'https://example.com/p6-aiblocked', title: T_AI_BLOCKED, aiBlocked: true },
      { url: 'https://example.com/p6-deleted', title: T_DELETED, deleted: true },
    ]);
    const extras = await seedExtras(page);
    ctx.categoryId = extras.categoryId;
    await reloadWorkspace(page, base, 'data');
    const stores = await readStores(page, ['bookmarks', 'readingItems', 'categories', 'tags', 'tombstones']);
    record(
      'P6.1 样本就绪：活跃、已删除、本地专用、禁止 AI 各一条',
      stores.bookmarks.length === 5 && stores.readingItems.length === 1 && stores.categories.length === 1,
      `收藏=${stores.bookmarks.length}｜待看=${stores.readingItems.length}｜分类=${stores.categories.length}｜标签=${stores.tags.length}｜墓碑=${stores.tombstones.length}`
    );
  });

  // ---- P6.1 完整备份 ----
  phase('P6.1 导出完整 JSON', async () => {
    const first = await exportVia(page, '导出完整 JSON', '.json');
    ctx.backup = JSON.parse(first.text);
    const doc = ctx.backup;
    record(
      'P6.1 备份包含收藏、待看状态、分类、标签、设置、策略与墓碑',
      doc.bookmarks.length === 4 &&
        doc.readingItems.length === 1 &&
        doc.categories.length === 1 &&
        doc.tags.length === 1 &&
        Boolean(doc.settings) &&
        Boolean(doc.policy) &&
        doc.tombstones.length === 1,
      `收藏=${doc.bookmarks.length}｜待看=${doc.readingItems.length}｜分类=${doc.categories.length}｜标签=${doc.tags.length}｜策略=${Boolean(doc.policy)}｜墓碑=${doc.tombstones.length}`
    );
    record(
      'P6.1 默认不含本地专用条目，且标记了这一点',
      doc.includesLocalOnly === false && !first.text.includes(T_LOCAL_ONLY),
      `includesLocalOnly=${doc.includesLocalOnly}｜含本地专用=${first.text.includes(T_LOCAL_ONLY)}`
    );
    record(
      'P6.1 已删除条目与墓碑都在备份里（恢复后不会被旧数据复活）',
      first.text.includes(T_DELETED) && doc.tombstones.length === 1,
      `含已删除=${first.text.includes(T_DELETED)}｜墓碑=${doc.tombstones.length}`
    );
    record(
      'P6.1 备份不含任何凭据字段',
      !/api[_-]?key|bearer\s|password|secret|access[_-]?token/i.test(first.text),
      `字节=${first.size}`
    );
    record(
      'P6.1 备份带导出时间与数据截止时间',
      Boolean(doc.exportedAt) && Boolean(doc.dataCutoffAt) && doc.scope === 'device',
      `导出=${doc.exportedAt}｜截止=${doc.dataCutoffAt}｜范围=${doc.scope}`
    );

    await toggleCheckbox(page, '包含本地专用条目');
    const second = await exportVia(page, '导出完整 JSON', '.json');
    ctx.localOnlyBackup = JSON.parse(second.text);
    record(
      'P6.1 明确勾选后才把本地专用条目写进 JSON',
      ctx.localOnlyBackup.includesLocalOnly === true &&
        second.text.includes(T_LOCAL_ONLY) &&
        ctx.localOnlyBackup.bookmarks.length === 5,
      `条目=${ctx.localOnlyBackup.bookmarks.length}｜标记=${ctx.localOnlyBackup.includesLocalOnly}`
    );
    // 复原勾选，免得影响后面的快照导出。
    await toggleCheckbox(page, '包含本地专用条目');
    // 文件名只到「日」时，同一天导出第二次会覆盖第一份：这里要求磁盘上真的留下两份。
    record(
      'P6.1 同一天连续导出得到两个不同文件，前一份没有被覆盖',
      path.basename(first.file) !== path.basename(second.file) && listDownloads().length === 2,
      `第一份=${path.basename(first.file)}｜第二份=${path.basename(second.file)}`
    );
  });

  // ---- P6.3 手机只读快照 ----
  phase('P6.3 导出手机只读快照', async () => {
    const snapshot = await exportVia(page, '导出可搜索 HTML', '.html');
    ctx.snapshot = snapshot;
    const html = snapshot.text;
    const articles = (html.match(/<article class="item"/g) ?? []).length;
    record(
      'P6.3 快照只含正式收藏：排除本地专用与已删除',
      !html.includes(T_LOCAL_ONLY) && !html.includes(T_DELETED) && articles === 3,
      `条目=${articles}｜含本地专用=${html.includes(T_LOCAL_ONLY)}｜含已删除=${html.includes(T_DELETED)}`
    );
    record(
      'P6.3 备注与选中文字各自独立开关',
      html.includes(NOTE) && !html.includes(SELECTED_TEXT),
      `含备注=${html.includes(NOTE)}｜含选中文字=${html.includes(SELECTED_TEXT)}`
    );
    record(
      'P6.3 分类与关键词组合筛选所需的数据都在静态行上',
      html.includes(`data-cat="${ctx.categoryId}"`) &&
        /data-text="p6 普通收藏/.test(html) &&
        html.includes(`<option value="${ctx.categoryId}">${CATEGORY_NAME}</option>`),
      `分类属性=${html.includes(`data-cat="${ctx.categoryId}"`)}｜关键词属性=${/data-text="p6 普通收藏/.test(html)}`
    );
    record(
      'P6.3 无脚本也能读：条目与文字全部预先渲染在 HTML 里',
      articles === 3 && html.indexOf('<article') < html.indexOf('<script'),
      `渲染行=${articles}`
    );
    record(
      'P6.3 不加载任何外部资源',
      !/<link\b|<img\b|<iframe\b/i.test(html) && !/src="https?:/i.test(html),
      `外部引用=${/<link\b|<img\b|<iframe\b|src="https?:/i.test(html)}`
    );
    record(
      'P6.3 快照标明导出时间且声明不自动同步',
      /导出于/.test(html) && html.includes('不自动同步') && html.includes('文件持有者可以读取'),
      `时间=${/导出于[^<]*/.exec(html)?.[0]?.slice(0, 24) ?? ''}`
    );

    // 关掉备注、打开选中文字，导出第二份对比。
    await toggleCheckbox(page, '包含人工备注');
    await toggleCheckbox(page, '包含选中文字');
    const second = await exportVia(page, '导出可搜索 HTML', '.html');
    record(
      'P6.3 关掉备注后快照不再带人工备注，打开后带选中文字',
      !second.text.includes(NOTE) && second.text.includes(SELECTED_TEXT),
      `含备注=${second.text.includes(NOTE)}｜含选中文字=${second.text.includes(SELECTED_TEXT)}`
    );

    // 留给人工传到手机打开（P6.4 的证据前提）。
    const artifact = path.join(ARTIFACT_DIR, 'p6-snapshot-mobile.html');
    fs.writeFileSync(artifact, snapshot.text, 'utf8');
    record(
      'P6.4 快照已另存为可真机打开的独立文件',
      fs.existsSync(artifact) && fs.statSync(artifact).size > 1000,
      `文件=${path.relative(ROOT, artifact)}｜字节=${fs.statSync(artifact).size}`
    );
    await toggleCheckbox(page, '包含人工备注');
  });

  // ---- P6.2 恢复预览与合并 ----
  phase('P6.2 预览与合并恢复', async () => {
    requireContext(ctx, 'localOnlyBackup', '含本地专用的完整备份');
    await goto(page, 'data', '数据在手里，才放心。');
    // 造一份「比本机多一条」的备份：合并应新增这一条，其余按 ID 跳过。
    const merged = JSON.parse(JSON.stringify(ctx.localOnlyBackup));
    const templateRow = merged.bookmarks.find((row) => row.title === T_NORMAL);
    merged.bookmarks.push({
      ...templateRow,
      id: 'p6-merge-added',
      originalUrl: 'https://example.com/p6-merge-added',
      canonicalUrl: 'https://example.com/p6-merge-added',
      title: 'P6 合并新增',
    });
    const mergedPath = path.join(FIXTURE_DIR, 'p6-merge.json');
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2), 'utf8');

    await upload(page, mergedPath);
    await waitForSelectorReady(page, '.stats', 15_000);
    const preview = await page.evaluate(() => ({
      stats: document.querySelector('.stats')?.innerText?.replace(/\s+/g, ' ').trim() ?? '',
      micro: [...document.querySelectorAll('.panel .micro')].map((node) => node.innerText).join(' | '),
    }));
    record(
      'P6.2 恢复前预览条数与导出时间',
      preview.stats.includes(String(merged.bookmarks.length)) && preview.micro.includes('导出时间'),
      `预览=${preview.stats}`
    );

    await page.select('.panel select', 'merge');
    await sleep(200);
    await clickIn(page, '.panel', '合并恢复');
    await waitForText(page, '恢复完成', 20_000);
    const outcome = await page.evaluate(() => document.body.innerText);
    const stores = await readStores(page, ['bookmarks']);
    record(
      'P6.2 合并只加新条目，同 ID 的旧记录不覆盖',
      outcome.includes('新增收藏 1 条') &&
        stores.bookmarks.some((row) => row.title === 'P6 合并新增') &&
        stores.bookmarks.length === 6,
      `新增文案=${/新增收藏 \d+ 条/.exec(outcome)?.[0] ?? ''}｜库内=${stores.bookmarks.length}`
    );
  });

  // ---- P6.2 替换恢复、安全备份与主库身份 ----
  phase('P6.2 替换恢复与安全备份', async () => {
    requireContext(ctx, 'localOnlyBackup', '含本地专用的完整备份');
    const before = await readStores(page, ['bookmarks']);
    const replaceDoc = JSON.parse(JSON.stringify(ctx.localOnlyBackup));
    replaceDoc.libraryId = NEW_LIBRARY_ID;
    const replacePath = path.join(FIXTURE_DIR, 'p6-replace.json');
    fs.writeFileSync(replacePath, JSON.stringify(replaceDoc, null, 2), 'utf8');

    await goto(page, 'data', '数据在手里，才放心。');
    await upload(page, replacePath);
    await waitForSelectorReady(page, '.stats', 15_000);
    await page.select('.panel select', 'replace');
    await sleep(250);
    await clickIn(page, '.panel', '替换并恢复');
    // 提示是异步渲染的，且页面里可能还有其他 alert 容器，按文本等才可靠。
    await waitForText(page, '请确认已了解影响', 6_000).catch(() => {});
    const refused = await page.evaluate(
      () => [...document.querySelectorAll('.panel .alert')].map((node) => node.innerText.trim()).join(' | ')
    );
    record(
      'P6.2 替换未勾选确认时被明确拒绝',
      refused.includes('请确认已了解影响'),
      `提示=「${refused.slice(0, 60)}」`
    );

    await toggleCheckbox(page, '我了解影响并确认替换');
    const known = listDownloads();
    await clickIn(page, '.panel', '替换并恢复');
    await waitForText(page, '恢复完成（替换）', 20_000);
    const safetyFile = await waitForDownload(known);
    const safety = JSON.parse(readDownloaded(safetyFile).text);
    record(
      'P6.2 替换前先导出安全备份，时间与数量可核对',
      safety.bookmarks.length === before.bookmarks.length &&
        Boolean(safety.exportedAt) &&
        !Number.isNaN(Date.parse(safety.exportedAt)),
      `安全备份收藏=${safety.bookmarks.length}（替换前 ${before.bookmarks.length}）｜导出=${safety.exportedAt}`
    );
    const notice = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    record(
      'P6.2 界面展示安全备份的导出时间与条数',
      notice.includes('替换前已自动备份当前主库') &&
        /导出时间 [^·]+ · \d+ 条收藏/.test(notice),
      `片段=${/导出时间[^·]{0,30}/.exec(notice)?.[0]?.trim() ?? ''}`
    );

    const stores = await readStores(page, ['bookmarks', 'readingItems', 'categories', 'tags', 'handoffBatches']);
    // 本地专用条目本身是活跃记录：活跃数应为总条数减掉那一条已删除的。
    const active = stores.bookmarks.filter((row) => row.lifeState === 'active');
    record(
      'P6.2 替换后条数与备份一致，合并阶段加的条目被清掉',
      stores.bookmarks.length === replaceDoc.bookmarks.length &&
        active.length === replaceDoc.bookmarks.length - 1,
      `库内=${stores.bookmarks.length}｜活跃=${active.length}`
    );
    record(
      'P6.2 替换后待看与分类标签都按备份恢复',
      stores.readingItems.length === 1 && stores.categories.length === 1 && stores.tags.length === 1,
      `待看=${stores.readingItems.length}｜分类=${stores.categories.length}｜标签=${stores.tags.length}`
    );

    // 深度一致性：派生键必须与引用一致，不能留下指向空气的分类/标签。
    const categoryIds = new Set(stores.categories.map((row) => row.id));
    const tagIds = new Set(stores.tags.map((row) => row.id));
    const badKey = stores.bookmarks.filter((row) => row.categoryKey !== (row.categoryId ?? 'uncategorized'));
    const badCategory = stores.bookmarks.filter((row) => row.categoryId && !categoryIds.has(row.categoryId));
    const badTags = stores.bookmarks.filter((row) => (row.tagIds ?? []).some((id) => !tagIds.has(id)));
    record(
      'P6.2 恢复后派生键与引用深度一致',
      badKey.length === 0 && badCategory.length === 0 && badTags.length === 0,
      `键不符=${badKey.length}｜悬空分类=${badCategory.length}｜悬空标签=${badTags.length}`
    );

    record(
      'P6.2 替换后主库身份切换并提示旧 AI 映射失效',
      notice.includes('主库身份已切换') &&
        notice.includes(NEW_LIBRARY_ID) &&
        notice.includes('旧设备或旧配置上的 AI 交接映射已失效'),
      `提示=${notice.includes('主库身份已切换')}`
    );
    record(
      'P6.2 替换作废在途 AI 批次，不会对新主库继续套旧编号',
      stores.handoffBatches.length === 0 && /1 个在途批次作废/.test(notice),
      `剩余批次=${stores.handoffBatches.length}`
    );
  });

  // ---- P6.2 版本与损坏文件 ----
  phase('P6.2 拒绝未知新版与损坏文件', async () => {
    requireContext(ctx, 'localOnlyBackup', '含本地专用的完整备份');
    await goto(page, 'data', '数据在手里，才放心。');
    const future = JSON.parse(JSON.stringify(ctx.localOnlyBackup));
    future.schemaVersion = 99;
    const futurePath = path.join(FIXTURE_DIR, 'p6-future.json');
    fs.writeFileSync(futurePath, JSON.stringify(future, null, 2), 'utf8');
    await upload(page, futurePath);
    await waitForText(page, '升级扩展', 10_000).catch(() => {});
    const futureError = await page.evaluate(
      () => [...document.querySelectorAll('.panel .alert')].map((node) => node.innerText.trim()).join(' | ')
    );
    record(
      'P6.2 未知新版备份被拒绝并提示升级扩展',
      futureError.includes('升级扩展') && futureError.includes('99'),
      `提示=「${futureError.slice(0, 60)}」`
    );

    const brokenPath = path.join(FIXTURE_DIR, 'p6-broken.json');
    fs.writeFileSync(brokenPath, '{ "schemaVersion": 2, ', 'utf8');
    await upload(page, brokenPath);
    await waitForText(page, '不是有效的 JSON', 10_000).catch(() => {});
    const brokenError = await page.evaluate(
      () => [...document.querySelectorAll('.panel .alert')].map((node) => node.innerText.trim()).join(' | ')
    );
    record(
      'P6.2 损坏 JSON 被拒绝且给出可读原因',
      /不是有效的 JSON/.test(brokenError),
      `提示=「${brokenError.slice(0, 60)}」`
    );

    const stores = await readStores(page, ['bookmarks']);
    record(
      'P6.2 两次失败都没有动主库',
      stores.bookmarks.length === ctx.localOnlyBackup.bookmarks.length,
      `库内=${stores.bookmarks.length}`
    );
  });

  // ---- 收尾 ----
  phase('收尾：外部请求与脚本错误', async () => {
    const noise = externalRequests.filter((url) => !url.startsWith('chrome-extension://'));
    record('整轮没有产生外部网络请求', noise.length === 0, `外部请求=${JSON.stringify(noise.slice(0, 3))}`);
  });

  try {
    for (const item of phases) {
      try {
        await item.fn();
      } catch (error) {
        record(`${item.label} 中断`, false, errorText(error));
      }
    }
    record('页面脚本错误检查', errors.length === 0, `errors=${JSON.stringify(errors.slice(0, 3))}`);
  } finally {
    await browser.close().catch(() => {});
  }

  report.counts.downloads = listDownloads().length;
  report.counts.downloadEvents = downloadTrail.length;
  report.downloadTrail = downloadTrail;
  report.ok = steps.every((step) => step.ok);
  const rel = writeReport(OUT_DIR, 'p6-browser-verification.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

/** 通过文件选择框上传备份（走界面真实路径，不直接调 service）。 */
async function upload(page, filePath) {
  const input = await page.$('input[type="file"]');
  if (!input) throw new Error('没有找到备份文件选择框');
  await input.uploadFile(filePath);
  await sleep(500);
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
