/**
 * P5 浏览器验证：手动 AI 交接与安全应用。
 *
 * 对应 docs/ROADMAP.md：
 * - P5.1 交接数据：材料包结构、白名单字段、指纹、策略版本、批次与编号映射的本地持久化；
 * - P5.2 导入和预览：严格校验、逐条可应用/拒绝/过期原因，刷新后续接本机批次；
 * - P5.3 应用与撤销：事务内复核版本/隐私/锁定/引用，只写分类标签与 AI 用途，撤销不覆盖后续修改；
 * - P5.5 手动提问通道：提问包可预览、有上限、两类操作不混用；
 * - P5.6 策略与快照规则：策略版本变化、隐私变化使旧结果失效。
 *
 * 造数策略与 P4 一致：先用界面建 1 条真实收藏当模板，再用原生 IndexedDB 复制出
 * 「本地专用 / 禁止 AI / 锁定分类 / 已删除」四种变体。派生键与真实写入保持一致，
 * 界面读得动，用例层也认。
 *
 * 所有断言回读 IndexedDB 主库或页面渲染文本。每个阶段单独 try/catch，
 * 某阶段抛错只记一条 FAIL，后续阶段继续跑。
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

const URL_TEMPLATE = 'https://example.com/p5-template';
const T_LIBRARY = 'P5 合法样本';
const T_LOCKED = 'P5 锁定样本';
const T_LOCAL_ONLY = 'P5 本地专用';
const T_AI_BLOCKED = 'P5 禁止AI';
const T_DELETED = 'P5 已删除';
const CATEGORY_NAME = 'P5 目标分类';
const PURPOSE = '用于 P5 回归验证';

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

/** 整页重新加载：只有 hash 不同属同文档跳转，React 不会重挂载，必须显式 reload。 */
async function reloadWorkspace(page, base, hash = 'home') {
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

/** 读取若干张表的全部记录（用于回读批次、应用日志与收藏）。 */
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
                selectedText: '',
                categoryId: null,
                categoryKey: 'uncategorized',
                tagIds: [],
                inboxUnread: sample.unread !== false,
                unreadFlag: sample.unread === false ? 0 : 1,
                pinned: false,
                lastOpenedAt: null,
                lifeState: sample.deleted === true ? 'deleted' : 'active',
                deletedAt: sample.deleted === true ? now : null,
                lockedFields: sample.lockedFields ?? [],
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

/** 直接改一条收藏（模拟「应用之后又被人改过」或隐私开关变化）。 */
function patchBookmark(page, id, patch, bumpRevision = false) {
  return page.evaluate(
    (bookmarkId, changes, bump) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('shiye');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('bookmarks', 'readwrite');
          const store = tx.objectStore('bookmarks');
          const read = store.get(bookmarkId);
          read.onsuccess = () => {
            const current = read.result;
            if (!current) {
              reject(new Error('没有找到这条收藏'));
              return;
            }
            const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
            if (bump) {
              next.revision = current.revision + 1;
              next.localRevision = current.localRevision + 1;
            }
            store.put(next);
          };
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
    id,
    patch,
    bumpRevision
  );
}

async function createBookmark(page, { url, title }) {
  await goto(page, 'home', '快速操作');
  await clickIn(page, '.topbar', '收藏链接');
  await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
  await setReactInput(page, 'input[placeholder="https://"]', url);
  await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', title);
  await clickIn(page, '.modal', '保存到收件箱');
  // 写入成功时保存弹窗会关闭；失败时 .alert 会常驻，两种情况都别无限等。
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="https://"]');
      if (!input) return { saved: true, message: '' };
      return { saved: false, message: (document.querySelector('.modal .alert')?.textContent ?? '').trim() };
    });
    if (state.saved) return state;
    if (state.message) throw new Error(`新建收藏失败：${state.message}`);
    await sleep(150);
  }
  throw new Error('新建收藏等待写入结果超时');
}

/** 材料包原文（整理页的 pre 里就是那份 JSON）。 */
function materialText(page) {
  return page.evaluate(() => document.querySelector('pre.code')?.textContent ?? '');
}

function organizeSummary(page) {
  return page.evaluate(() => {
    const panel = [...document.querySelectorAll('.panel')].find((node) =>
      (node.innerText ?? '').includes('逐条确认修改')
    );
    if (!panel) return null;
    const head = (panel.querySelector('p')?.innerText ?? '').replace(/\s+/g, ' ').trim();
    return {
      head,
      applied: /可应用\s*(\d+)\s*条/.exec(head)?.[1] ?? '?',
      rejected: /需处理\s*(\d+)\s*条/.exec(head)?.[1] ?? '?',
      rejectReasons: [...panel.querySelectorAll('.diff .bad')].map((node) => node.innerText.trim()),
      revertText: panel.querySelector('[aria-label="撤销结果"]')?.innerText?.trim() ?? '',
    };
  });
}

/** 生成一份整理材料包并返回 JSON 与对应的库内批次。 */
async function generatePack(page, base) {
  // 上一阶段可能停在整理页的第 2/3 步；只改 hash 不会重新挂载，必须整页重载回第 1 步。
  await reloadWorkspace(page, base, 'organize');
  await waitForSelectorReady(page, '.two .panel select', 15_000);
  await page.select('.two .panel select', 'all');
  await sleep(300);
  await clickIn(page, '.two', '生成材料包');
  await waitForSelectorReady(page, 'textarea[aria-label="AI 回复"]', 20_000);
  await sleep(300);
  const text = await materialText(page);
  const parsed = JSON.parse(text);
  const stores = await readStores(page, ['handoffBatches', 'handoffItems']);
  return { text, material: parsed, stores };
}

async function submitReply(page, reply) {
  await setReactInput(page, 'textarea[aria-label="AI 回复"]', reply);
  await clickIn(page, '.panel', '校验并预览');
  await sleep(1200);
  return page.evaluate(() => ({
    alert: document.querySelector('.panel .alert')?.innerText?.trim() ?? '',
    onPreview: document.body.innerText.includes('逐条确认修改'),
  }));
}

function suggestion(n, overrides = {}) {
  return {
    n,
    domain: 'example.com',
    titleEcho: overrides.titleEcho ?? '样本',
    patch: overrides.patch ?? { categoryId: null },
    reason: overrides.reason ?? '内容匹配',
    status: overrides.status ?? 'ok',
    ...(overrides.extra ?? {}),
  };
}

function replyFor(batchId, results) {
  return JSON.stringify({ protocolVersion: 2, batchId, part: 1, results }, null, 2);
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
    '「实际发送字段经用户确认」在本版本体现为：材料包在本地拼装、可由用户逐字检查与复制，且不发起网络请求；未做逐字段勾选确认，因为按设计全部白名单字段都会出现在材料包中。',
    '剪贴板失败路径需要真实的权限拒绝，自动化环境里 navigator.clipboard 通常可用，本轮只验证按钮存在与提示文案来源（单测与代码覆盖），不做拒绝注入。',
    '内置 AI 通道（P7）未实现，本轮不验证其启用、测试连接与凭据隔离。',
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    task: 'P5',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    counts: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-p5`);
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

  const ctx = { ids: {}, categoryId: null, pack: null, batchId: null };

  const phases = [];
  const phase = (label, fn) => phases.push({ label, fn });

  // ---- 准备：真实收藏模板 + 四种变体 + 一个目标分类 ----
  phase('准备：样本与分类', async () => {
    await createBookmark(page, { url: URL_TEMPLATE, title: 'P5 模板收藏' });
    const created = await seedSamples(page, [
      { url: 'https://example.com/p5-library', title: T_LIBRARY, note: '人工备注不许改' },
      { url: 'https://example.com/p5-locked', title: T_LOCKED, lockedFields: ['categoryId'] },
      { url: 'https://example.com/p5-local', title: T_LOCAL_ONLY, localOnly: true },
      { url: 'https://example.com/p5-blocked', title: T_AI_BLOCKED, aiBlocked: true },
      { url: 'https://example.com/p5-deleted', title: T_DELETED, deleted: true },
    ]);
    ctx.ids = created;

    await goto(page, 'rules', '管理分类');
    await clickIn(page, '.heading', '管理分类');
    await waitForSelectorReady(page, '.modal.wide', 10_000);
    await setReactInput(page, '.modal.wide input[placeholder="分类名称"]', CATEGORY_NAME);
    await clickIn(page, '.modal.wide', '创建');
    await sleep(600);
    const stores = await readStores(page, ['categories', 'bookmarks']);
    ctx.categoryId = stores.categories.find((row) => row.name === CATEGORY_NAME)?.id ?? null;
    record(
      'P5.1 样本就绪：隐私、锁定与已删除各一条',
      Boolean(ctx.categoryId) && stores.bookmarks.length === 6,
      `收藏=${stores.bookmarks.length}｜分类=${ctx.categoryId ? '有' : '无'}`
    );
    await clickIn(page, '.modal.wide', '完成').catch(() => {});
    await sleep(300);
  });

  // ---- P5.1 材料包结构与批次持久化 ----
  phase('P5.1 材料包与批次落库', async () => {
    const { text, material, stores } = await generatePack(page, base);
    ctx.pack = { text, material, batchId: material.batchId };
    ctx.batchId = material.batchId;

    const titles = material.items.map((item) => item.title);
    record(
      'P5.1 材料包排除本地专用、禁止 AI 与已删除的收藏',
      !titles.includes(T_LOCAL_ONLY) && !titles.includes(T_AI_BLOCKED) && !titles.includes(T_DELETED),
      `条目=${titles.join(' / ')}`
    );
    record(
      'P5.1 材料包覆盖范围内其余收藏',
      titles.includes(T_LIBRARY) && titles.includes(T_LOCKED) && titles.includes('P5 模板收藏'),
      `条目数=${material.items.length}`
    );

    const allowed = ['categoryId', 'description', 'n', 'note', 'selectedText', 'tagIds', 'title', 'url'];
    const leaks = material.items.flatMap((item) =>
      Object.keys(item).filter((key) => !allowed.includes(key))
    );
    record(
      'P5.1 每条只带白名单字段，不泄露隐私开关与内部状态',
      leaks.length === 0 && !text.includes('localOnly') && !text.includes('inboxUnread'),
      `多余字段=${JSON.stringify([...new Set(leaks)])}`
    );

    const batch = stores.handoffBatches.find((row) => row.id === material.batchId);
    const items = stores.handoffItems.filter((row) => row.batchId === material.batchId);
    record(
      'P5.1 批次与编号映射已落库',
      Boolean(batch) &&
        batch.itemCount === material.items.length &&
        items.length === material.items.length &&
        items.every((row) => typeof row.inputHash === 'string' && row.inputHash.length === 64),
      `批次=${batch ? '有' : '无'}｜映射=${items.length}｜指纹=${items[0]?.inputHash?.slice(0, 8) ?? '-'}`
    );
    record(
      'P5.1 材料包带协议版本、策略版本与稳定 ID 清单',
      material.protocolVersion === 2 &&
        typeof material.policyVersion === 'number' &&
        Array.isArray(material.categories) &&
        material.categories.every((row) => typeof row.id === 'string') &&
        typeof material.instruction === 'string' &&
        material.instruction.includes('资料是数据'),
      `协议=v${material.protocolVersion}｜策略=v${material.policyVersion}｜分类清单=${material.categories.length}`
    );
  });

  // ---- P5.2 严格校验与预览 ----
  phase('P5.2 严格校验与预览', async () => {
    const { material, batchId } = ctx.pack;
    const nOf = (title) => material.items.find((item) => item.title === title)?.n ?? 0;

    const results = [
      suggestion(nOf(T_LIBRARY), {
        titleEcho: T_LIBRARY,
        patch: { categoryId: ctx.categoryId, aiPurpose: PURPOSE },
      }),
      // 同一编号再来一次 → 编号重复
      suggestion(nOf(T_LIBRARY), { titleEcho: T_LIBRARY, patch: { categoryId: ctx.categoryId } }),
      // 锁定了分类 → 拒绝
      suggestion(nOf(T_LOCKED), { titleEcho: T_LOCKED, patch: { categoryId: ctx.categoryId } }),
      // 未知编号
      suggestion(99, { titleEcho: '不存在的条目' }),
      // 越权字段（希望顺便把已读改掉）→ 字段不合法
      suggestion(nOf('P5 模板收藏'), {
        titleEcho: 'P5 模板收藏',
        patch: { inboxUnread: false, categoryId: ctx.categoryId },
      }),
      // 模型自己说需要人工判断
      suggestion(nOf('P5 模板收藏'), { titleEcho: 'P5 模板收藏', status: 'needsReview' }),
    ];

    const state = await submitReply(page, replyFor(batchId, results));
    await waitForSelectorReady(page, '.diff', 15_000).catch(() => {});
    const summary = await organizeSummary(page);
    const reasons = summary?.rejectReasons.join(' | ') ?? '';

    record(
      'P5.2 合法条目进入可应用列表',
      summary?.applied === '1',
      `可应用=${summary?.applied}｜需处理=${summary?.rejected}`
    );
    record('P5.2 重复编号被单独拒绝', reasons.includes('编号重复'), `原因=${reasons.slice(0, 120)}`);
    record('P5.2 未知编号被单独拒绝', reasons.includes('未知编号'), `原因=${reasons.slice(0, 120)}`);
    record('P5.2 越权字段被单独拒绝', reasons.includes('字段不合法'), `原因=${reasons.slice(0, 120)}`);
    record(
      'P5.2 锁定分类的条目被拒绝',
      reasons.includes('分类已被人工锁定'),
      `原因=${reasons.slice(0, 120)}`
    );
    record(
      'P5.2 模型标记 needsReview 的不自动应用',
      reasons.includes('需要人工判断'),
      `原因=${reasons.slice(0, 120)}`
    );

    const after = await readStores(page, ['bookmarks', 'handoffItems']);
    const target = after.bookmarks.find((row) => row.id === ctx.ids[T_LIBRARY]);
    record(
      'P5.2 校验不等于应用：预览阶段主库没有变化',
      target?.categoryId === null && target?.aiPurpose === '',
      `分类=${target?.categoryId ?? 'null'}｜用途=「${target?.aiPurpose ?? ''}」`
    );

    const stored = after.handoffItems.filter((row) => row.batchId === batchId);
    record(
      'P5.2 校验结论回写编号映射',
      stored.some((row) => row.status === 'invalid') && stored.some((row) => row.status === 'pending'),
      `invalid=${stored.filter((row) => row.status === 'invalid').length}｜pending=${stored.filter((row) => row.status === 'pending').length}`
    );
  });

  // ---- P5.3 应用 ----
  phase('P5.3 应用只写授权字段', async () => {
    await clickIn(page, '.panel', '应用勾选项');
    await sleep(1500);
    const stores = await readStores(page, ['bookmarks', 'appliedChanges', 'handoffBatches']);
    const applied = stores.bookmarks.find((row) => row.id === ctx.ids[T_LIBRARY]);
    const original = stores.bookmarks.find((row) => row.id === ctx.ids['P5 模板收藏']);
    const change = stores.appliedChanges.find((row) => row.batchId === ctx.batchId);

    record(
      'P5.3 应用写入建议的分类与 AI 用途',
      applied?.categoryId === ctx.categoryId && applied?.aiPurpose === PURPOSE,
      `分类=${applied?.categoryId === ctx.categoryId}｜用途=「${applied?.aiPurpose ?? ''}」`
    );
    record(
      'P5.3 不修改人工备注与未读状态',
      applied?.note === '人工备注不许改' && applied?.inboxUnread === true,
      `备注=「${applied?.note}」｜未读=${applied?.inboxUnread}`
    );
    record(
      'P5.3 未勾选的条目保持原样',
      original?.categoryId === null && original?.aiPurpose === '',
      `模板收藏分类=${original?.categoryId ?? 'null'}`
    );
    record(
      'P5.3 应用日志记录前后值与批次',
      Boolean(change) &&
        change.before.categoryId === null &&
        change.after.categoryId === ctx.categoryId &&
        change.changedFields.includes('aiPurpose') &&
        change.undoneAt === null,
      `变更字段=${JSON.stringify(change?.changedFields ?? [])}`
    );
    const batch = stores.handoffBatches.find((row) => row.id === ctx.batchId);
    record(
      'P5.3 批次状态随应用更新',
      batch?.status === 'applied' || batch?.status === 'partial',
      `状态=${batch?.status}`
    );
    ctx.appliedRevision = applied?.localRevision ?? null;
  });

  // ---- P5.3 撤销 ----
  phase('P5.3 撤销与冲突', async () => {
    await clickIn(page, '.panel', '撤销本次应用');
    await sleep(1500);
    const stores = await readStores(page, ['bookmarks', 'appliedChanges']);
    const restored = stores.bookmarks.find((row) => row.id === ctx.ids[T_LIBRARY]);
    const change = stores.appliedChanges.find((row) => row.batchId === ctx.batchId);
    record(
      'P5.3 撤销把分类与用途还原',
      restored?.categoryId === null && restored?.aiPurpose === '',
      `分类=${restored?.categoryId ?? 'null'}｜用途=「${restored?.aiPurpose ?? ''}」`
    );
    record(
      'P5.3 撤销保留人工备注',
      restored?.note === '人工备注不许改',
      `备注=「${restored?.note}」`
    );
    record(
      'P5.3 撤销标记应用日志而不删除',
      Boolean(change?.undoneAt),
      `undoneAt=${change?.undoneAt ?? 'null'}`
    );
  });

  // ---- P5.3 冲突：应用后又被人工改过 ----
  phase('P5.3 应用后再修改的条目不撤销', async () => {
    const { material, batchId } = await generatePack(page, base);
    ctx.conflictBatchId = batchId;
    const n = material.items.find((item) => item.title === T_LIBRARY)?.n ?? 0;
    const results = [
      suggestion(n, {
        titleEcho: T_LIBRARY,
        patch: { categoryId: ctx.categoryId, aiPurpose: PURPOSE },
      }),
    ];
    await submitReply(page, replyFor(batchId, results));
    await waitForSelectorReady(page, '.diff', 15_000).catch(() => {});
    await clickIn(page, '.panel', '应用勾选项');
    await sleep(1500);

    // 模拟「应用之后用户自己又改了这条」：版本前进一格，撤销必须让路。
    await patchBookmark(page, ctx.ids[T_LIBRARY], { note: '应用后我自己改的' }, true);
    await clickIn(page, '.panel', '撤销本次应用');
    await sleep(1500);

    const stores = await readStores(page, ['bookmarks']);
    const kept = stores.bookmarks.find((row) => row.id === ctx.ids[T_LIBRARY]);
    const notice = await page.evaluate(
      () => document.querySelector('[aria-label="撤销结果"]')?.innerText?.trim() ?? ''
    );
    record(
      'P5.3 应用后又被修改的条目不撤销，保留人工修改',
      kept?.note === '应用后我自己改的' && kept?.aiPurpose === PURPOSE && notice.includes('未撤销'),
      `备注=「${kept?.note}」｜用途=「${kept?.aiPurpose}」｜提示=「${notice.slice(0, 40)}」`
    );
  });

  // ---- P5.2 刷新续接 ----
  phase('P5.2 刷新后续接同一批次', async () => {
    const { material, batchId, text } = await generatePack(page, base);
    ctx.resumeBatchId = batchId;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 20_000);
    await goto(page, 'organize', '整理，让收藏各归其位');
    await sleep(800);
    const banner = await page.evaluate(() => {
      const panel = document.querySelector('[aria-label="在途批次"]');
      return panel ? panel.innerText.replace(/\s+/g, ' ').trim() : '';
    });
    record(
      'P5.2 刷新后提示可以续接上一批',
      banner.includes(batchId.slice(0, 8)) && banner.includes(String(material.items.length)),
      `横幅=「${banner.slice(0, 80)}」`
    );

    await clickIn(page, '[aria-label="在途批次"]', '继续这一批');
    await waitForSelectorReady(page, 'textarea[aria-label="AI 回复"]', 15_000);
    await sleep(400);
    const resumed = await materialText(page);
    record(
      'P5.2 续接拿回的是同一份材料原文',
      resumed.trim() === text.trim() && resumed.includes(batchId),
      `同原文=${resumed.trim() === text.trim()}｜长度=${resumed.length}`
    );
  });

  // ---- P5.2 丢弃批次 ----
  phase('P5.2 丢弃后不再提示续接', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 20_000);
    await goto(page, 'organize', '整理，让收藏各归其位');
    await sleep(800);
    await clickIn(page, '[aria-label="在途批次"]', '丢弃');
    await sleep(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 20_000);
    await goto(page, 'organize', '整理，让收藏各归其位');
    await sleep(800);
    const stillThere = await page.evaluate(
      () => document.querySelector('[aria-label="在途批次"]') !== null
    );
    record('P5.2 丢弃后不再提示续接', stillThere === false, `仍提示=${stillThere}`);
  });

  // ---- P5.6 策略变化使旧结果失效 ----
  phase('P5.6 策略版本变化后旧回复被拒绝', async () => {
    const { material, batchId } = await generatePack(page, base);
    await goto(page, 'rules', '整理策略');
    await sleep(400);
    await setReactInput(page, 'textarea', '这是 P5 回归改过的整理策略');
    await clickIn(page, '.panel', '保存并升级策略版本');
    await sleep(1000);

    await goto(page, 'organize', '整理，让收藏各归其位');
    await sleep(900);
    const hasBanner = await page.evaluate(
      () => document.querySelector('[aria-label="在途批次"]') !== null
    );
    if (hasBanner) {
      await clickIn(page, '[aria-label="在途批次"]', '继续这一批');
      await waitForSelectorReady(page, 'textarea[aria-label="AI 回复"]', 15_000);
    }
    const n = material.items.find((item) => item.title === T_LIBRARY)?.n ?? 0;
    const state = await submitReply(
      page,
      replyFor(batchId, [suggestion(n, { titleEcho: T_LIBRARY, patch: { aiPurpose: '过期建议' } })])
    );
    record(
      'P5.6 策略变更后旧回复被拒绝',
      /整理策略已更新/.test(state.alert) && state.onPreview === false,
      `提示=「${state.alert}」｜进入预览=${state.onPreview}`
    );
  });

  // ---- P5.6 隐私变化使旧结果失效 ----
  phase('P5.6 隐私变化后旧回复被拒绝', async () => {
    const { material, batchId } = await generatePack(page, base);
    const n = material.items.find((item) => item.title === T_LIBRARY)?.n ?? 0;
    // 导出之后才把这条设成本地专用：材料已在手上，但仍不能应用。
    await patchBookmark(page, ctx.ids[T_LIBRARY], {
      privacy: { localOnly: true, aiBlocked: false },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 20_000);
    await goto(page, 'organize', '整理，让收藏各归其位');
    await sleep(900);
    const hasBanner = await page.evaluate(
      () => document.querySelector('[aria-label="在途批次"]') !== null
    );
    if (hasBanner) {
      await clickIn(page, '[aria-label="在途批次"]', '继续这一批');
      await waitForSelectorReady(page, 'textarea[aria-label="AI 回复"]', 15_000);
    }
    await submitReply(
      page,
      replyFor(batchId, [suggestion(n, { titleEcho: T_LIBRARY, patch: { aiPurpose: '不该应用' } })])
    );
    await waitForSelectorReady(page, '.diff', 15_000).catch(() => {});
    const summary = await organizeSummary(page);
    const reasons = summary?.rejectReasons.join(' | ') ?? '';
    const stores = await readStores(page, ['bookmarks']);
    const target = stores.bookmarks.find((row) => row.id === ctx.ids[T_LIBRARY]);
    record(
      'P5.6 隐私开关变化后旧回复被拒绝',
      reasons.includes('隐私设置已禁止发送') && target?.aiPurpose !== '不该应用',
      `原因=${reasons.slice(0, 100)}｜用途=「${target?.aiPurpose ?? ''}」`
    );
    // 复原，避免影响后面的提问包断言。
    await patchBookmark(page, ctx.ids[T_LIBRARY], { privacy: { localOnly: false, aiBlocked: false } });
  });

  // ---- P5.5 提问包 ----
  phase('P5.5 提问包与两类操作边界', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 20_000);
    await goto(page, 'ask', '问一问');
    await sleep(500);

    await setReactInput(page, '.panel textarea', '这些资料适合用来做什么？');
    await clickIn(page, '.panel', '选择资料');
    await waitForSelectorReady(page, '.modal.wide', 10_000);
    const pickerText = await page.evaluate(
      () => document.querySelector('.modal.wide')?.innerText ?? ''
    );
    record(
      'P5.5 资料选择器不列本地专用与禁止 AI 的条目',
      !pickerText.includes(T_LOCAL_ONLY) && !pickerText.includes(T_AI_BLOCKED),
      `含本地专用=${pickerText.includes(T_LOCAL_ONLY)}｜含禁止AI=${pickerText.includes(T_AI_BLOCKED)}`
    );
    const picked = await page.evaluate((needle) => {
      const rows = [...document.querySelectorAll('.modal.wide label.checkline')];
      const hit = rows.find((row) => (row.innerText ?? '').includes(needle));
      const box = hit?.querySelector('input[type="checkbox"]');
      if (!box) return false;
      box.click();
      return true;
    }, T_LIBRARY);
    record('P5.5 可勾选一条资料', picked === true, `勾选=${picked}`);
    await clickIn(page, '.modal.wide', '完成选择');
    await sleep(400);

    await clickIn(page, '.panel', '生成提问包');
    await sleep(1200);
    const packText = await materialText(page);
    const packMeta = await page.evaluate(() => {
      const panel = [...document.querySelectorAll('.panel')].find((node) =>
        (node.innerText ?? '').includes('提问包')
      );
      return panel?.querySelector('p')?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
    });
    record(
      'P5.5 提问包包含问题与所选资料',
      packText.includes('这些资料适合用来做什么') && packText.includes(T_LIBRARY),
      `字符=${packMeta.slice(0, 40)}`
    );
    record(
      'P5.5 提问包不含未选与隐私条目',
      !packText.includes(T_LOCKED) && !packText.includes(T_LOCAL_ONLY),
      `含锁定样本=${packText.includes(T_LOCKED)}`
    );
    const boundary = await page.evaluate(() => ({
      askHasApply: document.body.innerText.includes('应用勾选项'),
      askHasQuestion: document.body.innerText.includes('你想了解什么'),
    }));
    record(
      'P5.5 提问页不出现整理应用入口',
      boundary.askHasApply === false && boundary.askHasQuestion === true,
      `有应用入口=${boundary.askHasApply}`
    );

    // 空问题必须给出明确提示，而不是生成一个没有问题的包。
    await setReactInput(page, '.panel textarea', '');
    await clickIn(page, '.panel', '生成提问包');
    await sleep(800);
    const emptyAlert = await page.evaluate(
      () => document.querySelector('.panel .alert')?.innerText?.trim() ?? ''
    );
    record('P5.5 空问题给出明确提示', /请先填写问题/.test(emptyAlert), `提示=「${emptyAlert}」`);
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
  const rel = writeReport(OUT_DIR, 'p5-browser-verification.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
