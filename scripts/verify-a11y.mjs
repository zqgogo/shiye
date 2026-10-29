/**
 * 整体交付：键盘与小屏可用性验证。
 *
 * 对应 docs/ROADMAP.md「整体交付」第 3 条与验收清单
 * 「键盘焦点、Tab、Escape、长链接、小屏与错误提示已实际检查」。
 *
 * 这些检查不读设计稿，只用键盘和尺寸说话：
 * - Tab 在对话框里循环，Shift+Tab 不会退到遮罩后的页面；
 * - 打开时焦点进到第一个输入框，Escape 关闭后焦点回到刚才那个按钮；
 * - 错误提示在弹窗里可读，且焦点没有被踢出去；
 * - 超长标题 / 超长 URL 不把页面撑出横向滚动；
 * - 375×667 与 320×568 下没有横向溢出，手机快照在 375 宽也能读。
 *
 * 焦点相关断言全部用真实 keydown（CDP 输入），不靠 element.focus()：
 * 后者不会触发 :focus-visible，量出来的样式是假的。
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

const LONG_TITLE = `超长标题${'无可断点'.repeat(28)}结尾`;
const LONG_URL = `https://example.com/path/${'segment-'.repeat(40)}?q=${'x'.repeat(120)}`;

const steps = [];
const record = (step, ok, detail) => {
  steps.push({ step, ok, detail: detail ?? '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
};

function errorText(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 240);
}

/** 刚拉起的标签页可能还没挂上主框架，连 page.url() 都会报 too early，先等它稳下来。 */
async function waitForPageReady(page, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await page.url();
      await page.evaluate(() => 1);
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error('标签页 20 秒内没有就绪（Requesting main frame too early）');
}

async function reloadWorkspace(page, base, hash = 'home') {
  const url = `${base}/workspace.html#${hash}`;
  await waitForPageReady(page);
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
  await sleep(600);
}

/** 当前焦点落在哪个元素上——用结构描述而不是 DOM 路径，报告里才读得懂。 */
function focused(page) {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (!(node instanceof HTMLElement)) return { tag: 'none', text: '', inDialog: false };
    const dialog = node.closest('[role="dialog"][aria-modal="true"]');
    const label =
      node.getAttribute('aria-label') ??
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.getAttribute('placeholder') || node.value
        : node.textContent) ??
      '';
    return {
      tag: node.tagName.toLowerCase(),
      text: String(label).replace(/\s+/g, ' ').trim().slice(0, 24),
      inDialog: Boolean(dialog),
      isFirstInput: node.matches('input:not([type="hidden"]), textarea, select'),
      outline: getComputedStyle(node).outlineStyle,
      outlineWidth: getComputedStyle(node).outlineWidth,
    };
  });
}

/** 连续按 Tab，记录每一次的落点是否还在对话框里。 */
async function tabAround(page, times) {
  const trail = [];
  for (let i = 0; i < times; i += 1) {
    await page.keyboard.press('Tab');
    trail.push(await focused(page));
  }
  return trail;
}

/** 视口设置：受限环境里 setViewport 可能报 Session closed，退回 CDP 设备指标。 */
async function setViewport(page, width, height) {
  try {
    await page.setViewport({ width, height });
    return 'setViewport';
  } catch {
    const session = await page.createCDPSession();
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await session.detach().catch(() => {});
    return 'cdp';
  }
}

function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

/** 用界面建一条收藏：空库里需要它当字段模板。 */
async function createBookmark(page, { url, title }) {
  await page.evaluate(() => {
    window.location.hash = 'home';
  });
  await waitForText(page, '快速操作', 15_000);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.topbar button')].find((node) =>
      (node.textContent ?? '').includes('收藏链接')
    );
    button?.click();
  });
  await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
  await setReactInput(page, 'input[placeholder="https://"]', url);
  await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', title);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.modal button')].find((node) =>
      (node.textContent ?? '').includes('保存到收件箱')
    );
    button?.click();
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      saved: !document.querySelector('input[placeholder="https://"]'),
      message: (document.querySelector('.modal .alert')?.textContent ?? '').trim(),
    }));
    if (state.saved) return;
    if (state.message) throw new Error(`新建收藏失败：${state.message}`);
    await sleep(150);
  }
  throw new Error('新建收藏等待写入结果超时');
}


async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error(`构建产物缺失：${DIST}。请先运行 npm run build。`);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const target = BROWSERS.find(
    (browser) => browser.name.toLowerCase() === (process.env.P0_BROWSER ?? 'chrome').toLowerCase()
  );
  if (!target) throw new Error('未找到可用的 Chrome / Edge。');

  const limitations = [
    '自动化只能断言焦点落点与计算样式，读屏软件（VoiceOver / NVDA）的实际播报未验证。',
    '触屏手势、虚拟键盘弹出后的遮挡、iOS Safari 的滚动行为无法在桌面 Chrome 里验证。',
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    task: 'delivery-a11y',
    browser: { name: target.name, version: null, headless: null, extensionId: null },
    counts: {},
    limitations,
    steps,
  };

  const profileDir = prepareProfile(VERIFY_DIR, `${target.name}-a11y`);
  const attempt = await launchBestEffort(target, profileDir, limitations);
  report.browser.version = await attempt.browser.version();
  report.browser.headless = attempt.headless;
  report.browser.extensionId = attempt.extId;
  const { browser } = attempt;
  const base = `chrome-extension://${attempt.extId}`;

  const [existing] = await browser.pages().catch(() => []);
  const page = existing ?? (await browser.newPage());
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewport({ width: 1280, height: 900 }).catch(() => {});

  const ctx = {};

  try {
    await reloadWorkspace(page, base, 'home');

    // ---- Tab 顺序与焦点可见 ----
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('Tab');
    const firstStops = [];
    for (let i = 0; i < 4; i += 1) {
      firstStops.push(await focused(page));
      await page.keyboard.press('Tab');
    }
    record(
      'Tab 从页首开始逐个落到可聚焦元素上，且有可见焦点环',
      firstStops.every((stop) => stop.tag !== 'body' && stop.tag !== 'none') &&
        firstStops.some((stop) => stop.outlineWidth !== '0px' && stop.outline !== 'none'),
      `落点=${firstStops.map((stop) => stop.tag).join('→')}｜焦点环=${firstStops[0]?.outlineWidth}`
    );

    // ---- 打开弹窗：焦点进入、Tab 循环、Escape 归还 ----
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.topbar button')].find((node) =>
        (node.textContent ?? '').includes('收藏链接')
      );
      button?.focus();
    });
    await page.keyboard.press('Enter');
    await waitForSelectorReady(page, '.modal', 10_000);
    await sleep(300);
    const onOpen = await focused(page);
    record(
      '打开弹窗后焦点自动进入第一个输入框',
      onOpen.isFirstInput && onOpen.inDialog && onOpen.text === 'https://',
      `焦点=${onOpen.tag}「${onOpen.text}」｜在弹窗内=${onOpen.inDialog}`
    );

    const trail = await tabAround(page, 24);
    const escaped = trail.filter((stop) => !stop.inDialog).length;
    record(
      'Tab 在弹窗内循环，24 次都没有跑到遮罩后的页面',
      escaped === 0,
      `跑出弹窗=${escaped} 次｜落点示例=${trail
        .slice(0, 6)
        .map((stop) => stop.text || stop.tag)
        .join('→')}`
    );

    // Shift+Tab 反向也要留在里面
    const backward = [];
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      backward.push(await focused(page));
    }
    record(
      'Shift+Tab 反向遍历也被关在弹窗内',
      backward.every((stop) => stop.inDialog),
      `跑出弹窗=${backward.filter((stop) => !stop.inDialog).length} 次`
    );

    await page.keyboard.press('Escape');
    await sleep(400);
    const onClose = await page.evaluate(() => ({
      dialog: Boolean(document.querySelector('.modal')),
      active:
        (document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.textContent ??
          '').trim(),
      inDialog: Boolean(document.activeElement?.closest('[role="dialog"]')),
    }));
    record(
      'Escape 关闭弹窗，焦点回到刚才的「收藏链接」按钮',
      !onClose.dialog && !onClose.inDialog && onClose.active.includes('收藏链接'),
      `弹窗=${onClose.dialog}｜焦点=「${onClose.active.slice(0, 16)}」`
    );

    // ---- 错误提示：可读、且不把焦点踢出弹窗 ----
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.topbar button')].find((node) =>
        (node.textContent ?? '').includes('收藏链接')
      );
      button?.click();
    });
    await waitForSelectorReady(page, 'input[placeholder="https://"]', 10_000);
    await setReactInput(page, 'input[placeholder="https://"]', '不是链接');
    await setReactInput(page, 'input[placeholder="给它一个容易找回的名字"]', '键盘测试');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.modal button')].find((node) =>
        (node.textContent ?? '').includes('保存到收件箱')
      );
      button?.click();
    });
    await sleep(900);
    const failure = await page.evaluate(() => {
      const alerts = [...document.querySelectorAll('.modal .alert, .modal [role="alert"]')];
      return {
        text: alerts.map((node) => (node.textContent ?? '').trim()).join(' | '),
        stillOpen: Boolean(document.querySelector('.modal')),
        focusInDialog: Boolean(document.activeElement?.closest('[role="dialog"]')),
      };
    });
    record(
      '非法链接给出可读错误，弹窗不关闭且焦点仍在里面',
      /链接|网址|URL/i.test(failure.text) && failure.stillOpen && failure.focusInDialog,
      `提示=「${failure.text.slice(0, 40)}」`
    );
    await page.keyboard.press('Escape');
    await sleep(300);

    // ---- 长链接与超长标题不撑破布局 ----
    // 空库里没有字段模板，先用界面建一条真实收藏（这一步本身也是「键盘可用」的旁证）。
    await createBookmark(page, { url: 'https://example.com/a11y-template', title: '键盘模板收藏' });
    await reloadWorkspace(page, base, 'all');
    ctx.ids = await page.evaluate(
      (input) =>
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
              const id = crypto.randomUUID();
              const tx = db.transaction('bookmarks', 'readwrite');
              tx.objectStore('bookmarks').put({
                ...template,
                id,
                originalUrl: input.url,
                canonicalUrl: input.url,
                title: input.title,
                sourceDescription: input.url,
                note: '',
                selectedText: '',
                categoryId: null,
                categoryKey: 'uncategorized',
                tagIds: [],
                inboxUnread: false,
                unreadFlag: 0,
                createdAt: now,
                updatedAt: now,
              });
              tx.oncomplete = () => {
                db.close();
                resolve({ id });
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
      { url: LONG_URL, title: LONG_TITLE }
    );

    await reloadWorkspace(page, base, 'all');
    await waitForSelectorReady(page, '.bookmark', 15_000);
    await sleep(400);
    const listOverflow = await overflow(page);
    record(
      '超长标题与超长 URL 不把列表撑出横向滚动',
      listOverflow.scrollWidth <= listOverflow.innerWidth + 1,
      `scrollWidth=${listOverflow.scrollWidth}｜视口=${listOverflow.innerWidth}`
    );

    await page.evaluate(() => {
      const target = [...document.querySelectorAll('.bookmark')].find((row) =>
        (row.textContent ?? '').includes('超长标题')
      );
      target?.querySelector('button[aria-label^="打开详情"]')?.click();
    });
    await waitForSelectorReady(page, '.drawer', 10_000);
    await sleep(400);
    const drawer = await page.evaluate(() => {
      const link = document.querySelector('.drawer a[href^="https://"]');
      const aside = document.querySelector('.drawer');
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        wrap: link ? getComputedStyle(link).overflowWrap : 'none',
        label: (link?.textContent ?? '').trim().slice(0, 20),
        contained: aside ? aside.scrollWidth <= aside.clientWidth + 1 : false,
      };
    });
    record(
      '详情抽屉里的长 URL 换行，不撑破抽屉与页面',
      drawer.overflow <= 1 && (drawer.wrap === 'anywhere' || drawer.wrap === 'break-word') && drawer.contained,
      `页面溢出=${drawer.overflow}px｜overflowWrap=${drawer.wrap}｜抽屉内溢出=${!drawer.contained}`
    );

    // 抽屉是 dialog：Tab 也要被关在里面，Escape 关闭
    const drawerTrail = await tabAround(page, 12);
    record(
      '详情抽屉同样是焦点陷阱：12 次 Tab 都在抽屉内',
      drawerTrail.every((stop) => stop.inDialog),
      `跑出抽屉=${drawerTrail.filter((stop) => !stop.inDialog).length} 次`
    );
    await page.keyboard.press('Escape');
    await sleep(400);
    record(
      'Escape 关闭详情抽屉',
      await page.evaluate(() => !document.querySelector('.drawer')),
      '抽屉已关闭'
    );

    // ---- 小屏 ----
    const mode = await setViewport(page, 375, 667);
    await reloadWorkspace(page, base, 'all');
    await waitForSelectorReady(page, '.bookmark', 15_000);
    await sleep(500);
    const small = await overflow(page);
    record(
      '小屏 375×667 下没有横向溢出',
      small.scrollWidth <= small.innerWidth + 1,
      `scrollWidth=${small.scrollWidth}｜视口=${small.innerWidth}｜视口设置=${mode}`
    );

    // 小屏要把导航藏起来，但必须留一个能打开它的入口，否则等于不能切页。
    const collapsed = await page.evaluate(() => {
      const sidebar = document.querySelector('aside');
      const toggle = document.querySelector('.mobile-menu');
      return {
        sidebarVisible: sidebar ? sidebar.getClientRects().length > 0 : false,
        toggleVisible: toggle ? toggle.getClientRects().length > 0 : false,
      };
    });
    await page.click('.mobile-menu').catch(() => {});
    await sleep(300);
    const expanded = await page.evaluate(() => ({
      menuOpen: document.body.classList.contains('menu-open'),
      sidebarVisible: (document.querySelector('aside')?.getClientRects().length ?? 0) > 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    }));
    await page.keyboard.press('Escape');
    await sleep(300);
    const reCollapsed = await page.evaluate(() => ({
      menuOpen: document.body.classList.contains('menu-open'),
      sidebarVisible: (document.querySelector('aside')?.getClientRects().length ?? 0) > 0,
    }));
    record(
      '小屏侧栏默认收起，展开入口可用，展开后不溢出且 Escape 能收起',
      !collapsed.sidebarVisible &&
        collapsed.toggleVisible &&
        expanded.menuOpen &&
        expanded.sidebarVisible &&
        expanded.overflow <= 1 &&
        !reCollapsed.menuOpen &&
        !reCollapsed.sidebarVisible,
      `初始可见=${collapsed.sidebarVisible}｜有入口=${collapsed.toggleVisible}｜展开后溢出=${expanded.overflow}px｜Esc 收起=${!reCollapsed.sidebarVisible}`
    );

    const tiny = await setViewport(page, 320, 568);
    await sleep(500);
    const tinyOverflow = await overflow(page);
    record(
      '320×568 下仍无横向溢出',
      tinyOverflow.scrollWidth <= tinyOverflow.innerWidth + 1,
      `scrollWidth=${tinyOverflow.scrollWidth}｜视口=${tinyOverflow.innerWidth}｜方式=${tiny}`
    );

    // ---- 手机快照在 375 宽可读 ----
    const snapshot = path.join(VERIFY_DIR, 'artifacts', 'p6-snapshot-mobile.html');
    if (fs.existsSync(snapshot)) {
      const html = fs.readFileSync(snapshot, 'utf8');
      await setViewport(page, 375, 667);
      await page.goto('about:blank');
      await page.evaluate((text) => {
        document.open();
        document.write(text);
        document.close();
      }, html);
      await sleep(300);
      const snap = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        rows: document.querySelectorAll('article.item').length,
        hasFilter: Boolean(document.querySelector('select, input[type="search"], input[type="text"]')),
        fits: document.documentElement.scrollWidth <= window.innerWidth + 1,
      }));
      record(
        '手机快照在 375 宽下铺满且不横向溢出，筛选控件在位',
        snap.fits && snap.rows > 0 && snap.hasFilter,
        `条目=${snap.rows}｜scrollWidth=${snap.width}｜视口=${snap.viewport}｜控件=${snap.hasFilter}`
      );

      // 无脚本时列表仍然可读（脚本注入无效）
      const noScript = await page.evaluate(() => {
        const script = document.querySelector('script');
        if (script) script.remove();
        const items = [...document.querySelectorAll('article.item')];
        return { visible: items.filter((node) => !node.hidden).length, total: items.length };
      });
      record(
        '手机快照移除脚本后条目仍然全部可见（不依赖 JS 渲染）',
        noScript.visible === noScript.total && noScript.total > 0,
        `可见=${noScript.visible}/${noScript.total}`
      );
    } else {
      record('手机快照在 375 宽下可读', false, `未找到 ${snapshot}，先跑 npm run verify:p6`);
    }

    await setViewport(page, 1280, 900);
    record('整轮没有页面脚本错误', errors.length === 0, `errors=${JSON.stringify(errors.slice(0, 3))}`);
  } catch (error) {
    record(`验证中断：${errorText(error)}`, false, '');
  } finally {
    await browser.close().catch(() => {});
  }

  report.ok = steps.every((step) => step.ok);
  const rel = writeReport(OUT_DIR, 'delivery-a11y.json', report);
  console.log(`\n汇总：${report.ok ? '全部通过' : '存在未通过项'} → ${rel}`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('验证失败：', error);
  process.exitCode = 1;
});
