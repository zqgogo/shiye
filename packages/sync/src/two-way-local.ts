import type { Bookmark, Category, Tag, Tombstone, ReadingItem } from '@shiye/core';
import { canonicalizeUrl, newId } from '@shiye/core';
import { digest } from './protocol.js';
import { mirrorBase } from './client.js';
import { SharedDataSchema, mergeShared, type SharedData, type SharedRow, type SharedInfo } from './two-way.js';
export interface SharedState { publicIds?:Record<string,string>; localLibraryId: string; identity: { serverId: string; libraryId: string; epoch: string }; revision: number; baseline: SharedRow[]; maps: Record<string, string>; excluded: string[]; stamp: string; deviceId: string; }
export interface SharedLocal { localLibraryId: string; bookmarks: Bookmark[]; readingItems:ReadingItem[]; categories: Category[]; tags: Tag[]; tombstones: Tombstone[]; state: SharedState | null; fingerprint: string; }
export interface SharedPlan { deviceId: string; address: string; local: SharedLocal; remote: SharedRow[]; info: SharedInfo; maps: Record<string, string>; excluded: string[]; projection: [string, SharedData | null][]; choices: Record<string, 'local' | 'remote'>; }
export async function prepareSharedPlan(address: string, local: SharedLocal, remote: SharedRow[], info: SharedInfo): Promise<SharedPlan> {
  address = mirrorBase(address).href;
  const previous = local.state, maps = { ...previous?.maps }, cloud = new Map(remote.map((row) => [row.key, row])), base = new Map(previous?.baseline.map((row) => [row.key, row]) ?? []);
  const localCategories = new Map(local.categories.map((row) => [row.id, row]));
  function localPath(id: string, seen = new Set<string>()): string { const row = localCategories.get(id); if (!row || seen.has(id)) return ''; seen.add(id); return `${row.parentId ? localPath(row.parentId, seen) + '\u0000' : ''}${row.name}`; }
  function remotePath(id: string, seen = new Set<string>()): string { const row = cloud.get(id)?.data; if (!row || row.kind !== 'category' || seen.has(id)) return ''; seen.add(id); return `${row.parent ? remotePath(row.parent, seen) + '\u0000' : ''}${row.name}`; }
  const pathIndex = new Map(local.categories.map((row) => [localPath(row.id), row.id]));
  for (const row of remote) if (row.data?.kind === 'category' && !maps[row.key]) maps[row.key] = pathIndex.get(remotePath(row.key)) ?? newId();
  const reverse = new Map(Object.entries(maps).map(([global, id]) => [id, global]));
  const categoriesNeeded = new Set<string>(), tagsNeeded = new Set<string>();
  for (const row of local.bookmarks) if (!row.deletedAt && !row.privacy.localOnly) {
    let parent = row.categoryId; const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); categoriesNeeded.add(parent); parent = localCategories.get(parent)?.parentId ?? null; } row.tagIds.forEach((id) => tagsNeeded.add(id));
  }
  const privateCategories = new Set<string>(), privateTags = new Set<string>();
  for (const row of local.bookmarks) if (!row.deletedAt && row.privacy.localOnly) { let parent = row.categoryId; const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); privateCategories.add(parent); parent = localCategories.get(parent)?.parentId ?? null; } row.tagIds.forEach((id) => privateTags.add(id)); }
  const privateBranch = (id: string): boolean => { let parent: string | null | undefined = id; const seen = new Set<string>(); while (parent && !seen.has(parent)) { seen.add(parent); if (privateCategories.has(parent) && !categoriesNeeded.has(parent)) return true; parent = localCategories.get(parent)?.parentId; } return false; };
  for (const row of local.categories) if (!privateBranch(row.id) || categoriesNeeded.has(row.id) || reverse.has(row.id)) maps[reverse.get(row.id) ?? `c:${row.id}`] = row.id;
  for (const row of local.tags) {
    const id = `t:${await digest(row.name.normalize('NFC'))}`;
    if (!privateTags.has(row.id) || tagsNeeded.has(row.id) || maps[id]) maps[id] = row.id;
  }
  const categoryKeys = new Map(Object.entries(maps).filter(([key]) => key.startsWith('c:')).map(([key, id]) => [id, key]));
  const tagKeys = new Map(Object.entries(maps).filter(([key]) => key.startsWith('t:')).map(([key, id]) => [id, key]));
  const categoryKey = (id: string | null | undefined) => id ? categoryKeys.get(id) ?? null : null;
  const tagKey = (id: string) => tagKeys.get(id);
  const projection = new Map<string, SharedData | null>(), excluded = new Set<string>();
  for (const row of local.categories) { const key = categoryKey(row.id); if (key && (categoriesNeeded.has(row.id) || !base.has(key) || base.get(key)?.data)) projection.set(key, SharedDataSchema.parse({ kind: 'category', name: row.name, description: row.description, parent: categoryKey(row.parentId), order: row.sortOrder ?? 0 })); }
  for (const row of local.tags) { const key = tagKey(row.id); if (key && (tagsNeeded.has(row.id) || !base.has(key) || base.get(key)?.data)) projection.set(key, SharedDataSchema.parse({ kind: 'tag', name: row.name.normalize('NFC') })); }
  for (const row of local.bookmarks) {
    const key = `b:${await digest(row.canonicalUrl)}`;
    if (row.privacy.localOnly) {
      if (previous?.excluded.includes(key) || !base.get(key)?.data) { excluded.add(key); continue; }
      maps[key] = row.id; projection.set(key, null); continue;
    }
    maps[key] = row.id;
    if (row.deletedAt) { projection.set(key, null); continue; }
    const known = cloud.get(key)?.data ?? base.get(key)?.data;
    projection.set(key, SharedDataSchema.parse({ kind: 'bookmark', publicId: known?.kind === 'bookmark' ? known.publicId : row.id,
      url: canonicalizeUrl(row.originalUrl).originalUrl, title: row.title, sourceDescription: row.sourceDescription, note: row.note, selectedText: row.selectedText, aiPurpose: row.aiPurpose,
      category: categoryKey(row.categoryId), tags: row.tagIds.map(tagKey).filter((id): id is string => Boolean(id)).sort(), pinned: row.pinned, unread: row.inboxUnread, aiBlocked: row.privacy.aiBlocked, lockedFields: [...row.lockedFields].sort(), order: row.sortOrder ?? 0 }));
  }
  // Reading identity follows canonical URL independently of bookmark identity.
  const hiddenBookmarks=new Set<string>();
  for(const row of local.bookmarks)if(row.privacy.localOnly || row.deletedAt)hiddenBookmarks.add(`b:${await digest(row.canonicalUrl)}`);
  const localBooks=new Map(local.bookmarks.map(row=>[row.id,row]));
  const localReading=new Map(local.readingItems.map(row=>[row.canonicalUrl,row]));
  for(const row of remote)if(row.data?.kind==='reading') {
    const existing=localReading.get(canonicalizeUrl(row.data.url).canonicalUrl);if(existing)maps[row.key]=existing.id;
    if(row.data.related && hiddenBookmarks.has(row.data.related)) { if(base.get(row.key)?.data && !previous?.excluded.includes(row.key)) projection.set(row.key,null);else excluded.add(row.key); }
  }
  for(const row of local.readingItems) {
    const key=`r:${await digest(row.canonicalUrl)}`, book=row.relatedBookmarkId ? localBooks.get(row.relatedBookmarkId) : undefined;
    const related=book ? `b:${await digest(book.canonicalUrl)}` : null;
    if((related && hiddenBookmarks.has(related)) || excluded.has(key)) {
      if(previous?.excluded.includes(key) || !base.get(key)?.data) {excluded.add(key);continue;}
      maps[key]=row.id;projection.set(key,null);continue;
    }
    maps[key]=row.id;const known=cloud.get(key)?.data ?? base.get(key)?.data;
    projection.set(key,SharedDataSchema.parse({kind:'reading',publicId:known?.kind==='reading'?known.publicId:previous?.publicIds?.[key] ?? row.id,url:canonicalizeUrl(row.originalUrl).originalUrl,title:row.title,note:row.note,status:row.status,addedAt:row.addedAt,completedAt:row.completedAt,related}));
  }
  for (const row of local.tombstones) if (row.entityType === 'bookmark' && row.canonicalUrl && row.privacyScope !== 'local') {
    const key = `b:${await digest(row.canonicalUrl)}`; if (!projection.has(key) && !excluded.has(key)) projection.set(key, null);
  }
  for (const row of previous?.baseline ?? []) if (row.data && !projection.has(row.key) && !excluded.has(row.key)) projection.set(row.key, null);
  for (const row of remote) if (row.data && !maps[row.key]) maps[row.key] = newId();
  return { deviceId: previous?.deviceId ?? newId(), address, local, remote: remote.filter((row) => !excluded.has(row.key)), info, maps, excluded: [...excluded], projection: [...projection], choices: {} };
}
export const resolveShared = (plan: SharedPlan) => mergeShared(plan.local.state?.baseline.filter((row) => !plan.excluded.includes(row.key)) ?? [], new Map(plan.projection), plan.remote, plan.choices);
export function orderedChanges(plan: SharedPlan) {
  const result = resolveShared(plan), merged = result.merged;
  const depth = (key: string, seen = new Set<string>()): number => { if (seen.has(key)) return 0; seen.add(key); const data = merged.get(key) ?? plan.remote.find((row) => row.key === key)?.data; return data?.kind === 'category' && data.parent ? 1 + depth(data.parent, seen) : 0; };
  const priority = (key: string, data: SharedData | null) => data?.kind === 'tag' ? 0 : data?.kind === 'category' ? 100 + depth(key) : data ? 1000 : key.startsWith('b:') ? 2000 : key.startsWith('c:') ? 3000 - depth(key) : 4000;
  return result.pushes.sort((a, b) => priority(a.key, a.data) - priority(b.key, b.data) || a.key.localeCompare(b.key));
}
