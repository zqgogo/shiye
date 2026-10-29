import { useEffect } from 'react';
import type { Bookmark, Category } from '@shiye/core';
import { domainOf, formatDateTime, isHttpUrl } from '@shiye/core';
import { useWorkspace } from './state.js';

export const ICONS = {
  home: '⌂',
  reading: '◷',
  inbox: '▧',
  uncategorized: '◌',
  all: '▤',
  search: '⌕',
  ai: '✧',
  settings: '⚙',
};

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="heading">
      <div>
        <div className="eyebrow">YOUR PERSONAL INDEX / 拾页</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ?? <span className="date">仅本地 · 无需登录</span>}
    </div>
  );
}

export function Sidebar() {
  const { data, route, navigate, openModal } = useWorkspace();
  const active = data.bookmarks;
  const readingCount = data.pendingReading.length;
  const inboxCount = active.filter((bookmark) => bookmark.inboxUnread).length;
  const uncategorized = active.filter((bookmark) => !bookmark.categoryId).length;
  const pinned = data.settings.pinnedCategoryIds
    .map((id) => data.categories.find((category) => category.id === id))
    .filter((category): category is Category => Boolean(category));

  const item = (id: string, icon: string, label: string, count?: number) => (
    <button
      className={`nav ${route === id ? 'active' : ''}`}
      onClick={() => navigate(id)}
      aria-current={route === id ? 'page' : undefined}
    >
      <span className="symbol">{icon}</span>
      <span>{label}</span>
      {count !== undefined ? <span className="count">{count}</span> : null}
    </button>
  );

  return (
    <aside>
      <div className="brand">
        <div className="brand-mark">拾</div>
        <div>
          <b>拾页</b>
          <small>YOUR PERSONAL INDEX</small>
        </div>
      </div>

      <div className="navgroup">
        <small>日常 · LIBRARY</small>
        {item('home', ICONS.home, '首页')}
        {item('reading', ICONS.reading, '待看', readingCount)}
        {item('inbox', ICONS.inbox, '收件箱', inboxCount)}
        {item('uncategorized', ICONS.uncategorized, '未分类', uncategorized)}
        {item('all', ICONS.all, '全部收藏', active.length)}
      </div>

      <div className="navgroup" style={{ marginTop: 24 }}>
        <small>我的分类 · COLLECTIONS</small>
        {pinned.map((category) => (
          <button
            key={category.id}
            className={`nav ${route === `cat:${category.id}` ? 'active' : ''}`}
            onClick={() => navigate(`cat:${category.id}`)}
          >
            <span className="category-dot" />
            <span className="catname">{category.name}</span>
            <span className="count">
              {active.filter((bookmark) => bookmark.categoryId === category.id).length}
            </span>
          </button>
        ))}
        <button className="nav nav-more" onClick={() => openModal({ kind: 'categories' })}>
          <span className="symbol">{ICONS.search}</span>
          <span>全部分类</span>
          <span className="count">{data.categories.length} ›</span>
        </button>
      </div>

      <div className="navgroup nav-tools">
        <small>工具 · TOOLS</small>
        {item('ai', ICONS.ai, 'AI 助手')}
        {item('settings', ICONS.settings, '设置与管理')}
      </div>

      <div className="sidebottom">
        <div className="micro">
          <span className="statusdot" />
          本地主库 · IndexedDB
        </div>
        <div className="micro" style={{ fontSize: 9, marginTop: 6 }}>
          安放链接，也保留当时的想法。
        </div>
      </div>
    </aside>
  );
}

export function Topbar() {
  const { query, setQuery, navigate, openModal } = useWorkspace();
  return (
    <header className="topbar">
      <button
        className="mobile-menu iconbtn"
        aria-label="展开导航"
        onClick={() => document.body.classList.toggle('menu-open')}
      >
        ☰
      </button>
      <div className="searchbox">
        <span aria-hidden="true">{ICONS.search}</span>
        <input
          id="globalSearch"
          aria-label="搜索收藏"
          placeholder="搜索标题、描述、备注、选中文字…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <kbd>Ctrl K</kbd>
      </div>
      <div className="topright">
        <span className="micro">
          <span className="statusdot" />
          仅本地
        </span>
        <button className="btn" onClick={() => navigate('capture')}>
          粘贴 / 导入
        </button>
        <button className="btn primary" onClick={() => openModal({ kind: 'new-bookmark' })}>
          ＋ 收藏链接
        </button>
        <div className="avatar" aria-hidden="true">
          我
        </div>
      </div>
    </header>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{description}</p>
      {actionLabel && onAction ? (
        <button className="btn" onClick={onAction} style={{ marginTop: 12 }}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function BookmarkRow({
  bookmark,
  category,
  tags,
  selected,
  selectable,
  mode,
  onSelect,
}: {
  bookmark: Bookmark;
  category: Category | undefined;
  tags: { id: string; name: string }[];
  selected?: boolean;
  selectable?: boolean;
  mode?: 'trash' | 'inbox' | 'normal' | undefined;
  onSelect?: (checked: boolean) => void;
}) {
  const { openBookmark, openModal, run, service, toast } = useWorkspace();
  const deleted = Boolean(bookmark.deletedAt);

  const addToReading = async () => {
    const result = await run(
      () => service.addReading({ originalUrl: bookmark.originalUrl, title: bookmark.title, relatedBookmarkId: bookmark.id }),
      '已加入待看，原收藏保持不变。'
    );
    if (!result) return;
  };

  const openExternal = async () => {
    // 纵深防御：保存与恢复都只放行 http/https，但历史数据、迁移脚本仍可能带进别的协议。
    if (!isHttpUrl(bookmark.originalUrl)) {
      toast('这条记录的链接不是 http / https，已阻止打开。');
      return;
    }
    await service.touchOpened(bookmark.id);
    window.open(bookmark.originalUrl, '_blank', 'noopener,noreferrer');
    void run(async () => undefined);
  };

  return (
    <article className="bookmark">
      {selectable ? (
        <input
          type="checkbox"
          aria-label={`选择 ${bookmark.title}`}
          checked={Boolean(selected)}
          onChange={(event) => onSelect?.(event.target.checked)}
        />
      ) : null}
      <div className="favicon" aria-hidden="true">
        {[...bookmark.title][0] ?? '书'}
      </div>
      <button
        className="rowbody"
        onClick={() => openBookmark(bookmark.id)}
        aria-label={`打开详情：${bookmark.title}`}
      >
        <h3>{bookmark.title}</h3>
        <p className="desc">
          {bookmark.aiPurpose || bookmark.sourceDescription || '还没有描述，可以在整理时补充。'}
        </p>
        <div className="rowmeta">
          <span className="domain">{domainOf(bookmark.originalUrl)}</span>
          <span>·</span>
          <span>{category?.name ?? '未分类'}</span>
          {bookmark.privacy.localOnly ? <span className="tag private">仅本地</span> : null}
          {bookmark.privacy.aiBlocked ? <span className="tag noai">禁止 AI</span> : null}
          {bookmark.lockedFields.length ? <span title="人工锁定">⌑ 已锁定</span> : null}
          {bookmark.pinned ? <span className="tag pinned">置顶</span> : null}
          {bookmark.tagIds.slice(0, 2).map((tagId) => {
            const tag = tags.find((entry) => entry.id === tagId);
            return tag ? (
              <span className="tag" key={tagId}>
                {tag.name}
              </span>
            ) : null;
          })}
          {mode === 'trash' ? <span>删除于 {formatDateTime(bookmark.deletedAt)}</span> : null}
        </div>
      </button>
      <div className="rowactions">
        {deleted ? (
          <>
            <button
              className="btn small"
              onClick={() =>
                void run(() => service.restoreBookmark(bookmark.id), '已恢复，原分类与未读状态保留。')
              }
            >
              恢复
            </button>
          </>
        ) : (
          <>
            <button className="btn small" onClick={() => void addToReading()}>
              加入待看
            </button>
            {mode === 'inbox' ? (
              <button
                className="btn small"
                onClick={() => void run(() => service.markRead([bookmark.id]), '已标记为已读。')}
              >
                标记已读
              </button>
            ) : !bookmark.inboxUnread ? (
              <button
                className="btn small"
                onClick={() => void run(() => service.markUnread([bookmark.id]), '已恢复未读。')}
              >
                恢复未读
              </button>
            ) : null}
            <button
              className={`iconbtn ${bookmark.pinned ? 'pinned' : ''}`}
              aria-label={bookmark.pinned ? '取消置顶' : '置顶'}
              onClick={() =>
                void run(
                  () => service.setPinned(bookmark.id, !bookmark.pinned),
                  bookmark.pinned ? '已取消置顶。' : '已置顶。'
                )
              }
            >
              {bookmark.pinned ? '★' : '☆'}
            </button>
            <button
              className="iconbtn"
              aria-label="打开原网页"
              onClick={() => void openExternal()}
              title="打开原网页（记录最近打开）"
            >
              ↗
            </button>
            <button
              className="iconbtn"
              aria-label="删除收藏"
              onClick={() => openModal({ kind: 'delete-bookmark', bookmarkId: bookmark.id })}
              title="删除到回收站"
            >
              ⌫
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function Notice({ children, tone }: { children: React.ReactNode; tone?: 'danger' }) {
  return <div className={`notice ${tone === 'danger' ? 'danger' : ''}`}>{children}</div>;
}

export function ReadingRow({
  item,
  linkedBookmark,
  onOpen,
  onComplete,
  onConvert,
}: {
  item: { id: string; title: string; originalUrl: string; note: string; addedAt: string; status: string };
  linkedBookmark: Bookmark | undefined;
  onOpen: () => void;
  onComplete: () => void;
  onConvert: () => void;
}) {
  return (
    <article className="bookmark">
      <div className="favicon" aria-hidden="true">
        {[...item.title][0] ?? '读'}
      </div>
      <div className="rowbody" role="group">
        <h3>{item.title}</h3>
        <p className="desc">{item.note || '稍后回来看看。'}</p>
        <div className="rowmeta">
          <span className="domain">{domainOf(item.originalUrl)}</span>
          <span>·</span>
          <span>{linkedBookmark ? '已在收藏库' : '仅待看'}</span>
          <span>·</span>
          <span>加入于 {formatDateTime(item.addedAt)}</span>
        </div>
      </div>
      <div className="rowactions">
        {isHttpUrl(item.originalUrl) ? (
          <a className="btn small" href={item.originalUrl} target="_blank" rel="noopener noreferrer">
            打开 ↗
          </a>
        ) : (
          <span className="btn small" aria-disabled="true" title="链接不是 http / https，已禁用">
            链接不可用
          </span>
        )}
        <button className="btn small" onClick={onConvert}>
          {linkedBookmark ? '查看收藏' : '转入收藏'}
        </button>
        <button className="btn small" onClick={onComplete}>
          完成
        </button>
      </div>
    </article>
  );
}

/* ---------- 对话框焦点管理 ---------- */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 当前最上层的对话框：抽屉与模态可以同时存在，DOM 里靠后的那个才是用户正在操作的。 */
function topDialog(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
  return dialogs.filter((node) => node.getClientRects().length > 0).at(-1) ?? null;
}

function focusablesIn(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => node.getClientRects().length > 0
  );
}

function focusInto(dialog: HTMLElement): void {
  // 抽屉这类长面板聚焦容器本身即可，直接跳进输入框会让页面自己滚一段。
  if (dialog.dataset.focusContainer === 'true') {
    dialog.focus();
    return;
  }
  const target =
    dialog.querySelector<HTMLElement>('[data-autofocus]') ??
    dialog.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select') ??
    focusablesIn(dialog)[0] ??
    dialog;
  target.focus();
}

/**
 * 把 Tab 关在对话框里，并在关闭后把焦点还回去。
 *
 * 没有这一层时，Shift+Tab 会退到遮罩后的页面上继续操作——视觉上「弹窗挡着」，
 * 键盘用户却已经跑到弹窗外面，`aria-modal="true"` 也就成了空话。
 */
export function FocusGuard() {
  useEffect(() => {
    let current = topDialog();
    /** 逐层记录：抽屉里再开删除确认，关掉确认要回到抽屉，而不是回到列表。 */
    const stack: HTMLElement[] = [];
    if (current) {
      stack.push(document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
      focusInto(current);
    }

    const observer = new MutationObserver(() => {
      const next = topDialog();
      if (next === current) return;
      if (next) {
        stack.push(document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
        focusInto(next);
      } else {
        const back = stack.pop();
        // 原来的按钮可能已随列表重渲染消失，那就落到文档开头，别把焦点丢在 body 上。
        if (back && document.contains(back) && back.getClientRects().length > 0) back.focus();
        else (document.querySelector<HTMLElement>('.topbar button, .topbar a') ?? document.body).focus();
      }
      current = next;
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = topDialog();
      if (!dialog) return;
      const items = focusablesIn(dialog);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return null;
}
