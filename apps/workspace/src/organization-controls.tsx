import { useEffect, useRef, useState } from 'react';
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
  const moving = new Set(items.map((item) => item.id));
  const anchors = (items[0]?.kind === 'category'
    ? data.categories.filter((row) => (row.parentId ?? null) === (target || null) && !moving.has(row.id))
    : data.bookmarks.filter((row) => row.categoryId === (target || null) && !moving.has(row.id)))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
  const move = async () => {
    const category = data.categories.find((row) => row.id === target);
    const anchor = position === 'first' ? anchors[0] : anchors.find((row) => row.id === anchorId);
    if ((position === 'before' || position === 'after') && !anchor) return;
    const result = await run(() => moveWithMerge(service, { items, ...(position !== 'last' && anchor ? { ...(position === 'after' ? { afterId: anchor.id } : { beforeId: anchor.id }), anchorRevision: 'localRevision' in anchor ? anchor.localRevision : anchor.revision } : {}), categoryFingerprint: categoryFingerprint(data.categories), parentId: target || null,
      ...(category ? { parentRevision: category.revision } : {}) }), '已移动，可在左侧目录树撤销。');
    if (result) announceOrganization(result.operationId);
  };
  return <details className="move-picker" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>移动到…</summary>{open && <>
    <input aria-label="搜索移动目标" placeholder="搜索分类路径" value={query} onChange={(event) => setQuery(event.target.value)} />
    <select aria-label="移动目标分类" value={target} onChange={(event) => { setTarget(event.target.value); setAnchorId(''); }}>
      <option value="">根级 / 未分类</option>
      {data.categories.filter((row) => categoryPath(data.categories, row.id).toLowerCase().includes(query.toLowerCase())).map((row) => <option key={row.id} value={row.id}>{categoryPath(data.categories, row.id)}</option>)}
    </select>
    <select aria-label="移动后的顺序" value={position} onChange={(event) => setPosition(event.target.value as typeof position)}><option value="last">放到最后</option><option value="first">放到最前</option><option value="before">放到指定项目之前</option><option value="after">放到指定项目之后</option></select>
    {(position === 'before' || position === 'after') && <><input aria-label="搜索排序目标" placeholder="搜索目标项目" value={anchorQuery} onChange={(event) => setAnchorQuery(event.target.value)} /><select aria-label="排序目标" value={anchorId} onChange={(event) => setAnchorId(event.target.value)}><option value="">选择目标项目</option>{anchors.filter((row) => ('title' in row ? row.title : row.name).includes(anchorQuery)).map((row) => <option value={row.id} key={row.id}>{'title' in row ? row.title : row.name}</option>)}</select></>}
    <button className="btn small" disabled={(position === 'before' || position === 'after') && !anchorId} onClick={() => void move()}>移动 {items.length} 项</button></>}
  </details>;
}

export function OrganizationTree() {
  const { data, service, run, navigate, route, toast, openModal } = useWorkspace();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const hoverTimer = useRef<number | null>(null);
  useEffect(() => () => { if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); }, []);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    const listener = (event: Event) => setOperationId((event as CustomEvent<string>).detail);
    window.addEventListener('shiye-organization', listener);
    return () => window.removeEventListener('shiye-organization', listener);
  }, []);

  const apply = async (items: OrganizationTarget[], parent: Category | null, beforeId?: string) => {
    const input: OrganizationMove = { items, categoryFingerprint: categoryFingerprint(data.categories), parentId: parent?.id ?? null,
      ...(parent ? { parentRevision: parent.revision } : {}), ...(beforeId ? { beforeId } : {}) };
    const result = await run(() => moveWithMerge(service, input), '已移动。');
    if (result) announceOrganization(result.operationId);
  };
  const drop = (event: React.DragEvent, parent: Category | null, beforeId?: string) => {
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
    try { void apply(JSON.parse(raw) as OrganizationTarget[], parent, beforeId); }
    catch { toast('无法读取拖动内容，请重新拖动。', 'error'); }
  };
  const children = (parentId: string | null, seen = new Set<string>()): React.ReactNode =>
    data.categories.filter((row) => (row.parentId ?? null) === parentId && !seen.has(row.id))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name, 'zh-CN'))
      .map((row) => {
        const next = new Set(seen); next.add(row.id);
        const hasChildren = data.categories.some((child) => child.parentId === row.id);
        return <div key={row.id} className="category-node">
          <div className="category-insert" aria-label={`移到 ${row.name} 前面`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, data.categories.find((parent) => parent.id === parentId) ?? null, row.id)} />
          <div className={`category-drop ${target === row.id ? 'drop-active' : ''}`}
            onDragStart={(event) => { if (!(event.target as Element).closest('.drag-handle')) return; event.stopPropagation(); event.dataTransfer.setData(ORGANIZATION_DRAG, JSON.stringify([{ kind: 'category', id: row.id, revision: row.revision }])); }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.some((type) => [ORGANIZATION_DRAG, 'application/x-shiye-reading', 'application/x-shiye-draft-rows'].includes(type))) return;
              event.preventDefault(); event.stopPropagation(); setTarget(row.id);
              if (collapsed.has(row.id) && hoverTimer.current === null) hoverTimer.current = window.setTimeout(() => { setCollapsed((current) => { const next = new Set(current); next.delete(row.id); return next; }); hoverTimer.current = null; }, 650);
            }}
            onDragLeave={(event) => { if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return; setTarget(null); if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }} onDrop={(event) => drop(event, row)} title={categoryPath(data.categories, row.id)}>
            <button className="iconbtn drag-handle" draggable aria-label={`拖动分类 ${row.name}`} title="拖到分类内部改变层级，拖到插入线调整顺序">⋮</button>
            <button className="iconbtn" aria-label={`${collapsed.has(row.id) ? '展开' : '折叠'} ${row.name}`}
              onClick={() => setCollapsed((current) => { const value = new Set(current); value.has(row.id) ? value.delete(row.id) : value.add(row.id); return value; })}>{hasChildren ? collapsed.has(row.id) ? '▸' : '▾' : '·'}</button>
            <button className={`nav ${route === `cat:${row.id}` ? 'active' : ''}`} onClick={() => navigate(`cat:${row.id}`)}>{row.name}</button>
          <MovePicker items={[{ kind: 'category', id: row.id, revision: row.revision }]} /></div>
          {!collapsed.has(row.id) && hasChildren && <div className="category-children">{children(row.id, next)}</div>}
        </div>;
      });

  return <div className="organization-tree">
    <div className="category-root-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, null)}>拖到这里提升到根级 / 移至未分类</div>
    {children(null)}
    {operationId && <button className="btn small" onClick={async () => {
      const result = await run(async () => { await service.undoOrganization(operationId); return true; }, '已撤销移动。');
      if (result) setOperationId(null);
    }}>撤销上次移动 / 排序</button>}
  </div>;
}
