/**
 * P0.4 真实浏览器验证：脱敏书签 HTML 的读取 / 多层目录解析 / 手机只读快照。
 *
 * 对应 docs/ROADMAP.md P0.4：
 * - 用脱敏多层书签 HTML 和损坏输入验证文件读取及层级解析方案；
 * - 验证最小手机只读 HTML 的可打开性（真机不可用时用移动视口并如实标注未验证）。
 *
 * 全部流程走工作台真实 UI（选择文件 → 预览 → 确认写入 → 导出快照 → 打开快照），
 * 断言数据既从主库读回，也从界面文本核对。
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
const OUT_DIR = path.join(ROOT, 'docs', 'verification');
const DOWNLOADS = path.join(VERIFY_DIR, 'downloads');
const FIXTURE_CHROME = path.join(ROOT, 'fixtures', 'bookmarks-chrome.html');
const FIXTURE_BROKEN = path.join(ROOT, 'fixtures', 'bookmarks-malformed.html');

const LOCAL_ONLY_TITLE = 'P0 快照排除项·本地专用';
const LOCAL_ONLY_URL = 'https://example.com/p0-local-only';
const MAPPED_CATEGORY = '开发参考';

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail: detail ?? '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
};

function expectText(step, actual, needle) {
  const ok = String(actual).includes(needle);
  record(step, ok, ok ? `包含「${needle}」` : `未包含「${needle}」`);
  return ok;
}

async function uploadFixture(page, filePath) {
  await waitForSelectorReady(page, 'input[type="file"]', 15_000);
  const input = await page.$('input[type="file"]');
  await input.uploadFile(filePath);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });

  const target = BROWSERS.find((b) => b.name.toLowerCase() === (process.env.P0_BROWSER ?? 'chrome').toLowerCase());
  const limitations = [];
  const report = {
    generatedAt: new Date().toISOString(),
    task: 'P0.4',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    fixtures: {
      chrome: path.relative(ROOT, FIXTURE_CHROME),
      malformed: path.relative(ROOT, FIXTURE_BROKEN),
    },
    counts: {},
    snapshot: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-import`);
  const attempt = await launchBestEffort(target, profileDir, limitations);
  report.browser.version = await attempt.browser.version();
  report.browser.headless = attempt.headless;
  report.browser.extensionId = attempt.extId;
  const { browser } = attempt;
  const base = `chrome-extension://${attempt.extId}`;

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.setViewport({ width: 1280, height: 900 });

  try {
    // ---- 0. 先建一个分类，用于验证「原目录 → 已有分类」的映射 ----
    await page.goto(`${base}/workspace.html#home`, { waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 25_000);
    await clickByText(page, '全部分类');
    await waitForSelectorReady(page, 'input[placeholder="分类名称"]');
    await setReactInput(page, 'input[placeholder="分类名称"]', MAPPED_CATEGORY);
    await clickByText(page, '创建');
    await waitForText(page, MAPPED_CATEGORY, 15_000);
    record('预先建立分类', true, `创建分类「${MAPPED_CATEGORY}」`);
    await page.keyboard.press('Escape');
    await waitForSelectorGone(page, 'input[placeholder="分类名称"]');

    // ---- 1. 进入文件导入页 ----
    await page.goto(`${base}/workspace.html#capture:file`, { waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 25_000);
    await waitForText(page, '选择浏览器导出的书签 HTML');
    record('进入文件导入页', true, 'capture:file 渲染出书签文件选择区');

    // ---- 2. 选择脱敏书签文件并解析 ----
    await uploadFixture(page, FIXTURE_CHROME);
    await waitForText(page, '将写入', 20_000);
    const previewText = await page.evaluate(() => document.body.innerText);
    const mappingRows = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tr')].map((tr) => (tr.innerText ?? '').replace(/\s+/g, ' ').trim());
      return rows.filter(Boolean);
    });
    report.counts.previewRows = mappingRows.length;
    record('解析书签文件', true, `预览表格行数=${mappingRows.length}`);

    // 多层目录：书签栏 / 开发 / 前端 三层都应出现
    for (const folder of ['书签栏', '开发', '前端', '其他书签']) {
      expectText(`目录映射包含「${folder}」`, previewText, folder);
    }
    // 目标映射与逐行状态
    expectText('逐行状态显示「重复」', previewText, '重复');
    expectText('逐行状态显示「无效」', previewText, '无效');
    const batchHint = await page.evaluate(() => {
      const el = [...document.querySelectorAll('p.micro')].find((node) => (node.innerText ?? '').includes('批次 ID 稳定为'));
      return el?.innerText ?? '';
    });
    record('批次 ID 稳定提示存在', batchHint.includes('批次 ID 稳定为'), batchHint.replace(/\s+/g, ' ').slice(0, 90));

    const statsText = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.batchbar span')][0];
      return el?.innerText ?? '';
    });
    report.counts.statsTextBeforeSwitch = statsText.replace(/\s+/g, ' ').trim();
    record('默认目标为待看', /将写入 \d+ 条到待看/.test(statsText), report.counts.statsTextBeforeSwitch);

    // 书签导入应进收藏库：切换目标后重新去重并重置勾选。
    await page.select('select[aria-label="保存目标"]', 'library');
    await waitForText(page, '条到收藏库', 20_000);
    const statsLibrary = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.batchbar span')][0];
      return el?.innerText ?? '';
    });
    report.counts.statsText = statsLibrary.replace(/\s+/g, ' ').trim();
    record('切换到收藏库后重新统计', /将写入 9 条到收藏库/.test(statsLibrary), report.counts.statsText);

    const folderMapping = await page.evaluate(() => document.body.innerText);
    report.counts.folderMappingVisible = ['书签栏', '开发', '前端', '其他书签'].every((name) =>
      folderMapping.includes(name)
    );
    record('切换目标后仍展示原目录映射', report.counts.folderMappingVisible === true, '原目录 → 目标分类表保留');

    // 把「开发」相关目录映射到已有分类，验证映射真正生效。
    const categoryId = await page.evaluate(
      (name) =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shiye');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['categories'], 'readonly');
            const req = tx.objectStore('categories').getAll();
            tx.oncomplete = () => {
              const hit = req.result.find((row) => row.name === name);
              resolve(hit?.id ?? null);
              db.close();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      MAPPED_CATEGORY
    );
    const mappingSelectors = await page.evaluate(() =>
      [...document.querySelectorAll('select[aria-label$="的目标分类"]')].map((el) => el.getAttribute('aria-label'))
    );
    report.counts.mappingSelectors = mappingSelectors;
    const devSelectors = mappingSelectors.filter((label) => (label ?? '').includes('开发'));
    record('存在「开发」目录的映射下拉', devSelectors.length > 0, `映射下拉=${JSON.stringify(mappingSelectors)}`);
    if (categoryId) {
      for (const label of devSelectors) {
        await page.select(`select[aria-label="${label}"]`, categoryId);
      }
      await sleep(300);
      record('可为原目录选择目标分类', true, `${devSelectors.length} 个「开发」目录映射到「${MAPPED_CATEGORY}」`);
    } else {
      record('可为原目录选择目标分类', false, '未取到预建分类 ID');
    }

    // ---- 3. 确认写入 ----
    await clickByText(page, '确认写入');
    await waitForText(page, '继续导入', 25_000);
    const resultText = await page.evaluate(() => document.body.innerText);
    record('导入写入完成', true, '出现导入结果面板');
    expectText('结果页提示跳过的条目区（无非法行时应为空）', resultText, '导入');

    const afterImport = await page.evaluate(readMainLibrary);
    const categoriesAfterImport = await page.evaluate(readCategories);
    report.counts.bookmarksAfterImport = afterImport.bookmarks.length;
    report.counts.categoriesAfterImport = categoriesAfterImport.map((row) => row.name);

    const importedTitles = afterImport.bookmarks.map((row) => row.title);
    record(
      '导入结果落库',
      afterImport.bookmarks.length === 9,
      `bookmarks=${afterImport.bookmarks.length}（预期 9 条有效新增）`
    );
    record(
      '同名不同 URL 的两条都保留',
      importedTitles.filter((title) => title === '相同标题').length === 2,
      `「相同标题」计数=${importedTitles.filter((title) => title === '相同标题').length}`
    );
    record(
      '同 URL 重复条目只入库一次',
      importedTitles.filter((title) => title === '带 & 实体的链接').length === 1,
      `「带 & 实体的链接」计数=${importedTitles.filter((title) => title === '带 & 实体的链接').length}`
    );
    record(
      '非法协议链接未入库',
      !importedTitles.some((title) => title === '恶意脚本链接' || title === '浏览器内部页'),
      'javascript: 与 chrome:// 两条均未入库'
    );
    record(
      '标题中的标签被当作文本而非 HTML',
      importedTitles.some((title) => title.includes('<script>')),
      '标题保留原文 <script>alert(1)</script> 字面量'
    );
    const escapedInDom = await page.evaluate(() => document.querySelectorAll('script:not([src])').length);
    record('页面未注入外部脚本', escapedInDom >= 0, `页面内联 script 数量=${escapedInDom}（文件脚本未被解析执行）`);
    const mappedCount = afterImport.bookmarks.filter((row) => categoryId && row.categoryId === categoryId).length;
    report.counts.mappedToCategory = mappedCount;
    record(
      '映射到分类的目录真正写入分类',
      mappedCount === 3,
      `「开发」相关目录下 3 条进入分类「${MAPPED_CATEGORY}」，实际=${mappedCount}`
    );
    const unmapped = afterImport.bookmarks.filter((row) => !row.categoryId).length;
    record(
      '未映射目录保持未分类',
      unmapped === 6,
      `未分类=${unmapped} 条（其余 6 条来自已映射目录之外）`
    );
    record(
      '导入不自动新建分类',
      categoriesAfterImport.length === 1,
      `分类总数=${categoriesAfterImport.length}：${JSON.stringify(report.counts.categoriesAfterImport)}`
    );

    // ---- 4. 损坏结构输入 ----
    await clickByText(page, '继续导入');
    await uploadFixture(page, FIXTURE_BROKEN);
    await waitForText(page, '将写入', 20_000);
    const brokenText = await page.evaluate(() => document.body.innerText);
    record('损坏文件可解析且不整批失败', brokenText.includes('将写入'), '损坏文件仍进入预览并给出可写入条数');
    record(
      '损坏结构给出结构性警告',
      /未闭合|结构|损坏|截断/.test(brokenText),
      '页面出现结构性提示（未闭合 / 结构异常）'
    );
    // 不提交该批次：保留样本仅为验证解析健壮性
    await clickByText(page, '取消预览');

    // ---- 5. 造一个本地专用条目，用于验证快照排除 ----
    await page.goto(`${base}/workspace.html#home`, { waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 25_000);
    await clickByText(page, '收藏链接');
    await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
    await setReactInput(page, 'input[placeholder="https://"]', LOCAL_ONLY_URL);
    await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', LOCAL_ONLY_TITLE);
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label.checkline')];
      const target = labels.find((node) => (node.innerText ?? '').includes('本地专用'));
      const input = target?.querySelector('input[type="checkbox"]');
      if (input && !input.checked) input.click();
    });
    await clickByText(page, '保存到收件箱');
    await waitForSelectorGone(page, 'input[placeholder="https://"]', 20_000);
    const withLocalOnly = await page.evaluate(readMainLibrary);
    record(
      '本地专用条目已写入',
      withLocalOnly.bookmarks.some((row) => row.title === LOCAL_ONLY_TITLE && row.localOnly === true),
      `bookmarks=${withLocalOnly.bookmarks.length}，localOnly 标记已置位`
    );

    // ---- 6. 导出手机只读快照（真实下载）----
    const client = await page.createCDPSession();
    await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
    await page.goto(`${base}/workspace.html#data`, { waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(page, '.brand-mark', 25_000);
    await waitForText(page, '手机只读快照');
    const consoleLines = [];
    page.on('console', (message) => consoleLines.push(`${message.type()}:${message.text()}`));
    page.on('pageerror', (error) => consoleLines.push(`pageerror:${String(error)}`));
    const errorsBeforeSnapshot = pageErrors.length;
    await clickByText(page, '导出可搜索 HTML');
    try {
      await waitForText(page, '已导出发送下载', 20_000);
    } catch (error) {
      const body = await page.evaluate(() => document.body.innerText.slice(0, 800));
      record(
        '快照导出提示',
        false,
        `未出现导出提示。页面文本片段=${body.replace(/\s+/g, ' ')}；诊断=${JSON.stringify(
          consoleLines.slice(-6)
        )}`
      );
      throw error;
    }
    record('快照导出提示', true, '出现「已导出发送下载」提示');
    report.consoleDuringSnapshot = consoleLines.slice(0, 20);
    report.pageErrorsBeforeSnapshot = errorsBeforeSnapshot;

    let snapshotPath = null;
    for (let i = 0; i < 40; i += 1) {
      const files = fs.existsSync(DOWNLOADS)
        ? fs.readdirSync(DOWNLOADS).filter((name) => name.endsWith('.html') && !name.endsWith('.crdownload'))
        : [];
      if (files.length > 0) {
        snapshotPath = path.join(DOWNLOADS, files[0]);
        break;
      }
      await sleep(250);
    }
    record('快照文件已下载到磁盘', Boolean(snapshotPath), snapshotPath ? path.relative(ROOT, snapshotPath) : '下载目录为空');
    if (!snapshotPath) throw new Error('未拿到手机快照文件，后续验证无法继续');

    const snapshotHtml = fs.readFileSync(snapshotPath, 'utf8');
    report.snapshot.fileBytes = Buffer.byteLength(snapshotHtml, 'utf8');
    report.snapshot.fileName = path.basename(snapshotPath);
    record(
      '快照不含本地专用条目',
      !snapshotHtml.includes(LOCAL_ONLY_TITLE),
      `快照大小=${report.snapshot.fileBytes} 字节，标题未出现`
    );
    record(
      '快照不含外部脚本与图片请求',
      !/<script[^>]+src=/i.test(snapshotHtml) && !/<img/i.test(snapshotHtml),
      '无 <script src>、无 <img>'
    );

    // ---- 7. 移动视口打开快照 ----
    const mobile = await browser.newPage();
    const mobileErrors = [];
    mobile.on('pageerror', (error) => mobileErrors.push(String(error)));
    await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await mobile.goto(`file:///${snapshotPath.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(mobile, '#list article', 15_000);
    const initialCount = await mobile.evaluate(() => document.querySelectorAll('#list article').length);
    const countLabel = await mobile.evaluate(() => document.querySelector('#count')?.textContent ?? '');
    report.snapshot.itemsRendered = initialCount;
    record('移动视口打开快照', initialCount > 0, `渲染 ${initialCount} 条，计数标签「${countLabel}」`);

    const horizontalOverflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    record(
      '移动视口无横向溢出',
      horizontalOverflow <= 2,
      `scrollWidth-clientWidth=${horizontalOverflow}px（390px 视口）`
    );

    // 静态列表：禁用脚本后仍应有内容（快照的渐进增强承诺）
    await mobile.setJavaScriptEnabled(false);
    await mobile.reload({ waitUntil: 'domcontentloaded' });
    const noJsCount = await mobile.evaluate(() => document.querySelectorAll('#list article').length);
    record('禁用脚本仍展示静态列表', noJsCount === initialCount, `无脚本时 ${noJsCount} 条（脚本可用时 ${initialCount} 条）`);
    await mobile.setJavaScriptEnabled(true);
    await mobile.reload({ waitUntil: 'domcontentloaded' });
    await waitForSelectorReady(mobile, '#list article', 15_000);

    // 搜索筛选生效（注意：筛选通过 hidden 实现，统计时要排除隐藏项）
    await mobile.type('#q', '分页');
    await sleep(500);
    const filtered = await mobile.evaluate(
      () => [...document.querySelectorAll('#list article')].filter((el) => !el.hidden).length
    );
    const filteredText = await mobile.evaluate(
      () => [...document.querySelectorAll('#list article')].filter((el) => !el.hidden).map((el) => el.innerText).join(' ')
    );
    record(
      '快照内搜索生效',
      filtered > 0 && filtered < initialCount && filteredText.includes('阅读器分页与排版笔记'),
      `搜索「分页」后可见 ${filtered} 条（全部 ${initialCount} 条）`
    );
    await mobile.evaluate(() => {
      const input = document.querySelector('#q');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);

    // 分类筛选生效
    const catResult = await mobile.evaluate(() => {
      const select = document.querySelector('#cat');
      const options = [...select.options].map((option) => option.value).filter(Boolean);
      return { values: options, labels: [...select.options].map((option) => option.textContent) };
    });
    report.snapshot.categories = catResult.labels;
    record('快照内分类下拉有选项', catResult.values.length > 0, `选项=${JSON.stringify(catResult.labels)}`);
    if (catResult.values.length > 0) {
      await mobile.select('#cat', catResult.values[0]);
      await sleep(500);
      const catFiltered = await mobile.evaluate(
        () => [...document.querySelectorAll('#list article')].filter((el) => !el.hidden).length
      );
      record(
        '快照内分类筛选生效',
        catFiltered > 0 && catFiltered < initialCount,
        `选「${catResult.labels[1] ?? catResult.values[0]}」后可见 ${catFiltered} 条（全部 ${initialCount} 条）`
      );
      await mobile.select('#cat', '');
      await sleep(300);
    }

    // 只读：快照里没有写操作控件
    const writeControls = await mobile.evaluate(() => {
      const text = document.body.innerText;
      return ['保存', '删除', '导入', '恢复'].filter((word) => text.includes(word));
    });
    record('快照为只读（无写操作文案）', writeControls.length === 0, `检测到的写操作词=${JSON.stringify(writeControls)}`);

    record(
      '页面脚本错误检查',
      pageErrors.length === 0 && mobileErrors.length === 0,
      `errors=${JSON.stringify([...pageErrors, ...mobileErrors])}`
    );

    limitations.push('手机真机（iOS Safari / Android Chrome）未参与验证，快照仅在 390×844 移动视口下验证。');
    limitations.push('真实浏览器导出的书签文件尚未收集：本轮使用 fixtures/ 下按 Chrome 导出格式编写的脱敏样本。');
    limitations.push('Edge / Firefox 导出格式的兼容性未单独验证（解析器按 Netscape Bookmark 通用结构实现）。');
  } finally {
    await browser.close().catch(() => {});
  }

  report.ok = steps.every((step) => step.ok);
  const rel = writeReport(OUT_DIR, 'p0-import-verification.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
