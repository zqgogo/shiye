import { useEffect, useMemo, useState } from 'react';
import { LIMITS, TRASH_RETENTION_DAYS, formatDateTime, isHttpUrl, toUserMessage, type Bookmark, type PurgeCounts } from '@shiye/core';
import { BookmarkRow, EmptyState, ICONS, Notice, PageHeader, ReadingRow } from './components.js';
import { useWorkspace } from './state.js';
import { setPendingPaste } from './capture.js';

function BookmarkList({
  items,
  mode,
  empty,
}: {
  items: Bookmark[];
  mode?: 'trash' | 'inbox' | 'normal' | undefined;
  empty: { title: string; description: string; actionLabel?: string; onAction?: () => void };
}) {
  const { data } = useWorkspace();
  if (items.length === 0) {
    return (
      <div className="listbox">
        <EmptyState {...empty} />
      </div>
    );
  }
  return (
    <div className="listbox">
      <div className="listhead">
        <span>收藏与用途</span>
        <span>{items.length} 条 · 分类 · 标签 · 来源</span>
      </div>
      {items.map((bookmark) => (
        <BookmarkRow
          key={bookmark.id}
          bookmark={bookmark}
          category={data.categories.find((category) => category.id === bookmark.categoryId)}
          tags={data.tags}
          mode={mode}
        />
      ))}
    </div>
  );
}

export function HomePage() {
  const { data, navigate, openModal, query, openBookmark } = useWorkspace();
  const [paste, setPaste] = useState('');
  const active = data.bookmarks;
  const pinned = active.filter((bookmark) => bookmark.pinned).slice(0, 3);
  const recent = [...active]
    .filter((bookmark) => bookmark.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
    .slice(0, 5);

  return (
    <>
      <PageHeader title="把好东西，留给以后的自己。" description="收藏不是终点，找得到、用得上才是。" />
      <div className="panel">
        <h2>把打开的页面，先收进来。</h2>
        <p>一行一个链接，支持多条粘贴；先预览，再选择待看或收藏。</p>
        <textarea
          value={paste}
          onChange={(event) => setPaste(event.target.value)}
          placeholder={'https://developer.apple.com/documentation/swift\nhttps://github.com/example/project'}
          style={{ minHeight: 95 }}
          aria-label="粘贴多个链接"
        />
        <div className="actions">
          <button className="btn" onClick={() => navigate('capture:file')}>
            从浏览器书签导入…
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setPendingPaste(paste);
              navigate('capture');
            }}
          >
            预览链接 →
          </button>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <strong>{active.length}</strong>
          <span>条收藏</span>
        </div>
        <div className="stat">
          <strong>{active.filter((bookmark) => !bookmark.categoryId).length}</strong>
          <span>待整理</span>
        </div>
        <div className="stat">
          <strong>{data.pendingReading.length}</strong>
          <span>待看</span>
        </div>
        <div className="stat">
          <strong>{active.filter((bookmark) => bookmark.inboxUnread).length}</strong>
          <span>未读</span>
        </div>
      </div>

      <div className="sectiontitle">
        <h2>常用置顶</h2>
        <span>留在手边的几个入口</span>
      </div>
      {pinned.length === 0 ? (
        <div className="panel">
          <p className="micro">还没有置顶收藏。在收藏行右侧点击 ☆ 即可置顶。</p>
        </div>
      ) : (
        <div className="pin-grid">
          {pinned.map((bookmark) => (
            <button
              key={bookmark.id}
              className="pin-card"
              onClick={() => openBookmark(bookmark.id)}
              style={{ cursor: 'pointer' }}
            >
              <div className="icon">{[...bookmark.title][0] ?? '拾'}</div>
              <h3>{bookmark.title}</h3>
              <p>{bookmark.aiPurpose || bookmark.sourceDescription || '还没有描述。'}</p>
              <div className="domain">{bookmark.originalUrl}</div>
            </button>
          ))}
        </div>
      )}

      <div className="sectiontitle">
        <h2>{query ? '搜索结果' : '最近打开'}</h2>
        <button className="ghost" onClick={() => navigate('recent')}>
          查看最近 15 条 →
        </button>
      </div>
      <BookmarkList
        items={recent}
        empty={{
          title: '还没有打开记录',
          description: '在工作台里打开收藏详情或原网页后，这里会出现最近 15 条。',
          actionLabel: '去全部收藏',
          onAction: () => navigate('all'),
        }}
      />

      <div className="sectiontitle">
        <h2>快速操作</h2>
        <span>不离开首页也能开始</span>
      </div>
      <div className="hubgrid">
        <button className="hubcard" onClick={() => openModal({ kind: 'new-bookmark' })}>
          <span className="hubicon">＋</span>
          <span className="hubtext">
            <strong>收藏一个链接</strong>
            <small>手动填写网址与标题，进入收件箱</small>
          </span>
          <span className="hubarrow">↗</span>
        </button>
        <button className="hubcard" onClick={() => openModal({ kind: 'add-reading' })}>
          <span className="hubicon">◷</span>
          <span className="hubtext">
            <strong>加入待看</strong>
            <small>独立队列，不需要分类</small>
          </span>
          <span className="hubarrow">↗</span>
        </button>
        <button className="hubcard" onClick={() => navigate('capture')}>
          <span className="hubicon">⇪</span>
          <span className="hubtext">
            <strong>粘贴 / 导入</strong>
            <small>多链接粘贴或浏览器书签 HTML</small>
          </span>
          <span className="hubarrow">↗</span>
        </button>
      </div>
    </>
  );
}

const LIST_TITLES: Record<string, [string, string]> = {
  all: ['全部收藏', '每个链接都带着一点上下文。'],
  inbox: ['收件箱', '新收藏在此等待查看，标记已读后仍保留在收藏库。'],
  uncategorized: ['未分类', '未选择分类的收藏，已读后仍保留在这里。'],
  recent: ['最近打开', '仅记录经工作台打开的最近 15 个不同收藏。'],
  trash: ['回收站', `删除不等于立即清除。正文保留 ${TRASH_RETENTION_DAYS} 天，之后由用户主动维护。`],
};

export function ListPage({ mode, categoryId }: { mode: keyof typeof LIST_TITLES | 'category'; categoryId?: string }) {
  const { data, navigate, openModal, run, service, toast } = useWorkspace();
  const [sort, setSort] = useState<'recent' | 'title'>('recent');
  const [trash, setTrash] = useState<Bookmark[] | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purgeCounts, setPurgeCounts] = useState<PurgeCounts | null>(null);
  const category = categoryId ? data.categories.find((entry) => entry.id === categoryId) : undefined;

  useEffect(() => {
    if (mode !== 'trash') return;
    void service.listTrash().then(setTrash);
  }, [mode, service, data.bookmarks]);

  const base = mode === 'trash' ? trash ?? [] : data.bookmarks;
  const items = useMemo(() => {
    let rows = [...base];
    if (mode === 'inbox') rows = rows.filter((bookmark) => bookmark.inboxUnread);
    if (mode === 'uncategorized') rows = rows.filter((bookmark) => !bookmark.categoryId);
    if (mode === 'recent') {
      rows = rows
        .filter((bookmark) => bookmark.lastOpenedAt)
        .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
        .slice(0, LIMITS.recentOpened);
      return rows;
    }
    if (mode === 'category' && categoryId) {
      rows = rows.filter((bookmark) => bookmark.categoryId === categoryId);
    }
    if (mode === 'trash') {
      rows = rows.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
      return rows;
    }
    if (mode === 'inbox') {
      return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return sort === 'title'
      ? rows.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
      : rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [base, mode, categoryId, sort]);

  const [title, description] =
    mode === 'category'
      ? [category?.name ?? '分类', category?.description || '这个分类下的收藏。']
      : LIST_TITLES[mode] ?? ['收藏', '当前列表'];

  /**
   * 彻底清空的作用范围。
   *
   * 「清空」必须是硬删除：只软删的话，墓碑会让重新导入的同一批书签全部被判成
   * 「存在已删除收藏」而跳过——用户看到的是「清空了却导不进来」。所以这里
   * 连墓碑一起清，界面上也按不可恢复来说明。
   */
  const purge =
    mode === 'all'
      ? {
          label: '整个收藏库',
          count: data.bookmarks.length,
          note: '回收站里的记录以及它们的删除标记也会一起清掉。',
          action: () => service.purgeAllBookmarks(),
          done: '收藏库已清空，可以重新导入。',
        }
      : mode === 'category' && categoryId
        ? {
            label: `「${category?.name ?? '这个分类'}」下的收藏`,
            count: items.length,
            note: '分类本身保留，只清空它下面的收藏。',
            action: () => service.purgeCategoryBookmarks(categoryId),
            done: '这个分类已清空。',
          }
        : mode === 'uncategorized'
          ? {
              label: '未分类的收藏',
              count: items.length,
              note: '',
              action: () => service.purgeCategoryBookmarks(null),
              done: '未分类的收藏已清空。',
            }
          : null;

  useEffect(() => {
    // 换页后不能保留上一页的确认状态，否则在另一页按一次就误清空了这一页的数据。
    setConfirmPurge(false);
  }, [mode, categoryId]);

  /**
   * 确认框里的条数必须和实删数量对齐。
   *
   * 清空按整张表过滤，回收站里的记录也在删除范围内；只报当前列表条数会让
   * 确认框显示 120 条、实际删掉 130 条。所以进页面先统计「在库 / 回收站 / 删除标记」。
   */
  useEffect(() => {
    if (!purge) {
      setPurgeCounts(null);
      return;
    }
    let cancelled = false;
    setPurgeCounts(null);
    void (async () => {
      try {
        const counts = await service.purgeCounts(
          mode === 'all'
            ? { kind: 'all' }
            : { kind: 'category', categoryId: mode === 'category' ? categoryId ?? null : null }
        );
        if (!cancelled) setPurgeCounts(counts);
      } catch {
        // 统计失败不阻塞清空：确认框退回「正在统计」，按钮仍可用，但要求用户先导出备份。
        if (!cancelled) setPurgeCounts(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, categoryId, service, data.bookmarks.length, data.categories.length]);

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        action={
          <button className="btn" onClick={() => openModal({ kind: 'new-bookmark' })}>
            ＋ 添加收藏
          </button>
        }
      />

      {mode === 'inbox' ? (
        <Notice>
          收件箱只显示未读的新收藏，查看或打开网页不会自动标记已读。
          <button
            className="btn small"
            onClick={() => void run(() => service.markAllInboxRead(), '已全部标记为已读。')}
          >
            全部标记已读
          </button>
        </Notice>
      ) : null}
      {mode === 'trash' ? (
        <Notice>
          回收站中的收藏不会出现在搜索与 AI 材料中。恢复后保留原分类与未读状态。
          <button className="btn small" onClick={() => navigate('all')}>
            回到全部收藏
          </button>
        </Notice>
      ) : null}
      {mode === 'recent' ? (
        <Notice>只统计在工作台内的打开动作；外部直接访问无法可靠记录，因此不宣称完整浏览历史。</Notice>
      ) : null}

      {confirmPurge && purge ? (
        <Notice tone="danger">
          <strong>确认彻底清空{purge.label}？</strong>
          <span>
            {purgeCounts
              ? `将删除 ${purgeCounts.active + purgeCounts.trashed} 条记录（在库 ${purgeCounts.active} · 回收站 ${purgeCounts.trashed}），并清掉 ${purgeCounts.tombstones} 条删除标记。`
              : '正在统计这一范围里的记录（含回收站）…'}
          </span>
          <span>
            {purge.note ? `${purge.note} ` : ''}
            删除标记会一起清掉，之后可以重新导入同一批书签。
          </span>
          <span>不可恢复。想留后路请先到「数据与备份」导出完整 JSON。</span>
          <button
            className="btn small danger"
            onClick={async () => {
              const expected = purgeCounts ? purgeCounts.active + purgeCounts.trashed : null;
              const removed = await run(purge.action, purge.done);
              if (removed === null) return;
              setConfirmPurge(false);
              if (expected !== null && removed !== expected) {
                toast(`实际删除 ${removed} 条，与确认时的 ${expected} 条不一致，请核对后重试。`, 'error');
              }
            }}
          >
            确认清空
          </button>
          <button className="btn small" onClick={() => setConfirmPurge(false)}>
            取消
          </button>
        </Notice>
      ) : null}

      <div className="toolbar">
        <span className="micro">共 {items.length} 条</span>
        <span className="spacer" />
        {purge && (purgeCounts ? purgeCounts.active + purgeCounts.trashed > 0 : purge.count > 0) ? (
          <button className="btn small" onClick={() => setConfirmPurge(true)}>
            彻底清空…
          </button>
        ) : null}
        {mode !== 'trash' ? (
          <select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="recent">最近新增</option>
            <option value="title">标题排序</option>
          </select>
        ) : null}
      </div>

      <BookmarkList
        items={items}
        mode={mode === 'inbox' ? 'inbox' : mode === 'trash' ? 'trash' : 'normal'}
        empty={
          mode === 'trash'
            ? { title: '回收站是空的', description: '删除的收藏会先来到这里，可以随时恢复。' }
            : mode === 'inbox'
              ? { title: '收件箱清零了', description: '新收藏会先进入这里等待查看。', actionLabel: '去看全部收藏', onAction: () => navigate('all') }
              : { title: '这里还没有匹配的收藏', description: '试试其他关键词，或先保存一个链接。', actionLabel: '＋ 收藏链接', onAction: () => openModal({ kind: 'new-bookmark' }) }
        }
      />
    </>
  );
}

export function SearchPage() {
  const { query, service, data, toast } = useWorkspace();
  const [hits, setHits] = useState<{ bookmarkId: string; score: number }[] | null>(null);
  const [error, setError] = useState('');
  const [scope, setScope] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 换关键词或换检索范围时先回到「检索中」：否则新的检索还没回来，
    // 页面上仍挂着上一个词的结果与「匹配 N 条」，读数会被当成这次的答案。
    setHits(null);
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const timer = window.setTimeout(() => {
      service
        .search(query, scope ? { categoryId: scope } : undefined)
        .then((result) => {
          if (!cancelled) {
            setError('');
            setHits(result);
          }
        })
        .catch((cause: unknown) => {
          // 本地索引出错基本都是真实缺陷，把原因露出来比「请稍后重试」有用。
          if (!cancelled) setError(`本地索引检索失败：${toUserMessage(cause)}`);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, service, data.bookmarks, scope, reloadKey]);

  const items = (hits ?? [])
    .map((hit) => data.bookmarks.find((bookmark) => bookmark.id === hit.bookmarkId))
    .filter((bookmark): bookmark is Bookmark => Boolean(bookmark));

  const scopeName = scope
    ? data.categories.find((category) => category.id === scope)?.name ?? '当前分类'
    : '全库';

  return (
    <>
      <PageHeader
        title="搜索结果"
        description={`关键词「${query}」在${scopeName}内检索，覆盖标题、网址、描述、用途、备注、选中文字、分类与标签。`}
      />
      <div className="toolbar">
        <select aria-label="检索范围" value={scope} onChange={(event) => setScope(event.target.value)}>
          <option value="">全库</option>
          {data.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <span className="micro">匹配 {items.length} 条</span>
        <span className="spacer" />
        <button
          className="btn small"
          onClick={async () => {
            try {
              const result = await service.rebuildSearchIndex();
              setReloadKey((value) => value + 1);
              toast(`索引已重建，共 ${result.documents} 条。`);
            } catch (cause) {
              setError(`本地索引重建失败：${toUserMessage(cause)}`);
            }
          }}
        >
          重建索引
        </button>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {hits === null ? (
        <div className="panel">
          <p className="micro">
            <span className="spin" /> 正在检索本地索引…
          </p>
        </div>
      ) : (
        <BookmarkList
          items={items}
          empty={{
            title: '没有匹配的收藏',
            description: '换个关键词、换检索范围，或者清空搜索回到全部收藏。',
          }}
        />
      )}
    </>
  );
}

export function ReadingPage() {
  const { data, service, run, openModal, openBookmark, navigate, toast } = useWorkspace();
  const [lastCompleted, setLastCompleted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [confirmPurge, setConfirmPurge] = useState(false);
  const pending = [...data.pendingReading].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  // 待看独立搜索：只查队列本身，不混入收藏库。
  const term = search.trim().toLowerCase();
  const items = term
    ? pending.filter((item) =>
        [item.title, item.originalUrl, item.note ?? ''].join(' ').toLowerCase().includes(term)
      )
    : pending;

  const complete = async (id: string) => {
    setBusy(true);
    const done = await run(() => service.completeReading(id), '已完成待看；已有收藏不受影响。');
    setBusy(false);
    if (done) setLastCompleted(id);
  };

  return (
    <>
      <PageHeader
        title="先留着，稍后再看。"
        description="待看是独立队列，看完可完成，也可以转入收藏。"
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => navigate('reading-history')}>
              完成历史
            </button>
            <button className="btn primary" onClick={() => openModal({ kind: 'add-reading' })}>
              ＋ 添加待看
            </button>
          </div>
        }
      />
      <Notice>
        暂时不用分类。打开网页不会自动完成；完成待看只移除队列，不删除已有收藏。
        {lastCompleted ? (
          <button
            className="btn small"
            disabled={busy}
            onClick={async () => {
              const reopened = await run(() => service.reopenReading(lastCompleted), '已撤销完成。');
              if (reopened) setLastCompleted(null);
            }}
          >
            撤销上次完成
          </button>
        ) : null}
      </Notice>

      {confirmPurge ? (
        <Notice tone="danger">
          <strong>确认清空待看的 {pending.length} 条？</strong>
          <span>只清空待看队列，不影响任何收藏；完成历史单独清理。</span>
          <span>待看没有回收站，清空后不可恢复。</span>
          <button
            className="btn small danger"
            onClick={async () => {
              const removed = await run(() => service.purgePendingReading(), '待看已清空。');
              if (removed !== null) setConfirmPurge(false);
            }}
          >
            确认清空
          </button>
          <button className="btn small" onClick={() => setConfirmPurge(false)}>
            取消
          </button>
        </Notice>
      ) : null}

      <div className="toolbar">
        <input
          placeholder="搜索待看的标题、网址或备注…"
          aria-label="搜索待看"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span className="micro">
          {term ? `匹配 ${items.length} / 共 ${pending.length} 条` : `共 ${pending.length} 条`}
        </span>
        {pending.length ? (
          <button className="btn small" onClick={() => setConfirmPurge(true)}>
            清空待看…
          </button>
        ) : null}
        {term ? (
          <>
            <span className="spacer" />
            <button className="btn small" onClick={() => setSearch('')}>
              清空搜索
            </button>
          </>
        ) : null}
      </div>

      <div className="listbox">
        <div className="listhead">
          <span>待看的内容</span>
          <span>{items.length} 条 · 最近加入在前</span>
        </div>
        {items.length === 0 ? (
          term ? (
            <EmptyState
              title="没有匹配的待看"
              description="换个关键词，或清空搜索看完整队列。"
              actionLabel="清空搜索"
              onAction={() => setSearch('')}
            />
          ) : (
            <EmptyState
              title="待看清单是空的"
              description="下次不舍得关闭的页面，先放在这里。"
              actionLabel="＋ 添加待看"
              onAction={() => openModal({ kind: 'add-reading' })}
            />
          )
        ) : (
          items.map((item) => {
            const linked = data.bookmarks.find((bookmark) => bookmark.canonicalUrl === item.canonicalUrl);
            return (
              <ReadingRow
                key={item.id}
                item={item}
                linkedBookmark={linked}
                onOpen={() => {
                  // 与收藏列表同一套纵深防御：只放行 http / https。
                  if (!isHttpUrl(item.originalUrl)) {
                    toast('这条待看的链接不是 http / https，已阻止打开。');
                    return;
                  }
                  window.open(item.originalUrl, '_blank', 'noopener,noreferrer');
                }}
                onComplete={() => void complete(item.id)}
                onConvert={() => {
                  if (linked) openBookmark(linked.id);
                  else openModal({ kind: 'convert-reading', readingId: item.id });
                }}
              />
            );
          })
        )}
      </div>
      <div className="footerhint">
        <span>待看不进入收藏收件箱，也不受分类约束。</span>
        <span>完成后可在完成历史里恢复。</span>
      </div>
    </>
  );
}

export function ReadingHistoryPage() {
  const { data, service, run, navigate, toast } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const items = [...data.completedReading].sort((a, b) =>
    (b.completedAt ?? '').localeCompare(a.completedAt ?? '')
  );

  return (
    <>
      <PageHeader
        title="完成历史"
        description="完成不是删除；这里可以恢复 pending，也可以由你主动清理。"
        action={
          <button className="btn" onClick={() => navigate('reading')}>
            ← 回到待看
          </button>
        }
      />
      <Notice>
        历史默认不出现在日常列表，也不会自动永久清理。
        {items.length ? (
          confirming ? (
            <>
              <strong>确认清理 {items.length} 条完成记录？</strong>
              <span>只移除队列历史，不影响任何收藏。</span>
              <button
                className="btn small danger"
                onClick={async () => {
                  const removed = await run(() => service.purgeCompletedReading(), '完成历史已清理。');
                  if (removed !== null) setConfirming(false);
                }}
              >
                确认清理
              </button>
              <button className="btn small" onClick={() => setConfirming(false)}>
                取消
              </button>
            </>
          ) : (
            <button className="btn small" onClick={() => setConfirming(true)}>
              清理完成历史
            </button>
          )
        ) : null}
      </Notice>

      <div className="listbox">
        <div className="listhead">
          <span>已完成</span>
          <span>{items.length} 条</span>
        </div>
        {items.length === 0 ? (
          <EmptyState title="还没有完成记录" description="完成一条待看后，会在这里留下可恢复的记录。" />
        ) : (
          items.map((item) => (
            <article className="bookmark" key={item.id}>
              <div className="favicon" aria-hidden="true">
                {[...item.title][0] ?? '读'}
              </div>
              <div className="rowbody" role="group">
                <h3>{item.title}</h3>
                <p className="desc">{item.note || '没有备注'}</p>
                <div className="rowmeta">
                  <span>{item.originalUrl}</span>
                  <span>·</span>
                  <span>完成于 {formatDateTime(item.completedAt)}</span>
                  {item.relatedBookmarkId ? <span>· 已关联收藏</span> : null}
                </div>
              </div>
              <div className="rowactions">
                <button
                  className="btn small"
                  onClick={() =>
                    void run(() => service.reopenReading(item.id), '已恢复为待看。')
                  }
                >
                  恢复待看
                </button>
              </div>
            </article>
          ))
        )}
      </div>
      <p className="micro" style={{ marginTop: 12 }}>
        <button className="linkbtn" onClick={() => toast('完成历史不是永久审计日志，不强制保存每一次循环。')}>
          了解保留规则
        </button>
      </p>
    </>
  );
}

export function SettingsPage() {
  const { navigate } = useWorkspace();
  const card = (icon: string, title: string, description: string, route: string) => (
    <button className="hubcard" onClick={() => navigate(route)}>
      <span className="hubicon">{icon}</span>
      <span className="hubtext">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="hubarrow">↗</span>
    </button>
  );
  return (
    <>
      <PageHeader title="设置与管理" description="备份、分类策略和已删除内容集中在这里。" />
      <div className="hubgrid">
        {card('⇅', '数据与备份', '完整 JSON 备份恢复、手机只读快照', 'data')}
        {card('☷', '分类与策略', '管理分类、标签和 AI 整理规则', 'rules')}
        {card('♧', '回收站', '查看或恢复已删除收藏', 'trash')}
        {card(ICONS.ai, 'AI 助手', '手动交接整理与提问；内置 AI 默认关闭', 'ai')}
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <h2>本地主库</h2>
        <p>
          数据保存在扩展 origin 下的 IndexedDB。弹窗、service worker 与工作台共享同一主库；
          普通网页不会写入第二份可编辑数据。
        </p>
        <div className="notice">
          切换浏览器配置或重装前，请先导出完整备份；旧库不应继续写入。
        </div>
      </div>
    </>
  );
}

export function RulesPage() {
  const { data, service, run, openModal } = useWorkspace();
  const [instruction, setInstruction] = useState(data.policy.instruction);

  return (
    <>
      <PageHeader
        title="分类少一点，边界清楚一点。"
        description="项目先用标签；规则变化只标记复查，不自动调用 AI。"
        action={
          <button className="btn" onClick={() => openModal({ kind: 'categories' })}>
            管理分类
          </button>
        }
      />
      <div className="panel">
        <h2>分类</h2>
        <p>一级分类，一条收藏至多一个分类；删除分类前必须迁移引用。</p>
        {data.categories.length === 0 ? <p className="micro">还没有分类。</p> : null}
        {data.categories.map((category) => (
          <div className="rule-row" key={category.id}>
            <span className="category-dot" />
            <strong>
              {category.name}
              <small>{category.description || '暂无说明'}</small>
            </strong>
            <small>{data.bookmarks.filter((bookmark) => bookmark.categoryId === category.id).length} 条</small>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>标签</h2>
        <p>标签用于跨分类描述主题，一条收藏最多 {LIMITS.tagsPerBookmark} 个。</p>
        <p>
          {data.tags.length === 0 ? (
            <span className="micro">还没有标签。可在收藏详情里创建。</span>
          ) : (
            data.tags.map((tag) => (
              <span className="tag" style={{ fontSize: 11, marginRight: 7 }} key={tag.id}>
                {tag.name}
              </span>
            ))
          )}
        </p>
      </div>

      <div className="panel">
        <h2>整理策略 · v{data.policy.policyVersion}</h2>
        <p>策略变化会使旧的 AI 结果失效，需要重新导出材料包。</p>
        <label className="field">
          <span>整理指令</span>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            style={{ minHeight: 110 }}
          />
        </label>
        <div className="actions">
          <button
            className="btn"
            onClick={() => setInstruction(data.policy.instruction)}
            disabled={instruction === data.policy.instruction}
          >
            还原
          </button>
          <button
            className="btn primary"
            disabled={instruction === data.policy.instruction}
            onClick={() =>
              void run(() => service.updatePolicy(instruction), '策略已更新，旧整理结果将失效。')
            }
          >
            保存并升级策略版本
          </button>
        </div>
      </div>
    </>
  );
}
