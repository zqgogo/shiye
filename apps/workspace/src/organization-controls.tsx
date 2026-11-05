import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppError, categoryPath, categoryFingerprint, type Category, type OrganizationMove, type OrganizationTarget } from '@shiye/core';
import { useWorkspace } from './state.js';
import type { WorkspaceService } from '@shiye/application';

async function moveWithMerge(service: WorkspaceService, input: OrganizationMove) {
  try { return await service.moveOrganization(input); }
  catch (cause) {
    if (!(cause instanceof AppError) || cause.code !== 'DUPLICATE' || input.items.length !== 1 || input.items[0]?.kind !== 'category') throw cause;
    const [snapshot, trash] = await Promise.all([service.snapshot(), service.listTrash()]);
    const included = new Set([input.items[0]!.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const category of snapshot.categories) if (category.parentId && included.has(category.parentId) && !included.has(category.id)) { included.add(category.id); changed = true; }
    }
    const count = [...snapshot.bookmarks, ...trash].filter((row) => row.categoryId && included.has(row.categoryId)).length;
    if (!window.confirm(`目标位置已有同名分类。将合并 ${included.size} 个目录，移动 ${count} 条收藏（含回收站中的记录）。是否继续？完成后可撤销。取消后可先重命名再移动。`)) throw new AppError('INVALID_INPUT', '已取消合并。');
    return service.moveOrganization({ ...input, merge: true });
  }
}

export const ORGANIZATION_DRAG = 'application/x-shiye-organization';
export function announceOrganization(id: string) {
  window.dispatchEvent(new CustomEvent('shiye-organization', { detail: id }));
}

export function MovePicker({ items }: { items: OrganizationTarget[] }) {
  const { data, run, service } = useWorkspace();
  const [target, setTarget] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<'last' | 'first' | 'before' | 'after'>('last');
  const [anchorId, setAnchorId] = useState('');
  const [anchorQuery, setAnchorQuery] = useState('');
  const details = useRef<HTMLDetailsElement>(null);
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const isCategory = items[0]?.kind === 'category';
  const selectedRows = items.map((item) => item.kind === 'category' ? data.categories.find((row) => row.id === item.id) : data.bookmarks.find((row) => row.id === item.id));
  const currentParents = selectedRows.map((row) => row ? 'categoryId' in row ? row.categoryId : row.parentId ?? null : null);
  const sharedParent = currentParents.every((id) => id === currentParents[0]) ? currentParents[0] ?? '' : '';
  const subject = items.length === 1 ? selectedRows[0] ? ('name' in selectedRows[0] ? selectedRows[0].name : selectedRows[0].title) : '已选项目' : `${items.length} 项${isCategory ? '分类' : '收藏'}`;
  const close = () => { if (busy) return; if (details.current) details.current.open = false; setOpen(false); };
  const forbidden = new Set(isCategory ? items.map((item) => item.id) : []);
  if (isCategory) { let changed = true; while (changed) { changed = false; for (const row of data.categories) if (row.parentId && forbidden.has(row.parentId) && !forbidden.has(row.id)) { forbidden.add(row.id); changed = true; } } }
  const moving = new Set(items.map((item) => item.id));
  const anchors = (items[0]?.kind === 'category'
    ? data.categories.filter((row) => (row.parentId ?? null) === (target || null) && !moving.has(row.id))
    : data.bookmarks.filter((row) => row.categoryId === (target || null) && !moving.has(row.id)))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
  const move = async () => {
    const category = data.categories.find((row) => row.id === target);
    const anchor = position === 'first' ? anchors[0] : anchors.find((row) => row.id === anchorId);
    if ((position === 'before' || position === 'after') && !anchor) return;
    setBusy(true);
    const result = await run(() => moveWithMerge(service, { items, ...(position !== 'last' && anchor ? { ...(position === 'after' ? { afterId: anchor.id } : { beforeId: anchor.id }), anchorRevision: 'localRevision' in anchor ? anchor.localRevision : anchor.revision } : {}), categoryFingerprint: categoryFingerprint(data.categories), parentId: target || null,
      ...(category ? { parentRevision: category.revision } : {}) }), '已移动，可在左侧目录树撤销。');
    setBusy(false);
    if (result) { announceOrganization(result.operationId); if (details.current) details.current.open = false; setOpen(false); }
  };
  const targetName = target ? categoryPath(data.categories, target) : isCategory ? '最外层（顶层分类）' : '未分类';
  const anchorName = anchors.find((row) => row.id === anchorId);
  const anchorLabel = anchorName ? ('name' in anchorName ? anchorName.name : anchorName.title) : '尚未选择的项目';
  const orderText = position === 'first' ? '最前面' : position === 'last' ? '最后面' : `「${anchorLabel}」${position === 'before' ? '前面' : '后面'}`;
  const sameParent = currentParents.every((id) => (id ?? '') === target);
  return <details ref={details} className="move-picker" onToggle={(event) => { const next = event.currentTarget.open; if (next && !open) { setTarget(sharedParent); setPosition('last'); setAnchorId(''); setQuery(''); setAnchorQuery(''); } setOpen(next); }}>
    <summary aria-label="移动分类或调整顺序" title="移动分类或调整顺序">移动 / 排序…</summary>
    {open && createPortal(<div className="modalshade move-shade" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <section className="modal move-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div className="modalheader"><h2 id={headingId}>移动与排序</h2><button className="iconbtn" aria-label="关闭移动面板" disabled={busy} onClick={close}>×</button></div>
        <p className="move-subject">{subject}</p>
        <p className="micro">只想换顺序？保持{isCategory ? '上级分类' : '所属分类'}不变，选择下方位置。选择其他分类则会改变归属。{isCategory ? '子分类和其中的收藏会一起移动。' : ''}</p>
        <label className="field"><span>1 · {isCategory ? '放在哪个上级分类下' : '保存到哪个分类'}</span>
          <input aria-label="搜索移动目标" placeholder="搜索完整分类路径…" value={query} onChange={(event) => setQuery(event.target.value)} disabled={busy} />
          <select aria-label="移动目标分类" value={target} disabled={busy} onChange={(event) => { setTarget(event.target.value); setAnchorId(''); }}>
            <option value="">{isCategory ? '最外层（成为顶层分类）' : '未分类'}</option>
            {data.categories.filter((row) => !forbidden.has(row.id) && (row.id === target || categoryPath(data.categories, row.id).toLowerCase().includes(query.toLowerCase()))).map((row) => <option key={row.id} value={row.id}>{categoryPath(data.categories, row.id)}</option>)}
          </select>
        </label>
        <label className="field"><span>2 · 在这个位置如何排列</span><select aria-label="移动后的顺序" disabled={busy} value={position} onChange={(event) => setPosition(event.target.value as typeof position)}><option value="last">放到同级最后</option><option value="first">放到同级最前</option><option value="before">放到某一项前面…</option><option value="after">放到某一项后面…</option></select></label>
        {(position === 'before' || position === 'after') && <label className="field"><span>选择参照项目（同一层级）</span><input aria-label="搜索排序目标" placeholder="搜索参照项目…" disabled={busy} value={anchorQuery} onChange={(event) => setAnchorQuery(event.target.value)} /><select aria-label="排序目标" disabled={busy} value={anchorId} onChange={(event) => setAnchorId(event.target.value)}><option value="">请选择参照项目</option>{anchors.filter((row) => row.id === anchorId || ('title' in row ? row.title : row.name).includes(anchorQuery)).map((row) => <option value={row.id} key={row.id}>{'title' in row ? row.title : row.name}</option>)}</select>{!anchors.length && <small>这个位置没有其他项目，可改选“最前”或“最后”。</small>}</label>}
        <div className="move-preview" role="status"><b>确认后会发生什么</b><p>将「{subject}」放到「{targetName}」的{orderText}。</p><small>{sameParent ? '所属分类保持不变，只调整同级顺序。' : isCategory ? '上级分类会改变，子分类和收藏随之移动。' : '收藏会归入所选分类。'} 完成后可在左侧撤销上次移动。</small></div>
        <div className="actions"><button className="btn" disabled={busy} onClick={close}>取消</button><button className="btn primary" disabled={busy || ((position === 'before' || position === 'after') && !anchorId)} onClick={() => void move()}>{busy ? '正在调整…' : sameParent ? '确认调整顺序' : '确认移动'}</button></div>
      </section>
    </div>, document.body)}
  </details>;
}

export function OrganizationTree() {
  const { data, service, run, navigate, route, toast, openModal } = useWorkspace();
  // Only explicit user expansion opens a branch; newly imported IDs stay closed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const hoverTimer = useRef<number | null>(null);
  useEffect(() => () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); }, []);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const categoryDrag = useRef(false);
  const [placement, setPlacement] = useState<'before' | 'inside' | 'after'>('inside');
  const positionAt = (event: React.DragEvent) => {
    if (!categoryDrag.current) return 'inside' as const;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientY - rect.top) / rect.height;
    return fraction < .25 ? 'before' as const : fraction > .75 ? 'after' as const : 'inside' as const;
  };
  const clearHover = () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = null; };
  useEffect(() => {
    const listener = (event: Event) => setOperationId((event as CustomEvent<string>).detail);
    window.addEventListener('shiye-organization', listener);
    return () => window.removeEventListener('shiye-organization', listener);
  }, []);

  const apply = async (items: OrganizationTarget[], parent: Category | null, beforeId?: string, afterId?: string) => {
    const anchor = data.categories.find((row) => row.id === (beforeId ?? afterId));
    const input: OrganizationMove = { items, categoryFingerprint: categoryFingerprint(data.categories), parentId: parent?.id ?? null,
      ...(parent ? { parentRevision: parent.revision } : {}), ...(beforeId ? { beforeId } : {}), ...(afterId ? { afterId } : {}), ...(anchor ? { anchorRevision: anchor.revision } : {}) };
    const result = await run(() => moveWithMerge(service, input), '已移动。');
    if (result) announceOrganization(result.operationId);
  };
  const drop = (event: React.DragEvent, parent: Category | null, beforeId?: string, afterId?: string) => {
    const readingId = event.dataTransfer.getData('application/x-shiye-reading');
    if (readingId) {
      event.preventDefault(); event.stopPropagation(); setTarget(null);
      openModal({ kind: 'convert-reading', readingId, categoryId: parent?.id ?? null });
      return;
    }
    const staged = event.dataTransfer.getData('application/x-shiye-draft-rows');
    if (staged) {
      event.preventDefault(); event.stopPropagation(); setTarget(null);
      try {
        const payload = JSON.parse(staged) as { draftId: string; keys: string[] };
        window.dispatchEvent(new CustomEvent('shiye-import-drop', { detail: { ...payload, parentId: parent?.id ?? null } }));
      } catch { toast('无法读取暂存记录，请重新拖动。', 'error'); }
      return;
    }
    const raw = event.dataTransfer.getData(ORGANIZATION_DRAG);
    if (!raw) return;
    event.preventDefault(); event.stopPropagation(); setTarget(null);
    try { const items = JSON.parse(raw) as OrganizationTarget[]; if (items.some((item) => item.id === (beforeId ?? afterId))) return; void apply(items, parent, beforeId, afterId); }
    catch { toast('无法读取拖动内容，请重新拖动。', 'error'); }
  };
  const children = (parentId: string | null, seen = new Set<string>()): React.ReactNode =>
    data.categories.filter((row) => (row.parentId ?? null) === parentId && !seen.has(row.id))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'zh-CN'))
      .map((row) => {
        const next = new Set(seen); next.add(row.id);
        const hasChildren = data.categories.some((child) => child.parentId === row.id);
        return <div key={row.id} className="category-node">
          <div className={`category-drop ${target === row.id ? `drop-${placement}` : ''}`}
            onDragStart={(event) => { if (!(event.target as Element).closest('.drag-handle')) return; event.stopPropagation(); categoryDrag.current = true; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(ORGANIZATION_DRAG, JSON.stringify([{ kind: 'category', id: row.id, revision: row.revision }])); }}
            onDragEnd={() => { categoryDrag.current = false; setTarget(null); clearHover(); }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.some((type) => [ORGANIZATION_DRAG, 'application/x-shiye-reading', 'application/x-shiye-draft-rows'].includes(type))) return;
              event.preventDefault(); event.stopPropagation(); const position = positionAt(event); setTarget(row.id); setPlacement(position);
              if (position !== 'inside') clearHover();
              if (position === 'inside' && hasChildren && !expanded.has(row.id) && hoverTimer.current === null) hoverTimer.current = window.setTimeout(() => { setExpanded((current) => { const next = new Set(current); next.add(row.id); return next; }); hoverTimer.current = null; }, 650);
            }}
            onDragLeave={(event) => { if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return; setTarget(null); if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }} onDrop={(event) => { clearHover(); const position = positionAt(event); const parent = data.categories.find((item) => item.id === parentId) ?? null; drop(event, position === 'inside' ? row : parent, position === 'before' ? row.id : undefined, position === 'after' ? row.id : undefined); categoryDrag.current = false; }} title={categoryPath(data.categories, row.id)}>
            <button className="iconbtn drag-handle" draggable aria-label={`拖动分类 ${row.name}`} title="拖到行上缘或下缘调整顺序；拖到行中间移入分类">⋮</button>
            <button className="iconbtn" aria-expanded={hasChildren ? expanded.has(row.id) : undefined} aria-label={`${!expanded.has(row.id) ? '展开' : '折叠'} ${row.name}`}
              onClick={() => setExpanded((current) => { const value = new Set(current); value.has(row.id) ? value.delete(row.id) : value.add(row.id); return value; })}>{hasChildren ? !expanded.has(row.id) ? '▸' : '▾' : '·'}</button>
            <button className={`nav ${route === `cat:${row.id}` ? 'active' : ''}`} onClick={() => navigate(`cat:${row.id}`)}><span className="category-label">{seen.size >= 4 && <small className="category-depth" title={`第 ${seen.size + 1} 层`}>{seen.size + 1}</small>}{row.name}</span></button>
          <MovePicker items={[{ kind: 'category', id: row.id, revision: row.revision }]} /></div>
          {expanded.has(row.id) && hasChildren && <div className={`category-children ${seen.size >= 3 ? 'category-deep' : ''}`}>{children(row.id, next)}</div>}
        </div>;
      });

  return <div className="organization-tree">
    <div className="category-root-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, null)}>拖到这里提升到根级 / 移至未分类</div>
    <div className="category-drop-hint" role="status">{target ? placement === 'inside' ? '移入分类：' : placement === 'before' ? '放在前面：' : '放在后面：' : ''}{data.categories.find((row) => row.id === target)?.name}{!target && '拖动：上下边缘排序，中间移入'}</div>
    {children(null)}
    {operationId && <button className="btn small" onClick={async () => {
      const result = await run(async () => { await service.undoOrganization(operationId); return true; }, '已撤销移动。');
      if (result) setOperationId(null);
    }}>撤销上次移动 / 排序</button>}
  </div>;
}
