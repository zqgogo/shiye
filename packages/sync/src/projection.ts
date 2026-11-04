import type { BackupDocument, Bookmark } from '@shiye/core';
import { MirrorRecordSchema, validateMirror, type MirrorRecord } from './protocol.js';

export function projectSharedBookmark(row: Bookmark): MirrorRecord | null {
  if (row.privacy.localOnly || row.deletedAt) return null;
  return MirrorRecordSchema.parse({ kind: 'bookmark', id: row.id, title: row.title, url: row.originalUrl,
    categoryId: row.categoryId, tagIds: row.tagIds, pinned: row.pinned, unread: row.inboxUnread });
}

/** A mirror is deliberately smaller than a backup; never spread source objects here. */
export function projectMirror(document: BackupDocument): MirrorRecord[] {
  const records: MirrorRecord[] = [];
  const neededCategories = new Set<string>(); const neededTags = new Set<string>();
  const categories = new Map(document.categories.map((row) => [row.id, row]));
  const hidden = new Set(document.bookmarks.filter((row) => row.privacy.localOnly || row.deletedAt).map((row) => row.id));
  for (const row of document.bookmarks) {
    const shared = projectSharedBookmark(row); if (!shared) continue;
    let parent = row.categoryId;
    while (parent && !neededCategories.has(parent)) { neededCategories.add(parent); parent = categories.get(parent)?.parentId ?? null; }
    row.tagIds.forEach((id) => neededTags.add(id));
    records.push(shared);
  }
  for (const row of document.readingItems) {
    if (row.status !== 'pending' || (row.relatedBookmarkId && hidden.has(row.relatedBookmarkId))) continue;
    records.push(MirrorRecordSchema.parse({ kind: 'reading', id: row.id, title: row.title, url: row.originalUrl }));
  }
  for (const row of document.categories) if (neededCategories.has(row.id)) records.push(MirrorRecordSchema.parse({ kind: 'category', id: row.id, name: row.name, parentId: row.parentId ?? null }));
  for (const row of document.tags) if (neededTags.has(row.id)) records.push(MirrorRecordSchema.parse({ kind: 'tag', id: row.id, name: row.name }));
  records.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  validateMirror(records);
  return records;
}
