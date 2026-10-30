/**
 * P1 浏览器验证：并发、版本保护、墓碑与旧数据迁移。
 *
 * 对应 docs/ROADMAP.md：
 * - P1.4 事务与验证：重复创建、版本冲突、未分类索引、旧数据迁移、关闭重开；
 * - P1.5 数据保护基础：旧格式迁移与字段限制；
 * - P1.6 并发与删除规则：多窗口并发下的 URL 去重、版本比较、墓碑与显式恢复。
 *
 * 关键点：这些检查必须用**两个真实的浏览器标签页**（两条独立 IndexedDB 连接）来跑，
 * 单元测试里的同进程 fake-indexeddb 无法代表多上下文并发。
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
  readCategories,
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
const LEGACY_BACKUP = path.join(ROOT, 'fixtures', 'legacy-backup-v1.json');

const RACE_URL = 'https://example.com/p1-race-same-url';
const VERSION_URL = 'https://example.com/p1-version-guard';
const TOMB_URL = 'https://example.com/p1-tombstone';

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail: detail ?? '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
};

async function newWorkspacePage(browser, base, route) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${base}/workspace.html#${route}`, { waitUntil: 'domcontentloaded' });
  await waitForSelectorReady(page, '.brand-mark', 25_000);
  return { page, errors };
}

/**
 * 在新建收藏弹窗里提交，并等待「成功（弹窗关闭）」或「失败（弹窗内出现错误提示）」。
 * 失败时弹窗保持打开是产品预期行为，因此不能只等弹窗消失。
 */
async function createBookmark(page, url, title) {
  await clickByText(page, '收藏链接');
  await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
  await setReactInput(page, 'input[placeholder="https://"]', url);
  await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', title);
  await clickByText(page, '保存到收件箱');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder="https://"]');
      if (!input) return { saved: true, message: '' };
      const alert = document.querySelector('.modal .alert');
      return { saved: false, message: (alert?.textContent ?? '').trim() };
    });
    if (state.saved) return state;
    if (state.message) return state;
    await sleep(150);
  }
  return { saved: false, message: '等待写入结果超时' };
}

async function closeModalIfOpen(page) {
  const open = await page.evaluate(() => Boolean(document.querySelector('input[placeholder="https://"]')));
  if (open) {
    await page.keyboard.press('Escape');
    await waitForSelectorGone(page, 'input[placeholder="https://"]', 8000).catch(() => {});
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });

  const target = BROWSERS.find((b) => b.name.toLowerCase() === (process.env.P0_BROWSER ?? 'chrome').toLowerCase());
  const limitations = [];
  const report = {
    generatedAt: new Date().toISOString(),
    task: 'P1',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    counts: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-p1`);
  const attempt = await launchBestEffort(target, profileDir, limitations);
  report.browser.version = await attempt.browser.version();
  report.browser.headless = attempt.headless;
  report.browser.extensionId = attempt.extId;
  const { browser } = attempt;
  const base = `chrome-extension://${attempt.extId}`;

  const a = await newWorkspacePage(browser, base, 'home');
  const b = await newWorkspacePage(browser, base, 'home');

  try {
    // ---- 1. 多标签并发创建同一 URL ----
    const raceResults = await Promise.all([
      createBookmark(a.page, RACE_URL, 'P1 并发 A'),
      createBookmark(b.page, RACE_URL, 'P1 并发 B'),
    ]);
    await sleep(600);
    const afterRace = await a.page.evaluate(readMainLibrary);
    const sameUrlRows = afterRace.bookmarks.filter((row) => row.originalUrl === RACE_URL);
    report.counts.raceRows = sameUrlRows.length;
    report.counts.raceResults = raceResults;
    record(
      '两标签并发创建同一 URL 只入库一条',
      sameUrlRows.length === 1,
      `同 URL 记录数=${sameUrlRows.length}（两条独立 IDB 连接同时写入）`
    );
    const rejected = raceResults.filter((entry) => !entry.saved);
    record(
      '并发失败方被明确拒绝并给出原因',
      rejected.length === 1 && /收藏|重复|已存在/.test(rejected[0].message),
      `失败方提示=「${rejected[0]?.message ?? '无'}」`
    );
    await closeModalIfOpen(rejected.length === 1 ? a.page : b.page);

    // ---- 2. 版本保护：A 打开详情后 B 修改，A 再保存 ----
    const versionCreate = await createBookmark(a.page, VERSION_URL, 'P1 版本保护');
    if (!versionCreate.saved) throw new Error(`版本保护样本创建失败：${versionCreate.message}`);
    await sleep(400);
    const created = await a.page.evaluate(readMainLibrary);
    const versionRow = created.bookmarks.find((row) => row.originalUrl === VERSION_URL);
    report.counts.versionStartRevision = versionRow?.localRevision ?? null;

    // A 打开详情（此时记录基线版本）
    await a.page.evaluate((url) => {
      window.location.hash = 'all';
      const walk = () => {
        const rows = [...document.querySelectorAll('.bookmark, article, li')];
        const hit = rows.find((node) => (node.innerText ?? '').includes('P1 版本保护'));
        const button = hit?.querySelector('button[aria-label^="打开详情"]');
        if (button) button.click();
        return Boolean(button);
      };
      if (!walk()) setTimeout(walk, 300);
    }, VERSION_URL);
    await waitForSelectorReady(a.page, '.drawer', 15_000);
    record('详情抽屉打开', true, 'A 标签页载入版本基线');

    // B 通过详情改标题并保存
    await b.page.evaluate(() => {
      window.location.hash = 'all';
    });
    await waitForText(b.page, 'P1 版本保护', 15_000);
    await b.page.evaluate(() => {
      const walk = () => {
        const rows = [...document.querySelectorAll('.bookmark, article, li')];
        const hit = rows.find((node) => (node.innerText ?? '').includes('P1 版本保护'));
        const button = hit?.querySelector('button[aria-label^="打开详情"]');
        if (button) button.click();
        return Boolean(button);
      };
      if (!walk()) setTimeout(walk, 300);
    });
    await waitForSelectorReady(b.page, '.drawer', 15_000);
    await setReactInput(b.page, '.drawer .field input', 'P1 版本保护·B 改过');
    await clickByText(b.page, '保存');
    await waitForText(b.page, '已保存', 15_000);
    await sleep(800);
    const afterB = await b.page.evaluate(readMainLibrary);
    const bRow = afterB.bookmarks.find((row) => row.originalUrl === VERSION_URL);
    report.counts.afterBSave = { title: bRow?.title, localRevision: bRow?.localRevision };
    record(
      'B 标签页保存成功并递增版本',
      bRow?.title === 'P1 版本保护·B 改过' && bRow.localRevision > (versionRow?.localRevision ?? 0),
      `title=${bRow?.title}｜localRevision=${bRow?.localRevision}（起始 ${versionRow?.localRevision}）`
    );

    // A 用旧基线保存 → 应被拒
    await setReactInput(a.page, '.drawer .field input', 'P1 版本保护·A 后写');
    await clickByText(a.page, '保存');
    await waitForText(a.page, '被修改过', 15_000).catch(() => {});
    const aDrawerText = await a.page.evaluate(() => document.querySelector('.drawer')?.innerText ?? '');
    const conflictShown = /被修改过|版本/.test(aDrawerText) && /载入最新版本/.test(aDrawerText);
    record('A 用旧版本保存被拒绝并提示载入最新版本', conflictShown, '抽屉内出现版本冲突提示与「载入最新版本」');

    const afterConflict = await a.page.evaluate(readMainLibrary);
    const conflictRow = afterConflict.bookmarks.find((row) => row.originalUrl === VERSION_URL);
    record(
      'A 的旧草稿没有覆盖 B 的修改',
      conflictRow?.title === 'P1 版本保护·B 改过',
      `主库标题仍为「${conflictRow?.title}」（未被「P1 版本保护·A 后写」覆盖）`
    );

    // 载入最新版本后可以再次保存
    await clickByText(a.page, '载入最新版本');
    await sleep(300);
    await setReactInput(a.page, '.drawer .field input', 'P1 版本保护·A 二改');
    await clickByText(a.page, '保存');
    await waitForText(a.page, '已保存', 15_000);
    await sleep(600);
    const afterReapply = await a.page.evaluate(readMainLibrary);
    const reapplied = afterReapply.bookmarks.find((row) => row.originalUrl === VERSION_URL);
    record(
      '载入最新版本后保存成功',
      reapplied?.title === 'P1 版本保护·A 二改',
      `title=${reapplied?.title}｜localRevision=${reapplied?.localRevision}`
    );

    // ---- 3. 墓碑：删除后另一标签用同 URL 新建应被拦 ----
    const tombCreate = await createBookmark(a.page, TOMB_URL, 'P1 墓碑样本');
    if (!tombCreate.saved) throw new Error(`墓碑样本创建失败：${tombCreate.message}`);
    await sleep(400);
    await a.page.evaluate(() => {
      window.location.hash = 'all';
    });
    await waitForText(a.page, 'P1 墓碑样本', 15_000);
    await a.page.evaluate(() => {
      const walk = () => {
        const rows = [...document.querySelectorAll('.bookmark, article, li')];
        const hit = rows.find((node) => (node.innerText ?? '').includes('P1 墓碑样本'));
        const button = hit?.querySelector('button[aria-label="删除收藏"]');
        if (button) button.click();
        return Boolean(button);
      };
      if (!walk()) setTimeout(walk, 300);
    });
    await waitForText(a.page, '删除', 10_000);
    await a.page.evaluate(() => {
      const confirm = [...document.querySelectorAll('button')].find((node) =>
        /移到回收站|确认删除|删除收藏/.test(node.textContent ?? '')
      );
      confirm?.click();
    });
    await sleep(1200);
    const afterDelete = await a.page.evaluate(readMainLibrary);
    const tombRow = afterDelete.bookmarks.find((row) => row.originalUrl === TOMB_URL);
    record('删除写入墓碑（lifeState=deleted）', tombRow?.lifeState === 'deleted', `lifeState=${tombRow?.lifeState}`);

    await b.page.evaluate(() => {
      window.location.hash = 'home';
    });
    await waitForText(b.page, '安放链接');
    const tombRecreate = await createBookmark(b.page, TOMB_URL, 'P1 墓碑样本·重建');
    await sleep(600);
    const afterRecreate = await b.page.evaluate(readMainLibrary);
    const tombRows = afterRecreate.bookmarks.filter((row) => row.originalUrl === TOMB_URL);
    record(
      '同 URL 重建被墓碑拦下',
      tombRows.length === 1 && tombRows[0].lifeState === 'deleted',
      `同 URL 记录=${tombRows.length}，lifeState=${tombRows[0]?.lifeState}`
    );
    const bText = await b.page.evaluate(() => document.body.innerText);
    record(
      '拦截时给出明确提示',
      !tombRecreate.saved && /回收站|删除|恢复/.test(tombRecreate.message + bText),
      `失败方提示=「${tombRecreate.message}」`
    );
    await closeModalIfOpen(b.page);

    // ---- 4. 未读与分类正交 ----
    await a.page.evaluate(() => {
      window.location.hash = 'inbox';
    });
    await waitForText(a.page, '收件箱');
    const unreadBefore = (await a.page.evaluate(readMainLibrary)).bookmarks.filter(
      (row) => row.lifeState === 'active' && row.unreadFlag === 1
    ).length;
    await a.page.evaluate(() => {
      const walk = () => {
        const rows = [...document.querySelectorAll('.bookmark, article, li')];
        const hit = rows.find((node) => (node.innerText ?? '').includes('P1 版本保护'));
        const button = hit?.querySelector('button[aria-label^="打开详情"]');
        if (button) button.click();
        return Boolean(button);
      };
      if (!walk()) setTimeout(walk, 300);
    });
    await waitForSelectorReady(a.page, '.drawer', 15_000);
    // 通过详情做一次真实修改（改标题），验证未读状态不被连带改变
    await setReactInput(a.page, '.drawer .field input', 'P1 版本保护·A 二改·再编辑');
    await clickByText(a.page, '保存');
    await waitForText(a.page, '已保存', 15_000);
    await sleep(600);
    const unreadAfter = (await a.page.evaluate(readMainLibrary)).bookmarks.filter(
      (row) => row.lifeState === 'active' && row.unreadFlag === 1
    ).length;
    record(
      '打开详情并保存不改变未读状态',
      unreadAfter === unreadBefore,
      `未读条数 ${unreadBefore} → ${unreadAfter}（保存的是标题，不是「已读」）`
    );

    // ---- 5. 旧格式（schemaVersion 1）备份恢复 ----
    await a.page.evaluate(() => {
      window.location.hash = 'data';
    });
    await waitForText(a.page, '恢复备份');
    const restoreInput = await a.page.evaluateHandle(() => {
      const inputs = [...document.querySelectorAll('input[type="file"]')];
      return inputs[inputs.length - 1] ?? null;
    });
    if (restoreInput.asElement()) {
      await restoreInput.asElement().uploadFile(LEGACY_BACKUP);
      await sleep(1200);
      const parsed = await a.page.evaluate(() => document.body.innerText);
      record('旧备份可被解析并预览', /合并|替换|条收藏/.test(parsed), '恢复区域出现数量与时间预览');
      await clickByText(a.page, '合并恢复');
      await sleep(1500);
      const afterRestore = await a.page.evaluate(readMainLibrary);
      const legacyTitles = afterRestore.bookmarks.filter((row) => row.title === "旧的临时链接").length;
      report.counts.afterRestore = afterRestore.bookmarks.length;
      record('旧备份记录已合并进主库', legacyTitles > 0, `匹配旧备份标题=${legacyTitles}｜总收藏=${afterRestore.bookmarks.length}`);

      const rawKeys = await a.page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open('shiye');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction(['bookmarks'], 'readonly');
              const req = tx.objectStore('bookmarks').getAll();
              tx.oncomplete = () => {
                resolve(req.result.map((row) => Object.keys(row)));
                db.close();
              };
              tx.onerror = () => reject(tx.error);
            };
          })
      );
      const flatKeys = rawKeys.flat();
      record(
        '旧字段 valueLevel / valueReason 已被清理',
        !flatKeys.includes('valueLevel') && !flatKeys.includes('valueReason'),
        `记录字段数=${new Set(flatKeys).size}，无价值等级字段`
      );
      record(
        '派生索引键已就位',
        flatKeys.includes('lifeState') && flatKeys.includes('unreadFlag') && flatKeys.includes('categoryKey'),
        'lifeState / unreadFlag / categoryKey 均存在'
      );
    } else {
      record('旧备份可被解析并预览', false, '未找到恢复用的文件输入框');
    }

    // ---- 6. 收尾：无脚本错误 ----
    record(
      '页面脚本错误检查',
      a.errors.length === 0 && b.errors.length === 0,
      `errors=${JSON.stringify([...a.errors, ...b.errors])}`
    );
  } finally {
    await browser.close().catch(() => {});
  }

  report.ok = steps.every((step) => step.ok);
  const rel = writeReport(OUT_DIR, 'p1-browser-verification.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
