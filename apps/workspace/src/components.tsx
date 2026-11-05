import { categoryFingerprint } from '@shiye/core';
import { MovePicker, OrganizationTree, ORGANIZATION_DRAG, announceOrganization } from './organization-controls.js';
import { useEffect, useRef, useState } from 'react';
import { useConnectionStatus } from './connection-status.js';
import type { BatchEntryState, Bookmark, Category, ImportUndoItem, ImportUndoReason } from '@shiye/core';
import { PAGE_SIZE_OPTIONS, domainOf, formatDateTime, isHttpUrl } from '@shiye/core';
import { useWorkspace } from './state.js';

/**
 * 下拉里表示「没有原始目录」的那一项：空串已经被「全部目录」占了。
 * 批次面板与按条件清理面板共用，避免两处各写一个哨兵、某个下拉先改坏。
 */
export const NO_FOLDER = '__none__';

/**
 * 记录现状的标签：与撤回判据一致——先看在不在，再看变成了什么，最后才是改没改过。
 * 批次面板与按条件清理面板共用同一份文案。
 */
export const BATCH_STATE_LABEL: Record<BatchEntryState, string> = {
  untouched: '未改动',
  modified: '已改动',
  trashed: '已删除',
  converted: '已转收藏',
  completed: '已完成',
  missing: '已不存在',
};

export const ICONS = {
  home: '⌂',
  reading: '◷',
  inbox: '▧',
  uncategorized: '◌',
  all: '▤',
  trash: '⌫',
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
  const { aiStatus, cloudStatus } = useConnectionStatus();
  const limitWidth = (value: number) => Math.max(220, Math.min(480, window.innerWidth - 520, value));
  const [width, setWidth] = useState(() => { try { const saved = Number(localStorage.getItem('shiye:sidebar-width')); return Number.isFinite(saved) && saved >= 220 ? saved : 260; } catch { return 260; } });
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const [viewport, setViewport] = useState(window.innerWidth);
  const actualWidth = limitWidth(width);
  useEffect(() => { const resize = () => setViewport(window.innerWidth); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  useEffect(() => { document.documentElement.style.setProperty('--sidebar-width', `${actualWidth}px`); }, [actualWidth, viewport]);
  const rememberWidth = (value: number) => { const next = limitWidth(value); setWidth(next); try { localStorage.setItem('shiye:sidebar-width', String(next)); } catch { /* Layout remains usable without storage. */ } };

  const extraRoutes = ['uncategorized', 'capture:file', 'trash'];
  const [moreOpen, setMoreOpen] = useState(() => extraRoutes.includes(route));
  useEffect(() => { if (extraRoutes.includes(route)) setMoreOpen(true); }, [route]);
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
    <div className="sidebar-shell"><aside>
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
        {item('all', ICONS.all, '全部收藏', active.length)}
        <details className="nav-extra" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
          <summary>更多入口 <span>未分类 · 导入 · 回收站</span></summary>
          {item('uncategorized', ICONS.uncategorized, '未分类', uncategorized)}
          {item('capture:file', ICONS.all, '导入与待整理')}
          {item('trash', ICONS.trash, '回收站', data.trashedCount)}
        </details>
      </div>

      <div className="navgroup" style={{ marginTop: 24 }}>
        <small>我的分类 · COLLECTIONS</small>
        <OrganizationTree />
        {pinned.length > 0 && <small className="pinned-caption">置顶快捷入口 · 最多 8 个</small>}
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
        <small className={`nav-connection-state state-${aiStatus.tone}`}>{aiStatus.label}</small>
        {item('cloud', '☁', '云端与收件箱')}
        <small className={`nav-connection-state state-${cloudStatus.tone}`}>{cloudStatus.label}</small>
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
    <div className="sidebar-resizer" role="separator" aria-label="调整左侧栏宽度" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={220} aria-valuemax={Math.max(220, Math.min(480, viewport - 520))} aria-valuenow={actualWidth}
      title="拖动调整宽度；双击恢复默认；方向键微调"
      onDoubleClick={() => rememberWidth(260)}
      onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); rememberWidth(event.key === 'Home' ? 220 : event.key === 'End' ? 480 : actualWidth + (event.key === 'ArrowRight' ? 10 : -10)); } }}
      onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); dragStart.current = { x: event.clientX, width: actualWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { if (dragStart.current) rememberWidth(dragStart.current.width + event.clientX - dragStart.current.x); }}
      onPointerUp={(event) => { dragStart.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { dragStart.current = null; }} onLostPointerCapture={() => { dragStart.current = null; }} />
    </div>
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
          本地主库
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
  dragIds,
  manualSort,
  onReorder,
  mode,
  onSelect,
}: {
  bookmark: Bookmark;
  category: Category | undefined;
  tags: { id: string; name: string }[];
  selected?: boolean | undefined;
  dragIds?: string[] | undefined;
  manualSort?: boolean | undefined;
  onReorder?: (() => void) | undefined;
  selectable?: boolean | undefined;
  mode?: 'trash' | 'inbox' | 'normal' | undefined;
  onSelect?: ((checked: boolean) => void) | undefined;
}) {
  const { data, openBookmark, openModal, run, service, toast, route } = useWorkspace();
  const deleted = Boolean(bookmark.deletedAt);
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null);
  const canReorder = !deleted && (manualSort || Boolean(onReorder));

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
    <article className={`bookmark ${dropSide ? `bookmark-drop-${dropSide}` : ''}`}
      onDragStart={(event) => {
        if (!(event.target as Element).closest('.drag-handle')) return;
        const ids = dragIds ?? [bookmark.id];
        const items = ids.flatMap((id) => { const row = data.bookmarks.find((entry) => entry.id === id); return row ? [{ kind: 'bookmark', id, revision: row.localRevision }] : []; });
        event.dataTransfer.setData(ORGANIZATION_DRAG, JSON.stringify(items));
        event.dataTransfer.setData('text/plain', `移动 ${items.length} 条收藏`);
      }}
      onDragOver={(event) => { if (canReorder && event.dataTransfer.types.includes(ORGANIZATION_DRAG)) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setDropSide(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'); } }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropSide(null); }}
      onDragEnd={() => setDropSide(null)}
      onDrop={async (event) => {
        setDropSide(null);
        if (!canReorder) return;
        const raw = event.dataTransfer.getData(ORGANIZATION_DRAG);
        if (!raw) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        try {
          const items = JSON.parse(raw) as import('@shiye/core').OrganizationTarget[];
          if (items.some((row) => row.id === bookmark.id || row.kind !== 'bookmark')) return;
          const parent = data.categories.find((row) => row.id === bookmark.categoryId);
          const result = await run(() => service.moveOrganization({ items, categoryFingerprint: categoryFingerprint(data.categories), parentId: bookmark.categoryId, ...(after ? { afterId: bookmark.id } : { beforeId: bookmark.id }), anchorRevision: bookmark.localRevision, ...(parent ? { parentRevision: parent.revision } : {}) }));
          if (result) { announceOrganization(result.operationId, `records:${route}`); onReorder?.(); toast('已调整顺序，当前按手动顺序显示。'); }
        } catch { toast('无法完成排序，请重试。', 'error'); }
      }}>
      {selectable ? (
        <input
          type="checkbox"
          aria-label={`选择 ${bookmark.title}`}
          checked={Boolean(selected)}
          onChange={(event) => onSelect?.(event.target.checked)}
        />
      ) : null}
      {!deleted && <button className="iconbtn drag-handle" draggable aria-label={`拖动 ${bookmark.title}`} title={canReorder ? '拖到记录上半部放到前面，下半部放到后面；完成后按手动顺序显示' : '拖到左侧分类可修改归属；此列表不支持拖动排序'}>⋮⋮</button>}
      {!deleted && <MovePicker items={[{ kind: 'bookmark', id: bookmark.id, revision: bookmark.localRevision }]} />}
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

export function Notice({ children, tone }: { children: React.ReactNode; tone?: 'danger' | 'ok' }) {
  return <div className={`notice ${tone ?? ''}`}>{children}</div>;
}

/**
 * 列表分页条。
 *
 * 只做「取哪一页」和「一页几条」两件事，切片由 `paginate()` 负责；页码钳制、
 * 空列表边界都在纯函数里算好，这里不再重复判断。只有一页时整条隐藏——
 * 一页装得下就不用增加翻页操作。
 *
 * 「每页」下拉改的是全局设置（所有列表共用），不是这一页的局部状态；
 * 当前值不在快捷档位里（比如设置成 33）时，额外补一项，避免下拉显示成空白。
 */
export function Pager({
  page,
  pageCount,
  pageSize,
  total,
  from,
  to,
  onPage,
  onPageSize,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  from: number;
  to: number;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
}) {
  if (pageCount <= 1) return null;
  const go = (next: number) => onPage(Math.min(Math.max(1, next), pageCount));
  const sizes = PAGE_SIZE_OPTIONS.includes(pageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? [...PAGE_SIZE_OPTIONS]
    : [...PAGE_SIZE_OPTIONS, pageSize].sort((a, b) => a - b);

  return (
    <div className="pager">
      <span className="micro">
        第 {page} / {pageCount} 页 · {from}–{to} / 共 {total} 条
      </span>
      <span className="spacer" />
      <label className="micro pagersize">
        每页
        <select
          aria-label="每页条数"
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {sizes.map((size) => (
            <option key={size} value={size}>
              {size} 条
            </option>
          ))}
        </select>
      </label>
      {pageCount > 1 ? (
        <>
          <button className="btn small" disabled={page <= 1} onClick={() => go(1)} aria-label="第一页">
            «
          </button>
          <button className="btn small" disabled={page <= 1} onClick={() => go(page - 1)}>
            ‹ 上一页
          </button>
          <button className="btn small" disabled={page >= pageCount} onClick={() => go(page + 1)}>
            下一页 ›
          </button>
          <button
            className="btn small"
            disabled={page >= pageCount}
            onClick={() => go(pageCount)}
            aria-label="最后一页"
          >
            »
          </button>
        </>
      ) : null}
    </div>
  );
}

const UNDO_REASON_LABEL: Record<ImportUndoReason, string> = {
  modified: '导入后被改过',
  trashed: '已移入回收站',
  completed: '待看已完成',
  converted: '待看已转为收藏',
  missing: '已不在库里',
};

const UNDO_REASON_NOTE: Record<ImportUndoReason, string> = {
  modified: '编辑、改分类 / 标签 / 隐私、应用过 AI 建议或标记过已读，撤回不做反向操作。',
  trashed: '你把它移进了回收站，撤回不会顺手捞回来。',
  completed: '已经读完，后续处理不该被一次撤销回滚。',
  converted: '已经转成收藏，形态变了就不再算「这次导入的新增」。',
  missing: '记录已经不在了：可能你自己删了，或被别的清理带走。',
};

/**
 * 逐条展示「没有移走的记录 + 原因」。
 *
 * 撤回最容易被误解成「点一下全都没了」，所以留下的每一条都要能说出为什么，
 * 而不是只给一个 kept 数字。默认展开三条，避免长列表把面板撑爆。
 */
export function KeptList({ items }: { items: ImportUndoItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const shown = open ? items : items.slice(0, 3);
  return (
    <div className="undolist">
      <ul>
        {shown.map((item) => (
          <li key={item.entityId}>
            <strong>{item.title || '（记录已不存在）'}</strong>
            <span className="micro">
              {' '}
              {UNDO_REASON_LABEL[item.reason]} · {UNDO_REASON_NOTE[item.reason]}
            </span>
          </li>
        ))}
      </ul>
      {items.length > 3 ? (
        <button className="btn small" onClick={() => setOpen(!open)}>
          {open ? '收起' : `展开全部 ${items.length} 条`}
        </button>
      ) : null}
    </div>
  );
}

export function ReadingRow({
  item,
  linkedBookmark,
  onOpen,
  onComplete,
  onConvert,
  selectable,
  selected,
  onSelect,
}: {
  item: { id: string; title: string; originalUrl: string; note: string; addedAt: string; status: string };
  linkedBookmark: Bookmark | undefined;
  onOpen: () => void;
  onComplete: () => void;
  onConvert: () => void;
  /** 批量选择模式：行前出现勾选框。 */
  selectable?: boolean | undefined;
  selected?: boolean | undefined;
  onSelect?: ((checked: boolean) => void) | undefined;
}) {
  return (
    <article className="bookmark" onDragStart={(event) => {
      if (!(event.target as Element).closest('.drag-handle')) return;
      event.dataTransfer.setData('application/x-shiye-reading', item.id);
    }}>
      {item.status === 'pending' && <button className="iconbtn drag-handle" draggable aria-label={`拖动待看 ${item.title}`} title="拖到分类后确认转入收藏">⋮⋮</button>}
      {selectable ? (
        <input
          type="checkbox"
          aria-label={`选择待看 ${item.title}`}
          checked={Boolean(selected)}
          onChange={(event) => onSelect?.(event.target.checked)}
        />
      ) : null}
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
