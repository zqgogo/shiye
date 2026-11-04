import {
  AppError, ImportDraftSchema, LIMITS, newId, nowIso, categoryFingerprint,
  type Category, type ImportArrangement, type ImportDraft, type ImportRow,
  type OrganizationMove, type OrganizationRepository, type OrganizationTarget,
} from '@shiye/core';
import { deriveIndexFields, type ShiyeDB } from './db.js';

function fail(message: string): never { throw new AppError('REVISION_CONFLICT', message); }

export function assertCategoryTree(categories: Category[]): void {
  const byId = new Map(categories.map((row) => [row.id, row]));
  const siblings = new Set<string>();
  for (const row of categories) {
    const key = JSON.stringify([row.parentId ?? null, row.name]);
    if (siblings.has(key)) throw new AppError('DUPLICATE', '目标位置已有同名分类，请先重命名再移动。');
    siblings.add(key);
    const visited = new Set([row.id]);
    let parent = row.parentId;
    let depth = 1;
    while (parent) {
      if (visited.has(parent)) throw new AppError('INVALID_INPUT', '分类不能移入自己或自己的子分类。');
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) throw new AppError('NOT_FOUND', '父分类已经不存在，请刷新后重试。');
      parent = ancestor.parentId;
      if (++depth > LIMITS.importDepth) throw new AppError('INVALID_INPUT', '分类层级超过 32 层，请减少层级。');
    }
  }
}

export function collectCategoryDependencies(categories: Category[], categoryIds: (string | null)[]): Category[] {
  const needed = new Set<string>();
  for (let id of categoryIds) {
    while (id && !needed.has(id)) {
      needed.add(id);
      id = categories.find((row) => row.id === id)?.parentId ?? null;
    }
  }
  return categories.filter((row) => needed.has(row.id));
}

/** Called inside the import transaction, after the URL has passed final deduplication. */
export async function resolveImportCategory(
  db: ShiyeDB, arrangement: ImportArrangement, row: ImportRow, batchId: string,
): Promise<string | null> {
  if (arrangement.mode === 'manual') return row.targetCategoryId;
  let parentId = arrangement.parentId;
  const path = arrangement.paths[row.sourceKey] ?? row.sourceFolderSegments ??
    (row.sourceFolder ? row.sourceFolder.split(' / ') : []);
  const names = arrangement.mode === 'group' ? [arrangement.groupName, ...path] : path;
  if (names.length > LIMITS.importDepth) throw new AppError('INVALID_INPUT', '目录超过 32 层，请调整目录。');
  for (const value of names) {
    const name = value.trim();
    if (!name || name.length > LIMITS.categoryName) {
      throw new AppError('INVALID_INPUT', '分类名称需为 1–60 字，请在导入预览中调整过长目录名。');
    }
    const existing = (await db.categories.where('name').equals(name).toArray())
      .find((category) => (category.parentId ?? null) === parentId);
    if (existing) {
      // Each new group belongs to its import. Never merge two unrelated imports into it silently.
      if (arrangement.mode === 'group' && parentId === arrangement.parentId &&
          existing.createdByImportId !== batchId && existing.id !== arrangement.groupCategoryId) {
        throw new AppError('DUPLICATE', '分类组名称已存在，请修改组名后重新预览。');
      }
      parentId = existing.id;
    } else {
      const now = nowIso();
      const category: Category = {
        id: newId(), parentId, name, description: '', revision: 1, createdAt: now, updatedAt: now,
        sortOrder: Math.max(0, ...(await db.categories.toArray()).map((row) => row.sortOrder ?? 0)) + 1024, createdByImportId: batchId,
      };
      await db.categories.add(category);
      parentId = category.id;
    }
  }
  return parentId;
}

interface MoveEntry {
  target: OrganizationTarget;
  oldParent: string | null;
  oldOrder: number;
  newParent: string | null;
  newOrder: number;
  appliedRevision: number;
}
interface MoveLog { id: string; entries: MoveEntry[]; undone: boolean; mergedCategories?: Category[]; }

export class DexieOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: ShiyeDB) {}

  async drafts(): Promise<ImportDraft[]> {
    const rows = await this.db.meta.where('key').startsWith('import-draft:').toArray();
    return rows.map((row) => ImportDraftSchema.parse(row.value)).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async draftRevision(id: string): Promise<number | null> {
    const row = await this.db.meta.get(`import-draft:${id}`);
    const revision = (row?.value as { revision?: unknown } | undefined)?.revision;
    return typeof revision === 'number' ? revision : null;
  }

  async saveDraft(raw: ImportDraft): Promise<ImportDraft> {
    const draft = ImportDraftSchema.parse(raw);
    return this.db.transaction('rw', this.db.meta, async () => {
      const key = `import-draft:${draft.id}`;
      const stored = await this.db.meta.get(key);
      const current = stored ? ImportDraftSchema.parse(stored.value) : null;
      if (current && current.revision !== draft.revision) fail('这份暂存已在另一页面更新，请重新打开。');
      const next = { ...draft, revision: current ? current.revision + 1 : 1, savedAt: nowIso() };
      if (new TextEncoder().encode(JSON.stringify(next, null, 2)).length > LIMITS.importDraftBytes) throw new AppError('INVALID_INPUT', '暂存内容超过 100 MB，请减少记录或缩短目录后分批保存。');
      await this.db.meta.put({ key, value: next });
      return next;
    });
  }

  async removeDraft(id: string, revision: number): Promise<void> {
    await this.db.transaction('rw', this.db.meta, async () => {
      const key = `import-draft:${id}`;
      const stored = await this.db.meta.get(key);
      if (!stored) return;
      if (ImportDraftSchema.parse(stored.value).revision !== revision) fail('暂存已更新，请重新打开后再移除。');
      await this.db.meta.delete(key);
    });
  }

  async move(input: OrganizationMove) {
    if (input.merge) return this.merge(input);
    return this.db.transaction('rw', [this.db.categories, this.db.bookmarks, this.db.meta, this.db.handoffBatches], async () => {
      const categories = await this.db.categories.toArray();
      if (input.categoryFingerprint && input.categoryFingerprint !== categoryFingerprint(categories)) fail('目录结构已变化，请重新移动。');
      const parent = input.parentId ? categories.find((row) => row.id === input.parentId) : null;
      if (input.parentId && (!parent || parent.revision !== input.parentRevision)) fail('目标分类已变化，请重新选择。');
      const ids = new Set(input.items.map((row) => row.id));
      if (ids.size !== input.items.length || !input.items.length) {
        throw new AppError('INVALID_INPUT', '请选择不同的记录后移动。');
      }
      const kind = input.items[0]!.kind;
      if (!['category', 'bookmark'].includes(kind)) throw new AppError('INVALID_INPUT', '不支持的移动对象。');
      if (input.items.some((row) => row.kind !== kind)) throw new AppError('INVALID_INPUT', '请分别移动分类和收藏。');
      const all = kind === 'category' ? categories : await this.db.bookmarks.toArray();
      const siblings = all.filter((row) => {
        const parentId = 'categoryId' in row ? row.categoryId : row.parentId ?? null;
        return parentId === input.parentId && !ids.has(row.id);
      }).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
      const normalization: MoveEntry[] = [];
      if (siblings.some((row, index) => index > 0 && (row.sortOrder ?? 0) <= (siblings[index - 1]!.sortOrder ?? 0))) {
        for (const [index, row] of siblings.entries()) {
          const oldOrder = row.sortOrder ?? 0;
          const revision = 'localRevision' in row ? row.localRevision : row.revision;
          const order = (index + 1) * 1024;
          const target: OrganizationTarget = { kind, id: row.id, revision };
          normalization.push({ target, oldParent: input.parentId, oldOrder, newParent: input.parentId, newOrder: order, appliedRevision: revision + 1 });
          if ('localRevision' in row) {
            row.localRevision++; row.revision++; row.sortOrder = order; row.updatedAt = nowIso();
            await this.db.bookmarks.put(row);
          } else {
            row.revision++; row.sortOrder = order; row.updatedAt = nowIso();
            await this.db.categories.put(row);
          }
        }
      }
      const anchorId = input.beforeId ?? input.afterId;
      const anchorIndex = anchorId ? siblings.findIndex((row) => row.id === anchorId) : siblings.length;
      if (anchorIndex < 0) fail('排序目标已移动，请重试。');
      if (anchorId && input.anchorRevision !== undefined) {
        const row = siblings[anchorIndex]!;
        const original = all.find((item) => item.id === row.id)!;
        const revision = 'localRevision' in original ? original.localRevision : original.revision;
        const prior = normalization.find((entry) => entry.target.id === row.id);
        if ((prior?.target.revision ?? revision) !== input.anchorRevision) fail('排序锚点已变化，请重新选择。');
      }
      const anchor = anchorId && input.afterId ? anchorIndex + 1 : anchorIndex;
      const low = anchor > 0 ? siblings[anchor - 1]!.sortOrder ?? 0 : (siblings[0]?.sortOrder ?? 0) - 1024;
      const high = anchor < siblings.length ? siblings[anchor]!.sortOrder ?? 0 : low + 1024;
      const step = (high - low) / (input.items.length + 1);
      if (!(step > 0) || low + step === low) fail('当前位置需要重新排序，请选择移到末尾。');
      const entries: MoveEntry[] = [...normalization];
      for (const [index, target] of input.items.entries()) {
        const row = all.find((item) => item.id === target.id);
        if (!row) fail('记录已被移除，请刷新。');
        const revision = 'localRevision' in row ? row.localRevision : row.revision;
        if (revision !== target.revision || ('deletedAt' in row && row.deletedAt)) fail('记录已变化，请刷新后重新移动。');
        const order = low + step * (index + 1);
        entries.push({ target, oldParent: 'categoryId' in row ? row.categoryId : row.parentId ?? null,
          oldOrder: row.sortOrder ?? 0, newParent: input.parentId, newOrder: order, appliedRevision: revision + 1 });
        if (target.kind === 'category') {
          const category = row as Category;
          await this.db.categories.put({ ...category, parentId: input.parentId, sortOrder: order,
            revision: category.revision + 1, updatedAt: nowIso() });
        } else {
          const bookmark = await this.db.bookmarks.get(target.id);
          if (!bookmark) fail('收藏已不存在。');
          const next = { ...bookmark, categoryId: input.parentId, sortOrder: order,
            localRevision: bookmark.localRevision + 1, revision: bookmark.revision + 1, updatedAt: nowIso() };
          Object.assign(next, deriveIndexFields(next));
          await this.db.bookmarks.put(next);
        }
      }
      assertCategoryTree(await this.db.categories.toArray());
      if (input.items[0]?.kind === 'category') await this.db.handoffBatches.where('status').anyOf(['exported', 'partial']).modify({ status: 'invalidated' });
      const id = newId();
      await this.db.meta.put({ key: `organization:${id}`, value: { id, entries, undone: false } satisfies MoveLog });
      return { operationId: id, moved: input.items.length };
    });
  }

  private async merge(input: OrganizationMove) {
    return this.db.transaction('rw', [this.db.categories, this.db.bookmarks, this.db.meta, this.db.handoffBatches], async () => {
      const target = input.items[0];
      if (input.items.length !== 1 || target?.kind !== 'category') throw new AppError('INVALID_INPUT', '请一次合并一个分类。');
      if (input.categoryFingerprint && input.categoryFingerprint !== categoryFingerprint(await this.db.categories.toArray())) fail('目录结构已变化，请重新移动。');
      const source = await this.db.categories.get(target.id);
      if (!source || source.revision !== target.revision) fail('源分类已变化，请重新选择。');
      const parent = input.parentId ? await this.db.categories.get(input.parentId) : null;
      if (input.parentId && (!parent || parent.revision !== input.parentRevision)) fail('目标分类已变化，请重新选择。');
      const all = await this.db.categories.toArray();
      // Check the proposed parent relation before any source node is removed.
      assertCategoryTree(all.filter((row) => row.id !== source.id).concat({ ...source, parentId: input.parentId, name: `${source.name} · 检查` }));
      const destination = all.find((row) => row.id !== source.id && (row.parentId ?? null) === input.parentId && row.name === source.name);
      if (!destination) fail('同名目标分类已变化，请重新移动。');
      let ancestorId = source.parentId;
      while (ancestorId) {
        if (ancestorId === destination.id) throw new AppError('INVALID_INPUT', '分类不能直接合并到同名祖先，请先调整目录位置。');
        ancestorId = all.find((row) => row.id === ancestorId)?.parentId;
      }
      const entries: MoveEntry[] = [];
      const removed: Category[] = [];
      const mergeInto = async (from: Category, into: Category): Promise<void> => {
        for (const bookmark of await this.db.bookmarks.where('categoryKey').equals(from.id).toArray()) {
          const order = Math.max(0, ...(await this.db.bookmarks.where('categoryKey').equals(into.id).toArray()).map((row) => row.sortOrder ?? 0)) + 1024;
          const next = { ...bookmark, categoryId: into.id, sortOrder: order, localRevision: bookmark.localRevision + 1,
            revision: bookmark.revision + 1, updatedAt: nowIso() };
          Object.assign(next, deriveIndexFields(next));
          await this.db.bookmarks.put(next);
          entries.push({ target: { kind: 'bookmark', id: bookmark.id, revision: bookmark.localRevision },
            oldParent: from.id, oldOrder: bookmark.sortOrder ?? 0, newParent: into.id,
            newOrder: order, appliedRevision: next.localRevision });
        }
        const children = (await this.db.categories.toArray()).filter((row) => row.parentId === from.id);
        for (const child of children) {
          const sibling = (await this.db.categories.toArray()).find((row) => row.parentId === into.id && row.name === child.name);
          if (sibling) await mergeInto(child, sibling);
          else {
            const order = Math.max(0, ...(await this.db.categories.toArray()).filter((row) => row.parentId === into.id).map((row) => row.sortOrder ?? 0)) + 1024;
            await this.db.categories.put({ ...child, parentId: into.id, sortOrder: order, revision: child.revision + 1, updatedAt: nowIso() });
            entries.push({ target: { kind: 'category', id: child.id, revision: child.revision }, oldParent: from.id,
              oldOrder: child.sortOrder ?? 0, newParent: into.id, newOrder: order, appliedRevision: child.revision + 1 });
          }
        }
        removed.push(from);
        await this.db.categories.delete(from.id);
      };
      await mergeInto(source, destination);
      assertCategoryTree(await this.db.categories.toArray());
      if (input.items[0]?.kind === 'category') await this.db.handoffBatches.where('status').anyOf(['exported', 'partial']).modify({ status: 'invalidated' });
      const id = newId();
      await this.db.meta.put({ key: `organization:${id}`, value: { id, entries, mergedCategories: removed, undone: false } satisfies MoveLog });
      return { operationId: id, moved: entries.length + removed.length };
    });
  }

  async undo(operationId: string): Promise<void> {
    await this.db.transaction('rw', [this.db.categories, this.db.bookmarks, this.db.meta, this.db.handoffBatches], async () => {
      const key = `organization:${operationId}`;
      const stored = await this.db.meta.get(key);
      const log = stored?.value as MoveLog | undefined;
      if (!log || log.undone) fail('这次移动已经撤销或不存在。');
      for (const category of log.mergedCategories ?? []) {
        if (await this.db.categories.get(category.id)) fail('原分类编号已被使用，撤销已停止。');
        await this.db.categories.put({ ...category, revision: category.revision + 1, updatedAt: nowIso() });
      }
      for (const entry of log.entries) {
        if (entry.oldParent && !(await this.db.categories.get(entry.oldParent))) fail('原分类已删除，无法撤销。');
        if (entry.target.kind === 'category') {
          const row = await this.db.categories.get(entry.target.id);
          if (!row || row.revision !== entry.appliedRevision) fail('分类移动后又被修改，撤销已停止。');
          await this.db.categories.put({ ...row, parentId: entry.oldParent, sortOrder: entry.oldOrder,
            revision: row.revision + 1, updatedAt: nowIso() });
        } else {
          const row = await this.db.bookmarks.get(entry.target.id);
          if (!row || row.localRevision !== entry.appliedRevision || row.deletedAt) fail('收藏移动后又被修改，撤销已停止。');
          const next = { ...row, categoryId: entry.oldParent, sortOrder: entry.oldOrder,
            revision: row.revision + 1, localRevision: row.localRevision + 1, updatedAt: nowIso() };
          Object.assign(next, deriveIndexFields(next));
          await this.db.bookmarks.put(next);
        }
      }
      assertCategoryTree(await this.db.categories.toArray());
      if (log.mergedCategories?.length || log.entries.some((entry) => entry.target.kind === 'category')) await this.db.handoffBatches.where('status').anyOf(['exported', 'partial']).modify({ status: 'invalidated' });
      await this.db.meta.put({ key, value: { ...log, undone: true } });
    });
  }
}
