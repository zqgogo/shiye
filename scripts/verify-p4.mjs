/**
 * P4 浏览器验证：分类、搜索与提问资料选择。
 *
 * 对应 docs/ROADMAP.md：
 * - P4.1 分类标签：改名、引用迁移、最多 8 个置顶及排序、多标签，删除分类不删收藏；
 * - P4.2 本地搜索：中文召回、筛选、索引重建，保留选择状态；
 * - P4.3 资料选择：宽窗、完整匹配集、跨分类、全选/取消匹配集、仅已选、清空、隐私排除；
 * - P4.4 容量验证：60 条以上与 500 条下的搜索和全选，容量不足明确提示；
 * - P4.5 完整搜索与分类行为：八个字段、全库/当前分类、待看独立搜索、分类过滤与排序、回收站排除。
 *
 * 造数策略：先用界面建 1 条真实收藏，再把它读出当字段模板，用原生 IndexedDB
 * 批量复制成 500 条。这样派生字段（categoryKey / unreadFlag / lifeState）与真实写入一致，
 * 又不必在界面上点 500 次。
 *
 * 所有断言回读 IndexedDB 主库或页面上真实渲染的文本，不信任 toast 文案。
 * 每个阶段单独 try/catch：某一阶段抛错只记一条 FAIL，后续阶段继续跑。
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
  waitForSelectorGone,
  waitForSelectorReady,
  waitForText,
  writeReport,
} from './lib/launch-extension.mjs';

const VERIFY_DIR = path.join(ROOT, '.verify');
const OUT_DIR = path.join(VERIFY_DIR, 'reports');

/** 造数用的固定标识，便于在 500 条里精确定位。 */
const CAT_NAMES = Array.from({ length: 9 }, (_, index) => `P4 分类 ${String(index + 1).padStart(2, '0')}`);
const CAT_RENAME = 'P4 改名后分类';
const TAG_NAME = 'P4 青瓷标签';
const URL_TEMPLATE = 'https://example.com/p4-template';
const URL_PLAIN = 'https://example.com/p4-plain';

/** 八个可检索字段各给一个独特词，避免互相串味。 */
const FIELD_CASES = [
  { key: 'title', term: '靛蓝排版', overrides: { title: 'P4 字段样本 title 靛蓝排版' } },
  { key: 'description', term: '琥珀装帧', overrides: { description: '琥珀装帧 说明' } },
  { key: 'note', term: '绯红批注', overrides: { note: '绯红批注 备注' } },
  { key: 'selectedText', term: '黛绿摘录', overrides: { selectedText: '黛绿摘录 原文' } },
  { key: 'aiPurpose', term: '月白用途', overrides: { aiPurpose: '月白用途 说明' } },
  { key: 'url', term: 'p4urlkey', overrides: { url: 'https://example.com/path/p4urlkey' } },
  { key: 'category', term: CAT_NAMES[8], overrides: { category: 8 } },
  { key: 'tag', term: TAG_NAME, overrides: { tag: true } },
];

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail: detail ?? '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
};

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0].slice(0, 240);
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
 * 整页重新加载，让 React 重新从主库读一遍（造数后必须走这一步）。
 *
 * 只 `page.goto('#home')` 不够：地址只有 hash 不同时，浏览器做的是同文档跳转，
 * React 不会重新挂载，内存里仍是造数前的快照——侧栏显示旧的收藏总数，
 * 搜索命中的条目也会被旧快照过滤成 0。必须显式 reload 才算重读主库。
 */
async function reloadWorkspace(page, base, hash = 'home') {
  const url = `${base}/workspace.html#${hash}`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      break;
    } catch (error) {
      // 扩展刚加载完时标签页可能还在初始化，此时会抛「Requesting main frame too early」。
      if (attempt === 9) throw error;
      await sleep(300);
    }
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForSelectorReady(page, '.brand-mark', 25_000);
  await sleep(700);
}

function toastText(page) {
  return page.evaluate(() => document.querySelector('.toast')?.textContent?.trim() ?? '');
}

/** 读 settings 表的 app 记录（置顶分类等偏好存在这里）。 */
function readAppSettings(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('settings', 'readonly');
          const all = tx.objectStore('settings').getAll();
          tx.oncomplete = () => {
            db.close();
            const row = all.result.find((entry) => entry.key === 'app');
            resolve(row?.value ?? null);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      })
  );
}

/**
 * 批量造收藏：拿库里第一条真实记录当字段模板，逐个覆盖可变字段。
 * 派生键一并算好，保证与用例层写入的结果一致。
 */
function seedBookmarks(page, rows) {
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
            for (const sample of samples) {
              store.put({
                ...template,
                id: crypto.randomUUID(),
                originalUrl: sample.url,
                canonicalUrl: sample.url,
                title: sample.title,
                sourceDescription: sample.description ?? '',
                aiPurpose: sample.aiPurpose ?? '',
                note: sample.note ?? '',
                selectedText: sample.selectedText ?? '',
                categoryId: sample.categoryId ?? null,
                categoryKey: sample.categoryId ?? 'uncategorized',
                tagIds: sample.tagIds ?? [],
                inboxUnread: sample.unread === true,
                unreadFlag: sample.unread === true ? 1 : 0,
                pinned: false,
                lastOpenedAt: sample.lastOpenedAt ?? null,
                lifeState: sample.lifeState ?? 'active',
                deletedAt: sample.lifeState === 'deleted' ? now : null,
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
              resolve(samples.length);
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

/** 写一条标签，供「标签名可检索」用。 */
function seedTag(page, name) {
  return page.evaluate(
    (label) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('tags', 'readwrite');
          const now = new Date().toISOString();
          tx.objectStore('tags').put({ id: crypto.randomUUID(), name: label, createdAt: now, updatedAt: now });
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    name
  );
}

/** 在分类管理弹窗里，按分类名找到它所在的行，点行内按钮。 */
async function clickCategoryAction(page, name, action) {
  const ok = await page.evaluate(
    (needle, act) => {
      const rows = [...document.querySelectorAll('.modal.wide .rule-row')];
      const hit = rows.find((row) => (row.innerText ?? '').includes(needle));
      if (!hit) return false;
      const buttons = [...hit.querySelectorAll('button')];
      const target =
        act === '上移'
          ? buttons.find((button) => button.getAttribute('aria-label') === '上移')
          : buttons.find((button) => (button.textContent ?? '').trim() === act);
      if (!target) return false;
      target.click();
      return true;
    },
    name,
    action
  );
  if (!ok) throw new Error(`分类「${name}」没有「${action}」按钮`);
  await sleep(500);
}

async function openCategories(page) {
  await goto(page, 'rules', '管理分类');
  await clickIn(page, '.heading', '管理分类');
  await waitForSelectorReady(page, '.modal.wide', 10_000);
  await sleep(300);
}

/** 分类弹窗里当前显示的行数与名称（用于过滤、排序断言）。 */
function categoryRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.modal.wide .rule-row')].map((row) => ({
      text: (row.innerText ?? '').replace(/\s+/g, ' ').trim(),
      name: (row.querySelector('strong')?.childNodes[0]?.textContent ?? '').trim(),
    }))
  );
}

/**
 * 输入关键词并等到「检索已出结论」再读数。
 *
 * 搜索是异步的：输入后 120ms 才发起检索，检索回来才渲染计数。用固定 sleep 猜时间，
 * 首屏第一次搜索一旦慢于猜测值就会读到「匹配 0 条」这个假结果。
 * 这里轮询到计数落地（有命中，或已给出空态且不在「正在检索」）为止，
 * 同时把耗时和失败现场记下来——首屏为什么慢，只能靠这些数说话。
 */
async function searchSettled(page, term, timeout = 8_000) {
  const startedAt = Date.now();
  await setReactInput(page, '#globalSearch', term);
  return settleSearch(page, startedAt, timeout);
}

/** 不重新输入，只等当前检索落地（改检索范围后要用）。 */
function settleSearch(page, startedAt = Date.now(), timeout = 8_000) {
  return (async () => {
    let last = null;
    while (Date.now() - startedAt < timeout) {
      last = await page.evaluate(() => {
        const toolbar = document.querySelector('.toolbar')?.innerText ?? '';
        const body = document.body.innerText;
        const matched = /匹配\s*(\d+)\s*条/.exec(toolbar);
        return {
          count: matched ? Number(matched[1]) : null,
          toolbar: toolbar.replace(/\s+/g, ' ').trim().slice(0, 60),
          pending: body.includes('正在检索本地索引'),
          failed: /索引(重建|检索)失败/.test(body),
          emptyState: body.includes('没有匹配的收藏'),
          rows: document.querySelectorAll('article.bookmark').length,
          input: document.querySelector('#globalSearch')?.value ?? '',
          library: /全部收藏\s*(\d+)/.exec(body)?.[1] ?? '',
          heading: (document.querySelector('.heading h1')?.textContent ?? '').trim(),
        };
      });
      if (last.count !== null && (last.count > 0 || !last.pending)) break;
      await sleep(150);
    }
    return { ...last, elapsed: Date.now() - startedAt };
  })();
}

/** 把一次搜索的现场压成一行，失败时才需要它。 */
function searchScene(hit) {
  return [
    `耗时=${hit.elapsed}ms`,
    `待定=${hit.pending}`,
    `报错=${hit.failed}`,
    `空态=${hit.emptyState}`,
    `行数=${hit.rows}`,
    `输入=${hit.input}`,
    `全部收藏=${hit.library}`,
    `页=${hit.heading}`,
  ].join('｜');
}

function searchResultTitles(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('article.bookmark')].map((row) =>
      (row.querySelector('h3, b, strong')?.textContent ?? row.innerText ?? '').split('\n')[0].trim()
    )
  );
}

/** 资料选择器当前可见条数、已选计数与各分类可选项。 */
function pickerState(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('.modal.wide');
    if (!modal) return null;
    const toolbar = modal.querySelector('.toolbar')?.innerText ?? '';
    const matched = /匹配\s*(\d+)\s*条/.exec(toolbar);
    const footer = modal.querySelector('.actions')?.innerText ?? '';
    const chosen = /已选\s*(\d+)\s*条/.exec(footer);
    return {
      matched: matched ? Number(matched[1]) : null,
      chosen: chosen ? Number(chosen[1]) : null,
      visible: modal.querySelectorAll('label.checkline').length,
      checked: [...modal.querySelectorAll('label.checkline input[type="checkbox"]')].filter((node) => node.checked)
        .length,
    };
  });
}

async function togglePickerRow(page, title) {
  const ok = await page.evaluate((needle) => {
    const rows = [...document.querySelectorAll('.modal.wide label.checkline')];
    const hit = rows.find((row) => (row.innerText ?? '').includes(needle));
    if (!hit) return false;
    const box = hit.querySelector('input[type="checkbox"]');
    if (!box) return false;
    box.click();
    return true;
  }, title);
  if (!ok) throw new Error(`资料选择器里没有「${title}」`);
  await sleep(300);
}

async function openPicker(page) {
  await goto(page, 'ask', '问一问');
  await clickIn(page, '.panel', '选择资料');
  await waitForSelectorReady(page, '.modal.wide', 10_000);
  await sleep(400);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  const target = BROWSERS.find(
    (browser) => browser.name.toLowerCase() === (process.env.P0_BROWSER ?? 'chrome').toLowerCase()
  );
  if (!target) {
    throw new Error('未找到可用的 Chrome / Edge。请安装其中之一，或用 SHIYE_CHROME / SHIYE_EDGE 指定路径。');
  }

  const limitations = [
    '「隐私受限或删除项即时排除」的“即时”部分靠组件内 useEffect 完成，页面级只能验证「不合格条目不出现在选择器列表中」；选择集随数据变化自动收缩的逻辑由 packages/application 的单测覆盖。',
    '搜索索引故障无法在界面上原生触发（Dexie 不提供故障注入），本轮只验证「重建索引」按钮与无匹配、空库状态。',
    '「保留筛选及选择状态」限定在同一次页面会话内：路由切换会卸载页面组件，已选资料随之丢失，这是 v1a 的既定取舍，未按跨会话持久化验收。',
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    task: 'P4',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    counts: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-p4`);
  const attempt = await launchBestEffort(target, profileDir, limitations);
  report.browser.version = await attempt.browser.version();
  report.browser.headless = attempt.headless;
  report.browser.extensionId = attempt.extId;
  const { browser } = attempt;
  const base = `chrome-extension://${attempt.extId}`;

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
  await reloadWorkspace(page, base, 'home');

  const ctx = { categoryIds: {}, tagId: null };

  // ---- 准备：建 9 个分类、1 条模板收藏、500 条造数 ----
  const phases = [];
  const phase = (label, fn) => phases.push({ label, fn });

  phase('准备：分类与造数', async () => {
    await openCategories(page);
    for (const name of CAT_NAMES) {
      await setReactInput(page, '.modal.wide input[placeholder="分类名称"]', name);
      await clickIn(page, '.modal.wide', '创建');
      await sleep(450);
    }
    const rows = await categoryRows(page);
    record(
      'P4.1 可批量创建分类并保持稳定 ID',
      rows.length === CAT_NAMES.length,
      `分类数=${rows.length}｜示例=${rows[0]?.name}`
    );

    // 从主库取回分类 ID，供造数引用。
    const categories = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('categories', 'readonly');
            const all = tx.objectStore('categories').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(all.result.map((row) => ({ id: row.id, name: row.name })));
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        })
    );
    for (const row of categories) ctx.categoryIds[row.name] = row.id;
    record(
      'P4.1 分类 ID 与名称一一对应且可回读',
      Object.keys(ctx.categoryIds).length === CAT_NAMES.length,
      Object.entries(ctx.categoryIds)
        .slice(0, 2)
        .map(([name, id]) => `${name}=${id.slice(0, 8)}`)
        .join('｜')
    );

    await clickIn(page, '.modal.wide', '完成');
    await sleep(400);

    // 一条真实收藏当模板，保证造数的字段结构与写入路径一致。
    await clickIn(page, '.topbar', '收藏链接');
    await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
    await setReactInput(page, 'input[placeholder="https://"]', URL_TEMPLATE);
    await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', 'P4 模板收藏');
    await clickIn(page, '.modal', '保存到收件箱');
    await waitForSelectorGone(page, '.modal input[placeholder="https://"]', 20_000);
    await sleep(600);

    await seedTag(page, TAG_NAME);
    const tagId = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('tags', 'readonly');
            const all = tx.objectStore('tags').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(all.result.find((row) => row.name === 'P4 青瓷标签')?.id ?? null);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        })
    );
    ctx.tagId = tagId;

    // 500 条基础数据 + 八个字段样本 + 跨分类样本 + 隐私样本 + 回收站样本 + 最近打开样本
    // 容量样本带长描述，是为了让「全选 480 条」真的超过提问包上限（300k 字符），
    // 从而验证「容量不足要明确提示、不能静默截断」。
    const longDescription = '容量验证用的占位描述，重复填充以累积字符数。'.repeat(30);
    const rowsToSeed = [];
    for (let index = 0; index < 480; index += 1) {
      rowsToSeed.push({
        url: `https://example.com/p4-bulk-${index}`,
        title: `P4 容量样本 ${index}`,
        description: longDescription,
      });
    }
    rowsToSeed.push({
      url: 'https://example.com/p4-cross-a',
      title: 'P4 跨分类甲',
      categoryId: ctx.categoryIds[CAT_NAMES[0]],
    });
    rowsToSeed.push({
      url: 'https://example.com/p4-cross-b',
      title: 'P4 跨分类乙',
      categoryId: ctx.categoryIds[CAT_NAMES[1]],
    });
    for (const item of FIELD_CASES) {
      // 每个样本只把独特词写进「目标字段」，其他字段留空：
      // 这样命中数必须是 1，多命中就说明索引串了字段。
      rowsToSeed.push({
        url: item.overrides.url ?? `https://example.com/p4-field-${item.key}`,
        title: item.overrides.title ?? `P4 字段样本 ${item.key}`,
        description: item.overrides.description ?? '字段样本描述',
        note: item.overrides.note ?? '',
        selectedText: item.overrides.selectedText ?? '',
        aiPurpose: item.overrides.aiPurpose ?? '',
        ...(item.overrides.category !== undefined
          ? { categoryId: ctx.categoryIds[CAT_NAMES[item.overrides.category]] }
          : {}),
        ...(item.overrides.tag ? { tagIds: [tagId] } : {}),
      });
    }
    // 近期打开：20 条不同收藏，用于「最近打开最多 15 个不同收藏」。
    for (let index = 0; index < 20; index += 1) {
      rowsToSeed.push({
        url: `https://example.com/p4-recent-${index}`,
        title: `P4 最近打开 ${index}`,
        lastOpenedAt: new Date(Date.now() - index * 60_000).toISOString(),
      });
    }
    rowsToSeed.push({
      url: 'https://example.com/p4-private',
      title: 'P4 隐私受限样本',
      localOnly: true,
    });
    rowsToSeed.push({
      url: 'https://example.com/p4-aiblocked',
      title: 'P4 禁止 AI 样本',
      aiBlocked: true,
    });
    rowsToSeed.push({
      url: 'https://example.com/p4-trashed',
      title: 'P4 回收站样本',
      lifeState: 'deleted',
    });
    await seedBookmarks(page, rowsToSeed);

    const seeded = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('bookmarks', 'readonly');
            const count = tx.objectStore('bookmarks').count();
            tx.oncomplete = () => {
              db.close();
              resolve(count.result);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        })
    );
    report.counts.seeded = seeded;
    record('P4.4 主库已具备 500 条以上数据', seeded >= 500, `收藏总数=${seeded}`);

    await reloadWorkspace(page, base, 'home');
  });

  // ---- P4.5 搜索覆盖八个字段 ----
  phase('P4.5 搜索字段覆盖', async () => {
    const results = {};
    for (const item of FIELD_CASES) {
      const hit = await searchSettled(page, item.term);
      results[item.key] = hit.count;
      if (item.key === 'title') report.counts.firstSearch = hit;
      record(
        `P4.5 搜索命中「${item.key}」字段（${item.term}）`,
        hit.count === 1,
        hit.count === 1 ? `匹配=1 条｜耗时=${hit.elapsed}ms` : `匹配=${hit.count} 条｜${searchScene(hit)}`
      );
    }
    report.counts.fieldHits = results;
  });

  phase('P4.5 中文召回与待看独立搜索', async () => {
    const recall = await searchSettled(page, '靛蓝排版');
    const titles = await searchResultTitles(page);
    record(
      'P4.2 中文标题按字与双字切分可召回',
      titles.some((title) => title.includes('靛蓝排版')),
      `结果=${titles.slice(0, 3).join(' / ')}｜${searchScene(recall)}`
    );

    // 待看队列里放一条，确认它只在待看搜索里出现，不混进收藏搜索。
    await goto(page, 'home', '快速操作');
    await clickIn(page, '.hubgrid', '加入待看');
    await waitForSelectorReady(page, '.modal input[placeholder="https://"]', 10_000);
    await setReactInput(page, '.modal input[placeholder="https://"]', 'https://example.com/p4-reading');
    await setReactInput(page, '.modal input[placeholder="给它一个容易想起的名字"]', 'P4 待看检索样本');
    await clickIn(page, '.modal', '加入待看');
    await waitForSelectorGone(page, '.modal input[placeholder="https://"]', 20_000);
    await sleep(600);

    await goto(page, 'reading', '待看');
    await setReactInput(page, 'input[aria-label="搜索待看"]', '待看检索');
    await sleep(500);
    const readingMatched = await page.evaluate(() => {
      const text = document.body.innerText;
      const matched = /匹配\s*(\d+)\s*\/\s*共\s*(\d+)\s*条/.exec(text);
      return {
        matched: matched ? Number(matched[1]) : null,
        total: matched ? Number(matched[2]) : null,
        hasRow: text.includes('P4 待看检索样本'),
      };
    });
    record(
      'P4.5 待看有独立搜索且不混入收藏库',
      readingMatched.matched === 1 && readingMatched.hasRow,
      `匹配=${readingMatched.matched}/${readingMatched.total}｜含该行=${readingMatched.hasRow}`
    );

    await setReactInput(page, 'input[aria-label="搜索待看"]', '不存在的关键词zzz');
    await sleep(500);
    const readingEmpty = await page.evaluate(() => document.body.innerText.includes('没有匹配的待看'));
    record('P4.5 待看搜索无匹配时给出空状态', readingEmpty === true, `空状态=${readingEmpty}`);
    await setReactInput(page, 'input[aria-label="搜索待看"]', '');
    await sleep(300);
  });

  phase('P4.5 检索范围与回收站排除', async () => {
    const all = await searchSettled(page, '靛蓝排版');
    const catId = ctx.categoryIds[CAT_NAMES[8]];
    const scopeStartedAt = Date.now();
    await page.select('select[aria-label="检索范围"]', catId);
    const scoped = await settleSearch(page, scopeStartedAt);
    record(
      'P4.5 检索范围可限定到某个分类',
      all.count === 1 && scoped.count === 0,
      `全库=${all.count}｜限定分类=${scoped.count}`
    );

    await page.select('select[aria-label="检索范围"]', '');
    await sleep(300);
    const byCategory = await searchSettled(page, CAT_NAMES[8]);
    record('P4.5 分类名本身可被检索', byCategory.count === 1, `匹配=${byCategory.count} 条`);

    const trashed = await searchSettled(page, '回收站样本');
    const trashedHit = trashed.count;
    record('P4.5 回收站中的收藏不进入搜索结果', trashedHit === 0, `匹配=${trashedHit} 条`);

    const none = await searchSettled(page, '不会命中的关键词qzx');
    record(
      'P4.2 无匹配时给出空状态而不是空白页',
      none.count === 0 && none.emptyState,
      `匹配=${none.count}｜空状态=${none.emptyState}｜${searchScene(none)}`
    );
  });

  phase('P4.2 索引重建', async () => {
    const before = await searchSettled(page, '靛蓝排版');
    await clickIn(page, '.toolbar', '重建索引');
    const rebuiltAt = Date.now();
    await sleep(600);
    const toast = await toastText(page);
    const after = await settleSearch(page, rebuiltAt);
    record(
      'P4.2 可显式重建索引且结果保持一致',
      /索引已重建/.test(toast) && after.count === before.count && before.count === 1,
      `提示=「${toast}」｜重建前=${before.count}｜重建后=${after.count}`
    );
  });

  // ---- P4.1 改名、置顶、过滤、排序、删除迁移 ----
  phase('P4.1 分类改名与引用迁移', async () => {
    const before = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('bookmarks', 'readonly');
            const all = tx.objectStore('bookmarks').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(
                all.result
                  .filter((row) => row.originalUrl === 'https://example.com/p4-field-category')
                  .map((row) => ({ id: row.id, categoryId: row.categoryId, revision: row.revision }))
              );
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        })
    );

    await openCategories(page);
    await clickCategoryAction(page, CAT_NAMES[8], '改名');
    await setReactInput(page, '.modal.wide input[aria-label="分类名称"]', CAT_RENAME);
    await clickIn(page, '.modal.wide', '保存');
    await sleep(800);
    const toast = await toastText(page);
    record('P4.1 分类改名成功并提示引用不变', /改名/.test(toast), `提示=「${toast}」`);

    const after = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('bookmarks', 'readonly');
            const all = tx.objectStore('bookmarks').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(
                all.result
                  .filter((row) => row.originalUrl === 'https://example.com/p4-field-category')
                  .map((row) => ({ id: row.id, categoryId: row.categoryId }))
              );
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        })
    );
    record(
      'P4.1 改名后收藏仍指向同一个分类 ID',
      before.length === 1 && after.length === 1 && after[0].categoryId === before[0].categoryId,
      `分类 ID 未变=${after[0]?.categoryId === before[0]?.categoryId}`
    );

    await clickIn(page, '.modal.wide', '完成');
    await sleep(400);
    const oldName = await searchSettled(page, CAT_NAMES[8]);
    const newName = await searchSettled(page, CAT_RENAME);
    record(
      'P4.5 改名后索引同步：旧名失效、新名生效',
      oldName.count === 0 && newName.count === 1,
      `旧名=${oldName.count} 条｜新名=${newName.count} 条`
    );
  });

  phase('P4.1 置顶上限与排序', async () => {
    await openCategories(page);
    for (const name of CAT_NAMES.slice(0, 8)) {
      await clickCategoryAction(page, name, '置顶');
    }
    const pinnedEight = await readAppSettings(page);
    record(
      'P4.1 可以置顶 8 个分类',
      Array.isArray(pinnedEight?.pinnedCategoryIds) && pinnedEight.pinnedCategoryIds.length === 8,
      `已置顶=${pinnedEight?.pinnedCategoryIds?.length}`
    );

    const ninth = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.modal.wide .rule-row')];
      const hit = rows.find((row) => (row.innerText ?? '').includes('P4 改名后分类'));
      const button = hit ? [...hit.querySelectorAll('button')].find((node) => (node.textContent ?? '').trim() === '置顶') : null;
      if (!button) return false;
      button.click();
      return true;
    });
    await sleep(700);
    const limitToast = await toastText(page);
    const afterNinth = await readAppSettings(page);
    record(
      'P4.1 第 9 个分类置顶被明确拒绝',
      ninth && /最多置顶\s*8\s*个分类/.test(limitToast) && afterNinth?.pinnedCategoryIds?.length === 8,
      `提示=「${limitToast}」｜仍为 ${afterNinth?.pinnedCategoryIds?.length} 个`
    );

    // 把第 2 个置顶分类上移，验证顺序持久化。
    await clickCategoryAction(page, CAT_NAMES[1], '上移');
    const reordered = await readAppSettings(page);
    record(
      'P4.1 置顶顺序可调整并持久化',
      reordered?.pinnedCategoryIds?.[0] === ctx.categoryIds[CAT_NAMES[1]],
      `首位置顶=${CAT_NAMES[1]}`
    );

    await page.select('select[aria-label="筛选分类"]', 'pinned');
    await sleep(600);
    const pinnedRows = await categoryRows(page);
    record('P4.1 已置顶过滤只显示 8 个置顶分类', pinnedRows.length === 8, `行数=${pinnedRows.length}`);

    await page.select('select[aria-label="筛选分类"]', 'nonempty');
    await sleep(600);
    const nonEmptyRows = await categoryRows(page);
    record(
      'P4.1 非空过滤排除没有收藏的分类',
      nonEmptyRows.length > 0 && nonEmptyRows.every((row) => !/(^|\s)0 条/.test(row.text)),
      `非空分类=${nonEmptyRows.length} 个｜首行=「${nonEmptyRows[0]?.text ?? ''}」`
    );

    await page.select('select[aria-label="筛选分类"]', 'all');
    await page.select('select[aria-label="分类排序"]', 'count');
    await sleep(600);
    const byCount = await categoryRows(page);
    const counts = byCount.map((row) => {
      const matched = /(\d+)\s*条/.exec(row.text);
      return matched ? Number(matched[1]) : 0;
    });
    const descending = counts.every((value, index) => index === 0 || counts[index - 1] >= value);
    record(
      'P4.1 按收藏数排序为降序',
      descending,
      `前三个=${counts.slice(0, 3).join(',')}`
    );

    await page.select('select[aria-label="分类排序"]', 'name');
    await sleep(600);
    const byName = await categoryRows(page);
    const names = byName.map((row) => row.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    record(
      'P4.1 按名称排序使用中文排序规则',
      names.join('|') === sorted.join('|'),
      `前三个=${names.slice(0, 3).join(' / ')}`
    );
  });

  phase('P4.1 删除分类不删收藏', async () => {
    const catId = ctx.categoryIds[CAT_NAMES[8]];
    const targetId = ctx.categoryIds[CAT_NAMES[0]];
    const before = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('bookmarks', 'readonly');
            const all = tx.objectStore('bookmarks').getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(all.result.length);
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        })
    );

    await openCategories(page);
    await clickCategoryAction(page, CAT_RENAME, '删除');
    await waitForSelectorReady(page, 'select[aria-label="迁移到"]', 10_000);
    await page.select('select[aria-label="迁移到"]', targetId);
    await sleep(300);
    await clickIn(page, '.notice.danger', '确认删除');
    await sleep(1200);
    const toast = await toastText(page);
    record('P4.1 删除分类必须选择迁移目标', /迁移/.test(toast), `提示=「${toast}」`);

    const after = await page.evaluate(
      (removedId, keptId) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('bookmarks', 'readonly');
            const all = tx.objectStore('bookmarks').getAll();
            tx.oncomplete = () => {
              db.close();
              const rows = all.result;
              resolve({
                total: rows.length,
                stillOnRemoved: rows.filter((row) => row.categoryId === removedId).length,
                moved: rows.filter((row) => row.categoryId === keptId).length,
              });
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        }),
      catId,
      targetId
    );
    record(
      'P4.1 删除分类后收藏一条不少、引用已迁移',
      after.total === before && after.stillOnRemoved === 0 && after.moved >= 1,
      `收藏 ${before}→${after.total}｜残留旧分类=${after.stillOnRemoved}｜迁移到目标=${after.moved}`
    );
    await clickIn(page, '.modal.wide', '完成');
    await sleep(400);
  });

  phase('P4.5 最近打开最多 15 个不同收藏', async () => {
    await goto(page, 'recent', '最近打开');
    await sleep(700);
    const recent = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('article.bookmark')];
      return { count: rows.length, ids: rows.map((row) => row.getAttribute('data-id') ?? '') };
    });
    record(
      'P4.5 最近打开只列最新 15 个不同收藏',
      recent.count === 15,
      `页面条数=${recent.count}（写入 20 条不同收藏）`
    );
  });

  // ---- P4.3 资料选择 ----
  phase('P4.3 资料选择集', async () => {
    await openPicker(page);
    const opened = await page.evaluate(() => {
      const modal = document.querySelector('.modal.wide');
      return {
        title: modal?.querySelector('#picker-title')?.textContent ?? '',
        wide: Boolean(modal),
        hint: (modal?.innerText ?? '').includes('本地专用和禁止 AI 的条目不在列表中'),
      };
    });
    record(
      'P4.3 资料选择器为宽窗并说明隐私规则',
      opened.wide && opened.hint,
      `标题=「${opened.title}」｜说明=${opened.hint}`
    );

    await setReactInput(page, 'input[aria-label="搜索资料"]', '隐私受限样本');
    await sleep(500);
    const privateHit = await pickerState(page);
    await setReactInput(page, 'input[aria-label="搜索资料"]', '禁止 AI 样本');
    await sleep(500);
    const aiBlockedHit = await pickerState(page);
    record(
      'P4.3 本地专用与禁止 AI 的条目不出现在选择列表',
      privateHit?.matched === 0 && aiBlockedHit?.matched === 0,
      `本地专用匹配=${privateHit?.matched}｜禁止 AI 匹配=${aiBlockedHit?.matched}`
    );

    await setReactInput(page, 'input[aria-label="搜索资料"]', 'P4 字段样本');
    await sleep(600);
    const fieldRows = await pickerState(page);
    report.counts.pickerFields = fieldRows;
    record(
      'P4.3 完整匹配集：一次筛出全部八个字段样本',
      fieldRows?.matched === FIELD_CASES.length,
      `匹配=${fieldRows?.matched}｜渲染行=${fieldRows?.visible}`
    );

    await clickIn(page, '.modal.wide', '全选匹配集');
    await sleep(500);
    const allChosen = await pickerState(page);
    record(
      'P4.3 全选匹配集把当前匹配全部加入已选',
      allChosen?.chosen === FIELD_CASES.length && allChosen?.checked === FIELD_CASES.length,
      `已选=${allChosen?.chosen}｜勾选=${allChosen?.checked}`
    );

    await page.select('select[aria-label="分类筛选"]', 'selected');
    await sleep(500);
    const onlySelected = await pickerState(page);
    record(
      'P4.3 仅已选过滤与已选计数一致',
      onlySelected?.visible === FIELD_CASES.length && onlySelected?.chosen === FIELD_CASES.length,
      `可见=${onlySelected?.visible}｜已选=${onlySelected?.chosen}`
    );

    await clickIn(page, '.modal.wide', '取消匹配集选择');
    await sleep(500);
    const unselected = await pickerState(page);
    record(
      'P4.3 取消匹配集只清当前匹配，不动其他已选',
      unselected?.chosen === 0,
      `已选=${unselected?.chosen}`
    );

    // 跨分类：在两个不同分类下各勾一条，再切「仅已选」确认两条都保留。
    await page.select('select[aria-label="分类筛选"]', '');
    await sleep(400);
    await setReactInput(page, 'input[aria-label="搜索资料"]', 'P4 跨分类');
    await sleep(500);
    await togglePickerRow(page, 'P4 跨分类甲');
    await page.select('select[aria-label="分类筛选"]', ctx.categoryIds[CAT_NAMES[1]]);
    await sleep(500);
    await togglePickerRow(page, 'P4 跨分类乙');
    await page.select('select[aria-label="分类筛选"]', 'selected');
    await sleep(500);
    const crossCategory = await pickerState(page);
    record(
      'P4.3 跨分类勾选会保留已选集合',
      crossCategory?.chosen === 2 && crossCategory?.visible === 2,
      `已选=${crossCategory?.chosen}｜仅已选可见=${crossCategory?.visible}`
    );

    await clickIn(page, '.modal.wide', '完成');
    await sleep(400);
    const askState = await page.evaluate(() => {
      const notice = document.querySelector('.notice')?.innerText ?? '';
      const matched = /已选\s*(\d+)\s*条资料/.exec(notice);
      return {
        chosen: matched ? Number(matched[1]) : null,
        hasPack: document.querySelector('pre.code') !== null,
      };
    });
    const externalAfterPick = externalRequests.length;
    record(
      'P4.3 选择不等于发送授权：未生成前没有提问包也没有外部请求',
      askState.chosen === 2 && askState.hasPack === false && externalAfterPick === 0,
      `已选=${askState.chosen}｜提问包=${askState.hasPack}｜外部请求=${externalAfterPick}`
    );

    // 「清空已选」清的是跨筛选的全部已选，不是只清当前筛选（那由「取消匹配集选择」负责）。
    await openPicker(page);
    await page.select('select[aria-label="分类筛选"]', '');
    await sleep(300);
    await setReactInput(page, 'input[aria-label="搜索资料"]', '');
    await sleep(600);
    const beforeClear = await pickerState(page);
    await clickIn(page, '.modal.wide', '清空已选');
    await sleep(500);
    const afterClear = await pickerState(page);
    record(
      'P4.3 清空已选：跨筛选的已选全部归零，匹配集不变',
      beforeClear?.chosen === 2 &&
        afterClear?.chosen === 0 &&
        afterClear?.checked === 0 &&
        afterClear?.matched === beforeClear?.matched &&
        afterClear?.visible === beforeClear?.visible,
      `清空前 已选=${beforeClear?.chosen}/匹配=${beforeClear?.matched}；清空后 已选=${afterClear?.chosen}/勾选=${afterClear?.checked}/匹配=${afterClear?.matched}`
    );
    await clickIn(page, '.modal.wide', '完成');
    await sleep(300);
  });

  phase('P4.4 容量与上限提示', async () => {
    await openPicker(page);
    await setReactInput(page, 'input[aria-label="搜索资料"]', 'P4 容量样本');
    await sleep(800);
    const bulk = await pickerState(page);
    report.counts.pickerBulk = bulk;
    record(
      'P4.4 选择器可完整匹配 400 条以上',
      (bulk?.matched ?? 0) >= 60,
      `匹配=${bulk?.matched}｜渲染行=${bulk?.visible}`
    );

    await clickIn(page, '.modal.wide', '全选匹配集');
    await sleep(1500);
    const bulkChosen = await pickerState(page);
    record(
      'P4.4 可一次全选 400 条以上',
      (bulkChosen?.chosen ?? 0) >= 60,
      `已选=${bulkChosen?.chosen}`
    );

    await clickIn(page, '.modal.wide', '完成');
    await sleep(500);
    await setReactInput(page, 'textarea[placeholder^="例如"]', '这批资料太多会怎样？');
    await sleep(300);
    await clickIn(page, '.actions', '生成提问包');
    await sleep(3000);
    const overflow = await page.evaluate(() => ({
      alert: document.querySelector('.alert')?.textContent?.trim() ?? '',
      hasPack: document.querySelector('pre.code') !== null,
    }));
    record(
      'P4.4 超出容量时明确提示且不静默截断',
      /超出提问包上限/.test(overflow.alert) && overflow.hasPack === false,
      `提示=「${overflow.alert}」｜生成出提问包=${overflow.hasPack}`
    );
  });

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

  report.ok = steps.every((step) => step.ok);
  const rel = writeReport(OUT_DIR, 'p4-browser-verification.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
