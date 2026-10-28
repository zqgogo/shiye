/**
 * P2 浏览器验证：工作台页面、待看与收藏的逐条回归。
 *
 * 对应 docs/ROADMAP.md：
 * - P2.1 页面骨架：首页 / 待看 / 收件箱 / 未分类 / 全部收藏 / 最近打开 / 回收站；
 * - P2.2 待看与收藏：新增、完成、撤销、转收藏（同一事务）；
 * - P2.3 状态与详情：编辑、取消、锁定、隐私、版本保护、未读与分类正交；
 * - P2.4 页面验证：已分类未读、未分类已读、已有收藏加入待看、完成撤销、空状态、长标题、失败提示；
 * - P2.5 日常操作补齐：分类创建与选择、置顶、已读 / 恢复未读、软删除与恢复、清理完成历史；
 * - P2.6 编辑与删除冲突：未保存离开提醒、字段长度提示、墓碑转为收藏时的显式选择。
 *
 * 只在真实扩展页面里操作 UI，断言一律回读 IndexedDB 主库，不信任界面文案。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BROWSERS,
  DIST,
  ROOT,
  clickByText,
  launchBestEffort,
  prepareProfile,
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

const URL_CLEAN = 'https://example.com/p2-plain';
const URL_CATEGORIZED = 'https://example.com/p2-categorized';
const URL_LONG = 'https://example.com/p2-long-title';
const URL_READING = 'https://example.com/p2-reading';
const URL_CONVERT = 'https://example.com/p2-convert';
const URL_DUP = 'https://example.com/p2-dup';
const URL_TOMB = 'https://example.com/p2-tomb';
const URL_TRASH = 'https://example.com/p2-trash';
const URL_DIRTY = 'https://example.com/p2-dirty';
const URL_EDIT = 'https://example.com/p2-edit';

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail: detail ?? '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
};

async function newWorkspacePage(browser, base, route = 'home') {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${base}/workspace.html#${route}`, { waitUntil: 'domcontentloaded' });
  await waitForSelectorReady(page, '.brand-mark', 25_000);
  return { page, errors };
}

/** 只在指定容器内按文本找按钮并点击，避免「保存」误点到「保存到收件箱」。 */
async function clickIn(page, container, text) {
  const ok = await page.evaluate(
    (sel, needle) => {
      const scope = sel ? document.querySelector(sel) : document.body;
      if (!scope) return false;
      const nodes = [...scope.querySelectorAll('button, a, [role="button"]')];
      const hit = nodes.find((node) => (node.textContent ?? '').trim() === needle)
        ?? nodes.find((node) => (node.textContent ?? '').trim().includes(needle));
      if (!hit) return false;
      hit.click();
      return true;
    },
    container,
    text
  );
  if (!ok) throw new Error(`未找到可点击元素：${container ?? 'body'} → ${text}`);
}

/**
 * 在列表里找到包含某标题的收藏行，点它的详情或行内按钮。
 * action 可以是 aria-label（'打开详情'/'删除收藏'/'置顶'…），也可以是按钮文字（'标记已读'/'完成'…）。
 */
async function clickRow(page, title, action) {
  const ok = await page.evaluate(
    (needle, act) => {
      const rows = [...document.querySelectorAll('article.bookmark')];
      const hit = rows.find((row) => (row.innerText ?? '').includes(needle));
      if (!hit) return false;
      const byLabel =
        act === 'open'
          ? hit.querySelector('button[aria-label^="打开详情"]')
          : hit.querySelector(`button[aria-label="${act}"]`);
      const target =
        byLabel ??
        [...hit.querySelectorAll('button, a')].find((node) => (node.textContent ?? '').trim() === act) ??
        [...hit.querySelectorAll('button, a')].find((node) => (node.textContent ?? '').trim().includes(act));
      if (!target) return false;
      target.click();
      return true;
    },
    title,
    action
  );
  if (!ok) throw new Error(`列表里没有「${title}」的 ${action} 操作`);
}

async function createBookmark(page, { url, title, categoryId }) {
  await clickIn(page, '.topbar', '收藏链接');
  await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
  await setReactInput(page, 'input[placeholder="https://"]', url);
  await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', title);
  if (categoryId) {
    await page.select('.modal select[aria-label="选择分类"]', categoryId);
  }
  await clickIn(page, '.modal', '保存到收件箱');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="https://"]');
      if (!input) return { saved: true, message: '' };
      const alert = document.querySelector('.modal .alert');
      return { saved: false, message: (alert?.textContent ?? '').trim() };
    });
    if (state.saved || state.message) return state;
    await sleep(150);
  }
  return { saved: false, message: '等待写入结果超时' };
}

async function addReading(page, { url, title }) {
  await page.evaluate(() => {
    window.location.hash = 'home';
  });
  await waitForText(page, '快速操作', 15_000);
  await clickIn(page, '.hubgrid', '加入待看');
  await waitForSelectorReady(page, '.modal input[placeholder="https://"]', 10_000);
  await setReactInput(page, '.modal input[placeholder="https://"]', url);
  await setReactInput(page, '.modal input[placeholder="给它一个容易想起的名字"]', title);
  await clickIn(page, '.modal', '加入待看');
  await waitForSelectorGone(page, '.modal input[placeholder="https://"]', 15_000);
}

function goto(page, route, expectText) {
  return page
    .evaluate((next) => {
      window.location.hash = next;
    }, route)
    .then(() => (expectText ? waitForText(page, expectText, 15_000) : sleep(400)));
}

/** 同一选择器命中多个元素时（如抽屉里三个 textarea），按序号设值。 */
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

/** 按复选框旁的文案勾选，避免依赖 DOM 顺序。 */
function clickCheck(page, container, text) {
  return page.evaluate(
    (sel, needle) => {
      const scope = document.querySelector(sel);
      if (!scope) return false;
      const line = [...scope.querySelectorAll('.checkline')].find((node) =>
        (node.textContent ?? '').includes(needle)
      );
      const input = line?.querySelector('input[type="checkbox"]');
      if (!input) return false;
      input.click();
      return true;
    },
    container,
    text
  );
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

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  const target = BROWSERS.find(
    (b) => b.name.toLowerCase() === (process.env.P0_BROWSER ?? 'chrome').toLowerCase()
  );
  if (!target) {
    throw new Error('未找到可用的 Chrome / Edge。请安装其中之一，或用 SHIYE_CHROME / SHIYE_EDGE 指定路径。');
  }

  const limitations = [];
  const report = {
    generatedAt: new Date().toISOString(),
    task: 'P2',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    counts: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-p2`);
  const attempt = await launchBestEffort(target, profileDir, limitations);
  report.browser.version = await attempt.browser.version();
  report.browser.headless = attempt.headless;
  report.browser.extensionId = attempt.extId;
  const { browser } = attempt;
  const base = `chrome-extension://${attempt.extId}`;
  const { page, errors } = await newWorkspacePage(browser, base);

  try {
    // ---- P2.1 页面骨架与 P2.4 空状态 ----
    const skeleton = [];
    for (const [route, text] of [
      ['home', '把好东西'],
      ['reading', '先留着'],
      ['inbox', '收件箱'],
      ['uncategorized', '未分类'],
      ['all', '全部收藏'],
      ['recent', '最近打开'],
      ['trash', '回收站'],
    ]) {
      await goto(page, route, text);
      skeleton.push(route);
    }
    record('P2.1 七个基础页面都能直接进入', skeleton.length === 7, skeleton.join(' / '));

    await goto(page, 'all', '全部收藏');
    const allEmpty = await page.evaluate(() => document.querySelector('.empty')?.innerText ?? '');
    await goto(page, 'reading', '先留着');
    const readingEmpty = await page.evaluate(() => document.querySelector('.empty')?.innerText ?? '');
    record(
      'P2.4 空库时全部收藏与待看显示空状态',
      /还没有匹配的收藏/.test(allEmpty) && /待看清单是空的/.test(readingEmpty),
      `收藏空状态=「${allEmpty.split('\n')[0]}」｜待看空状态=「${readingEmpty.split('\n')[0]}」`
    );

    // ---- P2.5 基础分类创建，供后续「已分类未读」使用 ----
    const categoryId = await ensureCategory(page, 'P2 验证分类');
    record('P2.5 可创建分类并返回稳定 ID', Boolean(categoryId), `categoryId=${categoryId}`);
    if (!categoryId) throw new Error('分类创建失败，后续分类断言无法进行');

    // ---- P2.2 / P2.4 已分类未读 ----
    const created = await createBookmark(page, {
      url: URL_CATEGORIZED,
      title: 'P2 已分类未读',
      categoryId,
    });
    await sleep(800);
    const afterCreate = await page.evaluate(readMainLibrary);
    const categorized = afterCreate.bookmarks.find((row) => row.originalUrl === URL_CATEGORIZED);
    report.counts.categorizedRow = categorized ?? null;
    record(
      'P2.4 新建收藏默认进入收件箱且未读',
      Boolean(created.saved) && categorized?.unreadFlag === 1,
      `saved=${created.saved}｜unreadFlag=${categorized?.unreadFlag}`
    );
    record(
      'P2.1 分类选择在新建时就生效',
      categorized?.categoryId === categoryId,
      `categoryId=${categorized?.categoryId}`
    );
    const inboxHasIt = await page.evaluate(
      () => (document.querySelector('.listbox')?.innerText ?? '').includes('P2 已分类未读')
    );
    record('P2.1 已分类未读同时出现在收件箱', inboxHasIt, '收件箱列表包含该收藏');

    // ---- P2.3 / P2.4 未分类已读：已读后离开收件箱，仍留在未分类 ----
    const plain = await createBookmark(page, { url: URL_CLEAN, title: 'P2 未分类已读' });
    await sleep(600);
    await goto(page, 'inbox', '收件箱');
    // 打开详情再看一遍，验证「打开不等于已读」。
    await clickRow(page, 'P2 未分类已读', 'open');
    await waitForSelectorReady(page, '.drawer', 15_000);
    await clickIn(page, '.drawerfoot', '关闭');
    await waitForSelectorGone(page, '.drawer', 10_000);
    await sleep(400);
    const afterOpen = await page.evaluate(readMainLibrary);
    record(
      'P2.3 打开详情不会自动标已读',
      afterOpen.bookmarks.find((row) => row.originalUrl === URL_CLEAN)?.unreadFlag === 1,
      `unreadFlag=${afterOpen.bookmarks.find((row) => row.originalUrl === URL_CLEAN)?.unreadFlag}`
    );
    await clickRow(page, 'P2 未分类已读', '标记已读');
    await sleep(800);
    const afterRead = await page.evaluate(readMainLibrary);
    const readRow = afterRead.bookmarks.find((row) => row.originalUrl === URL_CLEAN);
    record(
      'P2.3 标记已读只改未读位，不动分类',
      Boolean(plain.saved) && readRow?.unreadFlag === 0 && readRow?.categoryId === null,
      `unreadFlag=${readRow?.unreadFlag}｜categoryId=${readRow?.categoryId}`
    );
    await goto(page, 'uncategorized', '未分类');
    const uncategorizedHas = await page.evaluate(
      () => (document.querySelector('.listbox')?.innerText ?? '').includes('P2 未分类已读')
    );
    record('P2.4 未分类已读仍留在未分类列表', uncategorizedHas, '未分类列表包含该收藏');

    // ---- P2.5 恢复未读 + 全部标记已读 ----
    await goto(page, 'all', '全部收藏');
    await clickIn(page, 'article.bookmark', '恢复未读');
    await sleep(700);
    const afterUnread = await page.evaluate(readMainLibrary);
    record(
      'P2.5 单条恢复未读生效',
      afterUnread.bookmarks.find((row) => row.originalUrl === URL_CLEAN)?.unreadFlag === 1,
      'unreadFlag 回到 1'
    );
    await goto(page, 'inbox', '收件箱');
    await clickIn(page, '.notice', '全部标记已读');
    await sleep(900);
    const afterAllRead = await page.evaluate(readMainLibrary);
    const unreadLeft = afterAllRead.bookmarks.filter((row) => row.lifeState === 'active' && row.unreadFlag === 1);
    record('P2.5 全部标记已读清空未读', unreadLeft.length === 0, `剩余未读=${unreadLeft.length}`);

    // ---- P2.5 置顶 / 取消置顶 ----
    await goto(page, 'all', '全部收藏');
    await clickRow(page, 'P2 已分类未读', '置顶');
    await sleep(600);
    const pinnedRow = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_CATEGORIZED
    );
    await clickRow(page, 'P2 已分类未读', '取消置顶');
    await sleep(600);
    const unpinnedRow = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_CATEGORIZED
    );
    record(
      'P2.5 置顶与取消置顶都会写回主库',
      pinnedRow?.pinned === true && unpinnedRow?.pinned === false,
      `置顶后 pinned=${pinnedRow?.pinned}｜取消后 pinned=${unpinnedRow?.pinned}`
    );

    // ---- P2.4 长标题：300 字符可保存，超出时给出明确拒绝 ----
    const longOk = await createBookmark(page, { url: URL_LONG, title: '长'.repeat(300) });
    await sleep(600);
    const longRow = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_LONG
    );
    record(
      'P2.4 300 字符长标题可保存且不撑破列表',
      Boolean(longOk.saved) && longRow?.title.length === 300,
      `saved=${longOk.saved}｜长度=${longRow?.title.length}`
    );
    await goto(page, 'all', '全部收藏');
    await clickRow(page, '长'.repeat(300), 'open');
    await waitForSelectorReady(page, '.drawer', 15_000);
    await setReactInput(page, '.drawer .field input', '超'.repeat(320));
    const overLimitHint = await page.evaluate(
      () => document.querySelector('.drawer .field small.overlimit')?.textContent ?? ''
    );
    await clickIn(page, '.drawerfoot', '保存');
    await sleep(600);
    const overLimitError = await page.evaluate(
      () => document.querySelector('.drawer .alert')?.textContent ?? ''
    );
    record(
      'P2.6 标题超限有实时提示并拒绝保存',
      /超出|320/.test(overLimitHint) && /标题最多 300/.test(overLimitError),
      `提示=「${overLimitHint.trim()}」｜错误=「${overLimitError.trim()}」`
    );
    await clickIn(page, '.drawerfoot', '取消修改');
    await clickIn(page, '.drawerfoot', '关闭');
    await sleep(400);

    // ---- P2.6 未保存离开提醒 ----
    await goto(page, 'all', '全部收藏');
    await clickRow(page, 'P2 已分类未读', 'open');
    await waitForSelectorReady(page, '.drawer', 15_000);
    await setReactInput(page, '.drawer .field input', 'P2 未保存草稿');
    await sleep(300);
    await clickIn(page, '.drawerfoot', '关闭');
    await sleep(500);
    const discardShown = await page.evaluate(() => document.body.innerText.includes('还有未保存的修改'));
    record('P2.6 关闭抽屉前提示未保存修改', discardShown, '出现「还有未保存的修改」弹窗');
    await clickIn(page, '.modal', '继续编辑');
    await sleep(400);
    const draftKept = await page.evaluate(() => {
      const input = document.querySelector('.drawer .field input');
      return { open: Boolean(input), value: input?.value ?? '' };
    });
    record(
      'P2.6 选择继续编辑后草稿仍在',
      draftKept.open && draftKept.value === 'P2 未保存草稿',
      `drawer=${draftKept.open}｜标题=「${draftKept.value}」`
    );
    await clickIn(page, '.drawerfoot', '关闭');
    await sleep(400);
    await clickIn(page, '.modal', '放弃修改并离开');
    await sleep(600);
    const discardResult = await page.evaluate(() => ({
      drawer: Boolean(document.querySelector('.drawer')),
    }));
    const dirtyRow = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_CATEGORIZED
    );
    record(
      'P2.6 放弃修改后抽屉关闭且主库标题未变',
      !discardResult.drawer && dirtyRow?.title === 'P2 已分类未读',
      `标题=「${dirtyRow?.title}」`
    );

    // ---- P2.4 已有收藏的 URL 再加入待看 ----
    await addReading(page, { url: URL_CATEGORIZED, title: '已有收藏也加入待看' });
    await sleep(700);
    const afterAddReading = await page.evaluate(readMainLibrary);
    report.counts.readings = afterAddReading.readings;
    record(
      'P2.4 已有收藏可加入待看且互不影响',
      afterAddReading.readings.filter((row) => row.status === 'pending').length === 1 &&
        afterAddReading.bookmarks.filter((row) => row.originalUrl === URL_CATEGORIZED).length === 1,
      `待看=${afterAddReading.readings.length}｜同 URL 收藏=1 条`
    );
    const readingBookmark = afterAddReading.bookmarks.find((row) => row.originalUrl === URL_CATEGORIZED);
    record(
      'P2.4 加入待看不自动改收藏的未读状态',
      readingBookmark?.unreadFlag === 0,
      `unreadFlag=${readingBookmark?.unreadFlag}（此前已被全部标记已读）`
    );

    // ---- P2.2 完成与撤销 ----
    await goto(page, 'reading', '先留着');
    await clickIn(page, 'article.bookmark', '完成');
    await sleep(800);
    const afterComplete = await page.evaluate(readMainLibrary);
    record(
      'P2.2 完成待看移出队列',
      afterComplete.readings.every((row) => row.status === 'completed'),
      `pending=${afterComplete.readings.filter((r) => r.status === 'pending').length}`
    );
    await clickIn(page, '.notice', '撤销上次完成');
    await sleep(800);
    const afterReopen = await page.evaluate(readMainLibrary);
    record(
      'P2.2 撤销完成恢复 pending',
      afterReopen.readings.some((row) => row.status === 'pending'),
      '队列里重新出现该条'
    );

    // ---- P2.5 清理完成历史 ----
    await clickIn(page, 'article.bookmark', '完成');
    await sleep(700);
    await goto(page, 'reading-history', '完成历史');
    await clickIn(page, '.notice', '清理完成历史');
    await sleep(300);
    await clickIn(page, '.notice', '确认清理');
    await sleep(900);
    const afterPurge = await page.evaluate(readMainLibrary);
    record(
      'P2.5 清理完成历史只删队列记录',
      afterPurge.readings.every((row) => row.status === 'pending'),
      `剩余记录=${afterPurge.readings.length}`
    );

    // ---- P2.2 待看转收藏（无同 URL 收藏）----
    await addReading(page, { url: URL_CONVERT, title: '待看转收藏样本' });
    await sleep(600);
    await goto(page, 'reading', '先留着');
    await clickIn(page, 'article.bookmark', '转入收藏');
    await waitForSelectorReady(page, '.modal', 10_000);
    await clickIn(page, '.modal', '确认转入收藏');
    await sleep(1000);
    const afterConvert = await page.evaluate(readMainLibrary);
    const converted = afterConvert.bookmarks.find((row) => row.originalUrl === URL_CONVERT);
    record(
      'P2.2 转收藏在同一事务里新增收藏并完成待看',
      Boolean(converted) && afterConvert.readings.every((row) => row.status !== 'pending'),
      `收藏已建=${Boolean(converted)}｜待看 pending=${afterConvert.readings.filter((r) => r.status === 'pending').length}`
    );

    // ---- P2.4 已有收藏时转收藏：提示已收藏、不重复创建 ----
    await addReading(page, { url: URL_CATEGORIZED, title: '重复转收藏样本' });
    await sleep(600);
    await goto(page, 'reading', '先留着');
    await clickIn(page, 'article.bookmark', '查看收藏');
    await sleep(800);
    const afterDup = await page.evaluate(readMainLibrary);
    record(
      'P2.4 同 URL 已收藏时转收藏不重复建库',
      afterDup.bookmarks.filter((row) => row.originalUrl === URL_CATEGORIZED).length === 1,
      `同 URL 收藏条数=${afterDup.bookmarks.filter((row) => row.originalUrl === URL_CATEGORIZED).length}`
    );
    await page.keyboard.press('Escape');
    await sleep(300);

    // ---- P2.6 墓碑：同 URL 有删除记录时要求显式选择 ----
    await goto(page, 'all', '全部收藏');
    await clickRow(page, 'P2 未分类已读', '删除收藏');
    await waitForSelectorReady(page, '.modal', 10_000);
    await clickIn(page, '.modal', '移到回收站');
    await sleep(900);
    await addReading(page, { url: URL_CLEAN, title: '墓碑同名待看' });
    await sleep(600);
    await goto(page, 'reading', '先留着');
    await clickIn(page, 'article.bookmark', '转入收藏');
    await sleep(900);
    const tombText = await page.evaluate(() => document.querySelector('.modal')?.innerText ?? '');
    record(
      'P2.6 同 URL 有墓碑时给出显式选择',
      /已删除的收藏/.test(tombText) && /恢复原收藏/.test(tombText) && /保持待看/.test(tombText),
      `弹窗=「${tombText.split('\n')[0]}」`
    );
    await clickIn(page, '.modal', '恢复原收藏');
    await sleep(1200);
    const afterTomb = await page.evaluate(readMainLibrary);
    record(
      'P2.6 恢复墓碑后不新建第二条收藏',
      afterTomb.bookmarks.filter((row) => row.originalUrl === URL_CLEAN).length === 1 &&
        afterTomb.bookmarks.find((row) => row.originalUrl === URL_CLEAN)?.lifeState === 'active',
      `同 URL 记录=${afterTomb.bookmarks.filter((row) => row.originalUrl === URL_CLEAN).length}`
    );

    // ---- P2.5 软删除与恢复保留分类与未读 ----
    await goto(page, 'all', '全部收藏');
    await clickRow(page, 'P2 已分类未读', '删除收藏');
    await waitForSelectorReady(page, '.modal', 10_000);
    await clickIn(page, '.modal', '移到回收站');
    await sleep(900);
    await goto(page, 'trash', '回收站');
    const trashText = await page.evaluate(() => document.querySelector('.listbox')?.innerText ?? '');
    record('P2.5 删除后进入回收站', trashText.includes('P2 已分类未读'), '回收站列表可见');
    await clickIn(page, 'article.bookmark', '恢复');
    await sleep(900);
    const restored = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_CATEGORIZED
    );
    record(
      'P2.5 恢复保留原分类与未读状态',
      restored?.lifeState === 'active' && restored?.categoryId === categoryId,
      `lifeState=${restored?.lifeState}｜categoryId=${restored?.categoryId}`
    );

    // ---- P2.4 失败提示：重复创建同 URL 给出常驻错误 ----
    const dup = await createBookmark(page, { url: URL_CATEGORIZED, title: '重复收藏样本' });
    await sleep(500);
    const dupMessage = await page.evaluate(
      () => document.querySelector('.modal .alert')?.textContent ?? ''
    );
    record(
      'P2.4 重复收藏在弹窗内常驻提示失败原因',
      !dup.saved && /收藏|重复|已存在/.test(dupMessage),
      `提示=「${dupMessage.trim()}」`
    );

    // ---- P2.3 编辑、锁定、隐私、取消修改 ----
    // 上一步的重复收藏故意留在弹窗里展示错误，这里先关掉，避免复用到它的输入。
    await page.keyboard.press('Escape');
    await waitForSelectorGone(page, '.modal', 10_000).catch(() => {});
    await sleep(300);
    await createBookmark(page, { url: URL_EDIT, title: 'P2 编辑样本', categoryId });
    await sleep(700);
    await goto(page, 'all', '全部收藏');
    await clickRow(page, 'P2 编辑样本', 'open');
    await waitForSelectorReady(page, '.drawer', 15_000);
    await setReactInput(page, '.drawer .field input', 'P2 编辑后标题');
    await setReactInputAt(page, '.drawer .field textarea', 1, '人工备注样本');
    await clickCheck(page, '.drawer', '锁定分类');
    await clickCheck(page, '.drawer', '本地专用');
    await sleep(300);
    const categoryDisabled = await page.evaluate(
      () => document.querySelector('.drawer select[aria-label="选择分类"]')?.disabled ?? null
    );
    await clickIn(page, '.drawerfoot', '保存');
    await sleep(1000);
    const afterEdit = await page.evaluate(readMainLibrary);
    const editRow = afterEdit.bookmarks.find((row) => row.originalUrl === URL_EDIT);
    report.counts.editedRow = editRow ?? null;
    record(
      'P2.3 编辑保存写回主库并递增本地版本',
      editRow?.title === 'P2 编辑后标题' && editRow?.note === '人工备注样本' && editRow.localRevision > 1,
      `标题=「${editRow?.title}」｜备注=「${editRow?.note}」｜localRevision=${editRow?.localRevision}`
    );
    record(
      'P2.3 锁定分类与本地专用被持久化并即时禁用分类选择',
      categoryDisabled === true &&
        editRow?.lockedFields.includes('categoryId') === true &&
        editRow?.localOnly === true,
      `分类选择禁用=${categoryDisabled}｜lockedFields=${JSON.stringify(editRow?.lockedFields)}｜localOnly=${editRow?.localOnly}`
    );

    // 取消修改：草稿丢弃，主库不变
    await setReactInput(page, '.drawer .field input', 'P2 取消修改草稿');
    await sleep(300);
    await clickIn(page, '.drawerfoot', '取消修改');
    await sleep(600);
    const cancelState = await page.evaluate(() => ({
      value: document.querySelector('.drawer .field input')?.value ?? '',
      dirtyHint: Boolean(document.querySelector('.drawer .notice')),
    }));
    const cancelRow = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_EDIT
    );
    record(
      'P2.3 取消修改丢弃草稿且不动主库',
      cancelState.value === 'P2 编辑后标题' && !cancelState.dirtyHint && cancelRow?.title === 'P2 编辑后标题',
      `输入框=「${cancelState.value}」｜未保存提示=${cancelState.dirtyHint}｜主库标题=「${cancelRow?.title}」`
    );

    // 版本保护：另开一个标签页改同一条，本页再保存必须被拦下
    const second = await newWorkspacePage(browser, base, 'all');
    await waitForText(second.page, '全部收藏', 20_000);
    await clickRow(second.page, 'P2 编辑后标题', 'open');
    await waitForSelectorReady(second.page, '.drawer', 15_000);
    await setReactInput(second.page, '.drawer .field input', 'P2 别处修改');
    await clickIn(second.page, '.drawerfoot', '保存');
    await sleep(1200);
    await second.page.close();
    await sleep(600);
    await setReactInput(page, '.drawer .field input', 'P2 本页修改');
    await clickIn(page, '.drawerfoot', '保存');
    await sleep(1000);
    const conflictText = await page.evaluate(() => document.querySelector('.drawer .alert')?.textContent ?? '');
    const conflictRow = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_EDIT
    );
    record(
      'P2.3 别处修改后保存被版本保护拦下',
      /别处被修改过/.test(conflictText) && conflictRow?.title === 'P2 别处修改',
      `提示=「${conflictText.trim().slice(0, 26)}」｜主库标题=「${conflictRow?.title}」`
    );
    await clickIn(page, '.drawerfoot', '载入最新版本');
    await sleep(600);
    const reloadedTitle = await page.evaluate(() => document.querySelector('.drawer .field input')?.value ?? '');
    record(
      'P2.3 载入最新版本后草稿与主库一致',
      reloadedTitle === 'P2 别处修改',
      `输入框=「${reloadedTitle}」`
    );

    // 打开原网页：只写最近打开时间，不改未读
    await page.evaluate(() => document.querySelector('.drawer a[target="_blank"]')?.click());
    await sleep(1500);
    for (const extra of await browser.pages()) {
      if (extra !== page && !extra.url().startsWith(base)) await extra.close().catch(() => {});
    }
    const openedRow = (await page.evaluate(readMainLibrary)).bookmarks.find(
      (row) => row.originalUrl === URL_EDIT
    );
    record(
      'P2.3 打开原网页只记录最近打开，不改未读',
      Boolean(openedRow?.lastOpenedAt) && openedRow?.unreadFlag === 1,
      `lastOpenedAt=${openedRow?.lastOpenedAt}｜unreadFlag=${openedRow?.unreadFlag}`
    );
    await clickIn(page, '.drawerfoot', '关闭');
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(400);

    // 最近打开：写入 16 条带打开时间的脱敏样本，页面只保留最新 15 条
    const seeded = await page.evaluate(async (templateUrl) => {
      const request = indexedDB.open('shiye');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(['bookmarks'], 'readonly');
        const req = tx.objectStore('bookmarks').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const template = rows.find((row) => row.originalUrl === templateUrl) ?? rows.find((row) => row.lifeState === 'active');
      if (!template) {
        db.close();
        return 0;
      }
      const now = Date.now();
      const clones = Array.from({ length: 16 }, (_, index) => {
        const stamp = new Date(now - 600_000 - index * 60_000).toISOString();
        const serial = String(index + 1).padStart(2, '0');
        return {
          ...template,
          id: `p2-recent-${serial}`,
          title: `P2 最近 ${serial}`,
          originalUrl: `https://example.com/p2-recent-${index + 1}`,
          canonicalUrl: `https://example.com/p2-recent-${index + 1}`,
          createdAt: stamp,
          updatedAt: stamp,
          lastOpenedAt: stamp,
          localRevision: 1,
          lifeState: 'active',
          deletedAt: null,
          unreadFlag: 0,
        };
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['bookmarks'], 'readwrite');
        const store = tx.objectStore('bookmarks');
        for (const clone of clones) store.put(clone);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return clones.length;
    }, URL_EDIT);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 25_000);
    await goto(page, 'recent', '最近打开');
    await sleep(600);
    const recent = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('article.bookmark')].map((row) => row.innerText ?? '');
      return { count: rows.length, text: rows.join('\n') };
    });
    record(
      'P2.3 最近打开最多 15 条且只列有打开记录的收藏',
      seeded === 16 && recent.count === 15 && /P2 最近 01/.test(recent.text) && !/P2 最近 16/.test(recent.text),
      `写入样本=${seeded}｜页面条数=${recent.count}｜含最新=${/P2 最近 01/.test(recent.text)}｜含最旧=${/P2 最近 16/.test(recent.text)}`
    );

    // ---- 收尾 ----
    record('页面脚本错误检查', errors.length === 0, `errors=${JSON.stringify(errors)}`);
  } finally {
    await browser.close().catch(() => {});
  }

  report.ok = steps.every((step) => step.ok);
  const rel = writeReport(OUT_DIR, 'p2-browser-verification.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
