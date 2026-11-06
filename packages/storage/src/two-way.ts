import { AppError, newId, nowIso, canonicalizeUrl } from '@shiye/core';
import type { Bookmark, Category, Tag, ReadingItem } from '@shiye/core';
import type { ShiyeDB } from './db.js';
import type { SharedLocal, SharedPlan, SharedState } from '../../sync/src/two-way-local.js';
import { type SharedRow, sameData } from '../../sync/src/two-way.js';
import { writePurgeSnapshot } from './purge.js';
import { sameIdentity } from '../../sync/src/protocol.js';
export function createTwoWayRepository(db: ShiyeDB) {
  const key = (address: string) => `cloud-sync:${address}`;
  const tables = [db.settings, db.meta, db.bookmarks, db.categories, db.tags, db.tombstones, db.readingItems, db.purgeSnapshots];
  async function read(address: string): Promise<SharedLocal> {
    const localLibraryId = ((await db.settings.get('app'))?.value as { libraryId?: string } | undefined)?.libraryId ?? '';
    if (!localLibraryId) throw new AppError('INVALID_INPUT', '请先初始化本地主库。');
    const stored = ((await db.meta.get(key(address)))?.value as SharedState | undefined) ?? null;
    if (stored && stored.localLibraryId !== localLibraryId) throw new AppError('REVISION_CONFLICT', '此同步连接属于旧主库，请先解除本机同步记录再重新合并。');
    const bookmarks = (await db.bookmarks.toArray()).sort((a, b) => a.id.localeCompare(b.id)), categories = (await db.categories.toArray()).sort((a, b) => a.id.localeCompare(b.id)), tags = (await db.tags.toArray()).sort((a, b) => a.id.localeCompare(b.id)), tombstones = await db.tombstones.toArray(), readingItems=(await db.readingItems.toArray()).sort((a,b)=>a.id.localeCompare(b.id));
    return { localLibraryId, bookmarks, readingItems, categories, tags, tombstones, state: stored,
      fingerprint: JSON.stringify([localLibraryId, bookmarks, categories, tags, tombstones, readingItems, stored?.stamp ?? null]) };
  }
  return {
    async read(address: string) { return db.transaction('r', tables, () => read(address)); },
    async assert(plan: SharedPlan, keys?: string[]) { await db.transaction('r', tables, async () => {
      if (!keys) { if ((await read(plan.address)).fingerprint !== plan.local.fingerprint) throw new AppError('REVISION_CONFLICT', '本机内容已变化，请重新检查同步。'); return; }
      const libraryId = ((await db.settings.get('app'))?.value as { libraryId?: string } | undefined)?.libraryId;
      const stamp = ((await db.meta.get(key(plan.address)))?.value as SharedState | undefined)?.stamp ?? null;
      if (libraryId !== plan.local.localLibraryId || stamp !== (plan.local.state?.stamp ?? null)) throw new AppError('REVISION_CONFLICT', '主库或同步基线变化，请重新检查。');
      const oldBooks = new Map(plan.local.bookmarks.map((row) => [row.id, row])), oldCategories = new Map(plan.local.categories.map((row) => [row.id, row])), oldTags = new Map(plan.local.tags.map((row) => [row.id, row]));
      for (const id of keys) { const localId = plan.maps[id]; if (!localId) continue;
        const table = id.startsWith('r:') ? db.readingItems : id.startsWith('b:') ? db.bookmarks : id.startsWith('c:') ? db.categories : db.tags;
        const previous = id.startsWith('r:') ? plan.local.readingItems.find(row=>row.id===localId) : id.startsWith('b:') ? oldBooks.get(localId) : id.startsWith('c:') ? oldCategories.get(localId) : oldTags.get(localId);
        if(id.startsWith('r:')) {const reading=plan.local.readingItems.find(row=>row.id===localId);if(reading?.relatedBookmarkId && !sameData(await db.bookmarks.get(reading.relatedBookmarkId),oldBooks.get(reading.relatedBookmarkId)))throw new AppError('REVISION_CONFLICT','待看关联收藏的隐私或内容变化，请重新检查。');}
        if (!sameData(await table.get(localId), previous)) throw new AppError('REVISION_CONFLICT', '待发送记录已修改或转为本地专用，请重新检查。');
      }
    }); },
    async apply(plan: SharedPlan, remote: SharedRow[], revision: number) {
      await db.transaction('rw', tables, async () => {
        const local = await read(plan.address); if (local.fingerprint !== plan.local.fingerprint) throw new AppError('REVISION_CONFLICT', '同步期间本机被修改，云端结果已保留，请重新检查；没有覆盖本机。');
        if (local.state && !sameIdentity(local.state.identity, plan.info)) throw new AppError('REVISION_CONFLICT', '云端身份变化。');
        const maps = { ...plan.maps }, now = nowIso(), excluded = new Set(plan.excluded), active = remote.filter((row) => row.data && !excluded.has(row.key));
        for (const row of active) maps[row.key] ??= newId();
        for (const row of active) {
          const data = row.data!, id = maps[row.key]!;
          if (data.kind === 'category') {
            const old = await db.categories.get(id), parentId = data.parent ? maps[data.parent] ?? null : null;
            if (!old || !sameData([old.name, old.description, old.parentId ?? null, old.sortOrder ?? 0], [data.name, data.description, parentId, data.order])) {
              const next: Category = { ...old, id, name: data.name, description: data.description, parentId, sortOrder: data.order, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now }; await db.categories.put(next);
            }
          } else if (data.kind === 'tag') {
            const old = await db.tags.get(id); if (!old || old.name !== data.name) { const next: Tag = { id, name: data.name, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now }; await db.tags.put(next); }
          }
        }
        for (const row of active) if (row.data?.kind === 'bookmark') {
          const data = row.data, id = maps[row.key]!, old = await db.bookmarks.get(id);
          if (old?.privacy.localOnly) continue;
          const checked = canonicalizeUrl(data.url), categoryId = data.category ? maps[data.category] ?? null : null, tagIds = data.tags.map((tag) => maps[tag]).filter((tag): tag is string => Boolean(tag));
          const values = { originalUrl: checked.originalUrl, canonicalUrl: checked.canonicalUrl, title: data.title, sourceDescription: data.sourceDescription, note: data.note, selectedText: data.selectedText, aiPurpose: data.aiPurpose, categoryId, categoryKey: categoryId ?? 'uncategorized', tagIds, pinned: data.pinned, inboxUnread: data.unread, unreadFlag: data.unread ? 1 as const : 0 as const, privacy: { localOnly: false, aiBlocked: data.aiBlocked }, lockedFields: data.lockedFields, sortOrder: data.order, deletedAt: null, lifeState: 'active' as const };
          const previous = old ? Object.fromEntries(Object.keys(values).map((field) => [field, old[field as keyof Bookmark]])) : null;
          if (!old || !sameData(previous, values)) {
            const high = (await db.meta.get(`revfloor:bookmark:${id}`))?.value; const version = Math.max(old?.localRevision ?? 0, typeof high === 'number' ? high : 0) + 1;
            const next: Bookmark = { ...old, ...values, id, revision: Math.max(old?.revision ?? 0, version - 1) + 1, localRevision: version, changeVersion: row.version, lastOpenedAt: old?.lastOpenedAt ?? null, sources: old?.sources ?? [{ sourceType: 'manual', capturedAt: now }], createdAt: old?.createdAt ?? now, updatedAt: now };
            delete next.acceptedAnalysis; await db.bookmarks.put(next); await db.meta.put({ key: `revfloor:bookmark:${id}`, value: version }); await db.tombstones.delete(['bookmark', id]);
          }
        }
        for(const row of active)if(row.data?.kind==='reading') {
          const data=row.data,id=maps[row.key]!,old=await db.readingItems.get(id),checked=canonicalizeUrl(data.url);
          const relatedBookmarkId=data.related ? maps[data.related] ?? null : null;
          const values={originalUrl:checked.originalUrl,canonicalUrl:checked.canonicalUrl,title:data.title,note:data.note,status:data.status,addedAt:data.addedAt,completedAt:data.completedAt,relatedBookmarkId};
          const previous=old ? Object.fromEntries(Object.keys(values).map(field=>[field,old[field as keyof ReadingItem]])) : null;
          if(!old || !sameData(previous,values)) {
            const floor=(await db.meta.get(`revfloor:reading:${id}`))?.value,version=Math.max(old?.localRevision ?? 0,typeof floor==='number'?floor:0)+1;
            await db.readingItems.put({...old,...values,id,revision:Math.max(old?.revision ?? 0,version-1)+1,localRevision:version,changeVersion:row.version,sources:old?.sources ?? [{sourceType:'manual',capturedAt:now}]});
            await db.meta.put({key:`revfloor:reading:${id}`,value:version});
          }
        }
        const removedReading:ReadingItem[]=[];
        for(const row of remote)if(!row.data && row.key.startsWith('r:') && !excluded.has(row.key)) {
          const id=maps[row.key];if(!id)continue;const old=await db.readingItems.get(id);const related=old?.relatedBookmarkId ? await db.bookmarks.get(old.relatedBookmarkId) : undefined;if(old && !related?.privacy.localOnly && !related?.deletedAt)removedReading.push(old);
        }
        if(removedReading.length) {await writePurgeSnapshot(db,{entry:'selection',scopeLabel:'同步移除的待看',readingItems:removedReading});await db.readingItems.bulkDelete(removedReading.map(row=>row.id));}
        const categoryIndex = new Map(local.categories.map((row) => [row.id, row]));
        const liveMappings = new Set(active.map((row) => `${row.key[0]}:${maps[row.key]}`));
        const depth = (id: string, seen = new Set<string>()): number => { const row = categoryIndex.get(id); if (!row?.parentId || seen.has(id)) return 0; seen.add(id); return 1 + depth(row.parentId, seen); };
        const priority = (row: SharedRow) => row.key.startsWith('b:') ? 0 : row.key.startsWith('c:') ? 100 - depth(maps[row.key] ?? '') : 200;
        for (const row of [...remote].sort((a, b) => priority(a) - priority(b))) if (!row.data && !excluded.has(row.key)) {
          const id = maps[row.key]; if (!id) continue;
          if (liveMappings.has(`${row.key[0]}:${id}`)) continue;
          if(row.key.startsWith('r:')) continue;
          if (row.key.startsWith('b:')) {
            const old = await db.bookmarks.get(id); if (!old || old.deletedAt || old.privacy.localOnly) continue;
            const revision = old.localRevision + 1; await db.bookmarks.put({ ...old, deletedAt: now, lifeState: 'deleted', revision: old.revision + 1, localRevision: revision, changeVersion: row.version, updatedAt: now });
            await db.tombstones.put({ entityType: 'bookmark', id, revision, changeVersion: row.version, deletedAt: now, privacyScope: 'main', canonicalUrl: old.canonicalUrl, title: old.title });
          } else if (row.key.startsWith('c:')) {
            // Local-only records may still reference this folder: keep their local folder.
            if (!await db.bookmarks.where('categoryKey').equals(id).filter((book) => !book.deletedAt).count() && !await db.categories.where('parentId').equals(id).count()) await db.categories.delete(id);
          } else if (!await db.bookmarks.where('tagIds').equals(id).filter((book) => !book.deletedAt).count()) await db.tags.delete(id);
        }
        const publicIds={...local.state?.publicIds};for(const row of remote)if(row.data?.kind==='reading')publicIds[row.key]=row.data.publicId;
        const state: SharedState = { publicIds, localLibraryId: local.localLibraryId, identity: { serverId: plan.info.serverId, libraryId: plan.info.libraryId, epoch: plan.info.epoch }, revision, baseline: remote, maps, excluded: plan.excluded, stamp: newId(), deviceId: plan.deviceId };
        await db.meta.put({ key: key(plan.address), value: state });
      });
    },
    async disconnect(address: string) { await db.meta.delete(key(address)); },
  };
}
