import { useEffect, useMemo, useState } from 'react';
import { categoryPath, domainOf, paginate, toUserMessage, LIMITS } from '@shiye/core';
import { subscribeDataChanged, type WorkspaceService, type WorkspaceSnapshot } from '@shiye/application';
import { openExternal } from '../../../../packages/adapters/browser/src/index.js';

export function QuickAccess({ service }: { service: WorkspaceService }) {
  const [data, setData] = useState<WorkspaceSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => { void service.snapshot().then((next) => { if (live) setData(next); }).catch((cause) => { if (live) setError(toUserMessage(cause)); }); };
    load();
    const stop = subscribeDataChanged(load);
    window.addEventListener('focus', load);
    return () => { live = false; stop(); window.removeEventListener('focus', load); };
  }, [service]);
  const categories = useMemo(() => new Map(data?.categories.map((row) => [row.id, categoryPath(data.categories, row.id)]) ?? []), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const subtree = new Set<string>();
    if (category) {
      subtree.add(category);
      for (let changed = true; changed;) {
        changed = false;
        for (const row of data.categories) if (row.parentId && subtree.has(row.parentId) && !subtree.has(row.id)) { subtree.add(row.id); changed = true; }
      }
    }
    const candidates = scope === 'reading'
      ? data.pendingReading.map((row) => ({ id: row.id, title: row.title, url: row.originalUrl, categoryId: null, opened: '', pinned: false, kind: 'reading' as const }))
      : data.bookmarks.map((row) => ({ id: row.id, title: row.title, url: row.originalUrl, categoryId: row.categoryId, opened: row.lastOpenedAt ?? '', pinned: row.pinned, kind: 'bookmark' as const }));
    const term = query.trim().toLowerCase();
    const sorted = candidates.filter((row) => (!category || (row.categoryId && subtree.has(row.categoryId))) &&
      (scope !== 'pinned' || row.pinned) && (scope !== 'recent' || row.opened) &&
      (!term || `${row.title} ${row.url} ${categories.get(row.categoryId ?? '') ?? ''}`.toLowerCase().includes(term)))
      .sort((a, b) => scope === 'recent' ? b.opened.localeCompare(a.opened) : Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title, 'zh-CN'));
    return scope === 'recent' ? sorted.slice(0, LIMITS.recentOpened) : sorted;
  }, [data, query, scope, category, categories]);
  const view = paginate(rows, page, 20);
  const open = async (row: typeof rows[number]) => {
    setOpening(true); setError('');
    try {
      // Opening a tab can destroy the native popup immediately; persist the click first.
      if (row.kind === 'bookmark') await service.touchOpened(row.id);
      await openExternal(row.url);
    } catch (cause) { setError(toUserMessage(cause)); }
    finally { setOpening(false); }
  };
  return <section aria-label="快速访问收藏">
    <h2>想去哪里？</h2>
    <label className="field"><span>搜索收藏</span><input autoFocus value={query} placeholder="标题、网址或分类…" onChange={(event) => { setQuery(event.target.value); setPage(1); }} /></label>
    <div className="quick-tabs" aria-label="浏览范围">{[['all', '全部'], ['pinned', '置顶'], ['recent', '最近'], ['reading', '待看']].map(([value, label]) =>
      <button key={value} className={`btn small ${scope === value ? 'primary' : ''}`} aria-pressed={scope === value} onClick={() => { setScope(value!); setCategory(''); setPage(1); }}>{label}</button>)}</div>
    {scope !== 'reading' && <label className="field"><span>分类（包含子分类）</span><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">全部分类</option>{[...categories].map(([id, path]) => <option key={id} value={id}>{path}</option>)}</select></label>}
    {error && <p className="alert" role="alert">{error}</p>}
    {!data ? <p>正在读取本机收藏…</p> : <><p className="micro">匹配 {view.total} 条 · 点击直接打开网址</p>
      <div className="quick-results">{view.rows.map((row) => <button disabled={opening} className="quick-link" key={`${row.kind}:${row.id}`} onClick={() => void open(row)}><strong>{row.pinned ? '★ ' : ''}{row.title || domainOf(row.url)} <span>↗</span></strong><small>{domainOf(row.url)} · {row.kind === 'reading' ? '待看' : categories.get(row.categoryId ?? '') || '未分类'}</small></button>)}</div>
      {!view.total && <p className="notice">没有匹配记录。换个关键词，或切回「收藏当前页」收下第一条。</p>}
      <div className="quick-tabs"><button className="btn small" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>上一页</button><span className="micro">{view.page} / {view.pageCount || 1}</span><button className="btn small" disabled={view.page >= view.pageCount} onClick={() => setPage(view.page + 1)}>下一页</button></div></>}
  </section>;
}
