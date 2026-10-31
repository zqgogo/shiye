import {
  AppError,
  LIMITS,
  newId,
  nowIso,
  type Bookmark,
  type PurgeEntry,
  type PurgeRestoreDecision,
  type PurgeRestorePreview,
  type PurgeSnapshot,
  type ReadingItem,
  type Tombstone,
} from '@shiye/core';
import { deriveIndexFields, type ShiyeDB } from './db.js';

/**
 * 测试与故障演练用的注入点。
 *
 * 这两个钩子在调用方的事务内触发：抛错即让整条事务回滚，
 * 用来证明「快照写不进去就不删」「删除中途失败整体回滚」。
 */
export interface PurgeHooks {
  beforeSnapshotWrite?: () => void | Promise<void>;
  beforeDelete?: () => void | Promise<void>;
}

export interface PurgeSnapshotPayload {
  entry: PurgeEntry;
  scopeLabel: string;
  bookmarks?: Bookmark[];
  readingItems?: ReadingItem[];
  tombstones?: Tombstone[];
}

function bytesOf(value: unknown): number {
  const json = JSON.stringify(value);
  try {
    return new TextEncoder().encode(json).length;
  } catch {
    return json.length;
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function libraryFingerprint(db: ShiyeDB): Promise<string> {
  const row = await db.settings.get('app');
  const value = row?.value as { libraryId?: unknown } | undefined;
  return typeof value?.libraryId === 'string' && value.libraryId ? value.libraryId : 'unknown-library';
}

/**
 * 在调用方已打开的 `rw` 事务内写一份清理快照，并按「保留最近 N 份」先淘汰最旧。
 *
 * 顺序很重要：淘汰 → 校验容量 → 写快照。三步都在同一事务里，
 * 任何一步抛错都会连同调用方的删除一起回滚，所以不会出现「快照没了、数据也删了」。
 */
export async function writePurgeSnapshot(
  db: ShiyeDB,
  payload: PurgeSnapshotPayload,
  hooks?: PurgeHooks
): Promise<string> {
  const bookmarks = payload.bookmarks ?? [];
  const readingItems = payload.readingItems ?? [];
  const tombstones = payload.tombstones ?? [];
  const total = bookmarks.length + readingItems.length + tombstones.length;
  if (total === 0) {
    throw new AppError('INVALID_INPUT', '没有可清理的条目，未执行清理。');
  }

  // 同一毫秒内连续清理时，光靠 nowIso() 会拿到相同时间戳，写进列表后顺序不稳定。
  // 这里保证严格递增：新快照永远排在已有快照之后，「淘汰最旧」才可靠。
  const existing = await db.purgeSnapshots.orderBy('createdAt').toArray();
  const previous = existing.at(-1)?.createdAt;
  const now = nowIso();
  const createdAt =
    previous && previous >= now ? new Date(new Date(previous).getTime() + 1).toISOString() : now;

  const snapshot: PurgeSnapshot = {
    id: newId(),
    createdAt,
    entry: payload.entry,
    scopeLabel: payload.scopeLabel,
    dbFingerprint: await libraryFingerprint(db),
    bookmarks,
    readingItems,
    tombstones,
    counts: {
      bookmarks: bookmarks.length,
      readingItems: readingItems.length,
      tombstones: tombstones.length,
    },
    bytes: bytesOf({ bookmarks, readingItems, tombstones }),
    restoredAt: null,
    restoredCounts: null,
  };

  if (total > LIMITS.purgeSnapshotMaxItems || snapshot.bytes > LIMITS.purgeSnapshotMaxBytes) {
    throw new AppError(
      'SNAPSHOT_TOO_LARGE',
      `这次要清理 ${total} 条（约 ${mb(snapshot.bytes)}），超过单份清理快照上限（${LIMITS.purgeSnapshotMaxItems} 条 / 5 MB）。请先到「数据与备份」导出完整 JSON，再分批清理。`,
      { total, bytes: snapshot.bytes }
    );
  }

  const keepAfterWrite = LIMITS.purgeSnapshotsKept - 1;
  const overflow = existing.length - keepAfterWrite;
  const survivors = overflow > 0 ? existing.slice(overflow) : existing;
  if (overflow > 0) {
    await db.purgeSnapshots.bulkDelete(existing.slice(0, overflow).map((row) => row.id));
  }

  const usedBytes = survivors.reduce((sum, row) => sum + (row.bytes || 0), 0);
  if (usedBytes + snapshot.bytes > LIMITS.purgeSnapshotsTotalBytes) {
    throw new AppError(
      'SNAPSHOT_STORAGE_FULL',
      `清理快照已占用 ${mb(usedBytes)}，加上这一份会超过 ${mb(LIMITS.purgeSnapshotsTotalBytes)} 上限。请先在「数据与备份 → 最近清理」里删掉旧快照，或导出备份后再清理。`,
      { usedBytes, incoming: snapshot.bytes }
    );
  }

  await hooks?.beforeSnapshotWrite?.();
  await db.purgeSnapshots.put(snapshot);
  return snapshot.id;
}

/** 删除阶段前触发钩子；抛错会让调用方的事务回滚。 */
export async function triggerDeleteHook(hooks?: PurgeHooks): Promise<void> {
  await hooks?.beforeDelete?.();
}

function skip(id: string, title: string, reason: string): PurgeRestoreDecision {
  return { id, title, action: 'skip', reason };
}

async function decideBookmark(db: ShiyeDB, row: Bookmark): Promise<PurgeRestoreDecision> {
  const byId = await db.bookmarks.get(row.id);
  if (byId?.deletedAt) {
    return skip(row.id, row.title, '这条仍在回收站里，需要请到回收站恢复');
  }
  if (byId) {
    return skip(row.id, row.title, '库里已经有这条');
  }
  const byUrl = await db.bookmarks.where('canonicalUrl').equals(row.canonicalUrl).first();
  if (byUrl) {
    return {
      id: row.id,
      title: row.title,
      action: 'conflict',
      reason: '同网址已在库里（可能是清理后重新导入的），不覆盖',
    };
  }
  if (row.categoryId) {
    const category = await db.categories.get(row.categoryId);
    if (!category) {
      return {
        id: row.id,
        title: row.title,
        action: 'restore',
        reason: '原分类已删除，恢复到未分类',
      };
    }
  }
  return {
    id: row.id,
    title: row.title,
    action: 'restore',
    reason: row.deletedAt ? '恢复到回收站' : '恢复到原分类',
  };
}

async function decideReading(db: ShiyeDB, row: ReadingItem): Promise<PurgeRestoreDecision> {
  const existing = await db.readingItems.get(row.id);
  if (existing) {
    return skip(row.id, row.title, existing.status === 'completed' ? '已完成的待看记录还在' : '待看队列里已经有这条');
  }
  return { id: row.id, title: row.title, action: 'restore', reason: '恢复到待看' };
}

async function planRestore(db: ShiyeDB, snapshot: PurgeSnapshot): Promise<PurgeRestoreDecision[]> {
  const decisions: PurgeRestoreDecision[] = [];
  for (const row of snapshot.bookmarks) decisions.push(await decideBookmark(db, row));
  for (const row of snapshot.readingItems) decisions.push(await decideReading(db, row));
  return decisions;
}

function summarize(
  snapshot: PurgeSnapshot,
  decisions: PurgeRestoreDecision[]
): PurgeRestorePreview {
  const restorable = decisions.filter((row) => row.action === 'restore').length;
  const conflicted = decisions.filter((row) => row.action === 'conflict').length;
  return {
    snapshotId: snapshot.id,
    entry: snapshot.entry,
    scopeLabel: snapshot.scopeLabel,
    createdAt: snapshot.createdAt,
    candidates: decisions.length,
    restorable,
    skipped: decisions.length - restorable - conflicted,
    conflicted,
    decisions,
  };
}

/** 预览：只读，不落任何数据。 */
export async function previewPurgeRestore(db: ShiyeDB, snapshotId: string): Promise<PurgeRestorePreview> {
  const snapshot = await db.purgeSnapshots.get(snapshotId);
  if (!snapshot) throw new AppError('NOT_FOUND', '这条清理快照已经不在了。');
  return summarize(snapshot, await planRestore(db, snapshot));
}

/**
 * 只把这一份快照删掉的条目加回来。
 *
 * 与整库替换恢复相反：不清表、不覆盖、不触碰快照之外的记录；
 * 计划在事务内重算一遍，预览之后被改动过的条目按最新状态重新判定。
 */
export async function restorePurgeSnapshot(
  db: ShiyeDB,
  snapshotId: string
): Promise<{ preview: PurgeRestorePreview; restored: number }> {
  return db.transaction(
    'rw',
    [db.bookmarks, db.readingItems, db.tombstones, db.categories, db.purgeSnapshots],
    async () => {
      const snapshot = await db.purgeSnapshots.get(snapshotId);
      if (!snapshot) throw new AppError('NOT_FOUND', '这条清理快照已经不在了。');

      const decisions = await planRestore(db, snapshot);
      const preview = summarize(snapshot, decisions);
      const bookmarkById = new Map(snapshot.bookmarks.map((row) => [row.id, row]));
      const readingById = new Map(snapshot.readingItems.map((row) => [row.id, row]));
      const now = nowIso();

      const restoredIds: string[] = [];
      let restored = 0;

      for (const decision of decisions) {
        if (decision.action !== 'restore') continue;
        const bookmark = bookmarkById.get(decision.id);
        if (bookmark) {
          const categoryId =
            bookmark.categoryId && (await db.categories.get(bookmark.categoryId)) ? bookmark.categoryId : null;
          const next: Bookmark = {
            ...bookmark,
            categoryId,
            // 原本在回收站的就回回收站，不复活的条目不会突然出现在收藏列表里。
            deletedAt: bookmark.deletedAt ?? null,
            revision: 1,
            localRevision: 1,
            updatedAt: now,
          };
          Object.assign(next, deriveIndexFields(next));
          await db.bookmarks.put(next);
          restoredIds.push(next.id);
          restored += 1;
          continue;
        }
        const reading = readingById.get(decision.id);
        if (reading) {
          await db.readingItems.put({ ...reading });
          restored += 1;
        }
      }

      // 恢复的条目要能再次导入：清掉同 ID 或同网址的删除标记。
      if (restoredIds.length > 0) {
        const restoredRows = snapshot.bookmarks.filter((row) => restoredIds.includes(row.id));
        const urls = new Set(restoredRows.map((row) => row.canonicalUrl));
        const tombstones = await db.tombstones.toArray();
        const stale = tombstones.filter(
          (row) =>
            row.entityType === 'bookmark' &&
            (restoredIds.includes(row.id) || (row.canonicalUrl ? urls.has(row.canonicalUrl) : false))
        );
        await db.tombstones.bulkDelete(
          stale.map((row) => [String(row.entityType), String(row.id)] as [string, string])
        );
      }

      await db.purgeSnapshots.put({
        ...snapshot,
        restoredAt: now,
        restoredCounts: {
          restored,
          skipped: preview.skipped,
          conflicted: preview.conflicted,
        },
      });

      return { preview, restored };
    }
  );
}

export async function listPurgeSnapshots(db: ShiyeDB): Promise<PurgeSnapshot[]> {
  const rows = await db.purgeSnapshots.orderBy('createdAt').toArray();
  return rows.reverse();
}

export async function deletePurgeSnapshot(db: ShiyeDB, snapshotId: string): Promise<void> {
  await db.purgeSnapshots.delete(snapshotId);
}
