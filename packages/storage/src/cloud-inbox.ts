import { AppError, canonicalizeUrl } from '@shiye/core';
import type { BookmarkRepository, ReadingRepository } from '@shiye/application';
import { InboxEntrySchema, InboxPayloadSchema, InboxReceiveEditsSchema, type InboxReceiveEdits, type InboxReceipt } from '../../sync/src/inbox.js';
import { digest } from '../../sync/src/protocol.js';
import type { ShiyeDB } from './db.js';
export function createCloudInbox(db: ShiyeDB, bookmarks: BookmarkRepository, reading: ReadingRepository) {
  return { async receive(raw: unknown, expectedLibraryId: string, edits?: InboxReceiveEdits): Promise<InboxReceipt> {
    const entry = InboxEntrySchema.parse(raw), hash = await digest(JSON.stringify(entry));
    const checked = canonicalizeUrl(entry.payload.url);
    return db.transaction('rw', [db.settings, db.meta, db.bookmarks, db.readingItems, db.categories, db.tags, db.tombstones], async () => {
      const libraryId = ((await db.settings.get('app'))?.value as { libraryId?: string } | undefined)?.libraryId;
      if (libraryId !== expectedLibraryId) throw new AppError('REVISION_CONFLICT', '本机主库已变化，请重新检查云端收件箱。');
      const key = `cloud-inbox:${JSON.stringify([libraryId, entry.identity.serverId, entry.identity.libraryId, entry.identity.epoch, entry.id])}`;
      const previous = (await db.meta.get(key))?.value as { hash: string; receipt: InboxReceipt } | undefined;
      if (previous) { if (previous.hash !== hash) throw new AppError('REVISION_CONFLICT', '提交编号对应的内容变化，未重复接收。'); return previous.receipt; }
      const changes = InboxReceiveEditsSchema.parse(edits ?? {});
      const p = InboxPayloadSchema.parse({ ...entry.payload, ...changes }); let receipt: InboxReceipt;
      const sync = (await db.meta.where('key').startsWith('cloud-sync:').toArray()).map((row) => row.value as import('../../sync/src/two-way-local.js').SharedState).find((value) => value.localLibraryId === libraryId && value.identity.serverId === entry.identity.serverId && value.identity.libraryId === entry.identity.libraryId && value.identity.epoch === entry.identity.epoch);
      if (p.destination === 'bookmark') {
        const existing = await bookmarks.findAnyByCanonical(checked.canonicalUrl);
        if (existing?.deletedAt) throw new AppError('TOMBSTONED', '此网址在回收站中，请先明确恢复，或退回这份提交。');
        if (existing) { const shared = sync?.baseline.find((row) => sync.maps[row.key] === existing.id && row.data?.kind === 'bookmark')?.data;
          receipt = { status: 'received', recordKind: 'bookmark', recordId: shared?.kind === 'bookmark' ? shared.publicId : existing.id, message: '已有相同网址，保留总机原内容，未覆盖分类、备注或隐私。' }; }
        else {
          const category = p.categoryId ? await db.categories.get(changes.categoryId !== undefined ? p.categoryId : sync?.maps[p.categoryId] ?? p.categoryId) : undefined;
          const tagIds = []; for (const id of p.tagIds) { const localId = changes.tagIds !== undefined ? id : sync?.maps[id] ?? id; if (await db.tags.get(localId)) tagIds.push(localId); }
          if (changes.categoryId && !category) throw new AppError('REVISION_CONFLICT', '所选分类已被删除，请重新选择后接收。');
          if (changes.tagIds && tagIds.length !== p.tagIds.length) throw new AppError('REVISION_CONFLICT', '所选标签已变化，请重新选择后接收。');
          const bookmark = await bookmarks.create({ originalUrl: p.url, title: p.title, sourceDescription: p.sourceDescription, note: p.note,
            categoryId: category?.id ?? null, tagIds, pinned: p.pinned, inboxUnread: p.unread, privacy: { localOnly: false, aiBlocked: p.aiBlocked }, sourceType: 'manual', sourceFolder: p.categoryPath });
          receipt = { status: 'received', recordKind: 'bookmark', recordId: bookmark.id, message: (p.categoryId && !category) || tagIds.length !== p.tagIds.length ? '已接收；失效分类移至未分类，失效标签已跳过。' : '已按所选分类接收。' };
        }
      } else {
        const existing = await reading.findByCanonical(checked.canonicalUrl);
        if (existing?.status === 'pending') receipt = { status: 'received', recordKind: 'reading', recordId: existing.id, message: '已在待看，保留总机原内容。' };
        else {
          const item = (await reading.add({ originalUrl: p.url, title: p.title, note: p.note, sourceType: 'manual' })).item;
          receipt = { status: 'received', recordKind: 'reading', recordId: item.id, message: existing ? '已重新加入待看，保留原有笔记。' : '已加入待看。' };
        }
      }
      await db.meta.put({ key, value: { hash, receipt } }); return receipt;
    });
  } };
}
