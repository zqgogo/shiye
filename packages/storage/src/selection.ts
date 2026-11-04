/**
 * 列表批量操作（P9.10）。
 *
 * 与「按条件清理」同一条保护边界：勾选只是选定了几条，真正执行前必须核对
 * 用户确认那一刻的版本与状态。只传 id 的做法有两个洞——另一页把回收站里的
 * 条目恢复了、把待看标成完成、或者给某条加了备注，这边仍会照删不误，等于
 * 把用户刚做出的决定抹掉。
 *
 * 所以这里分两步：
 *   1. `prepareBulkSelection()` 读当前库，把符合条件的条目连同版本 / 状态
 *      一起冻进令牌，同时报出「现在就已经不符合」的条目与原因；
 *   2. `runBulkSelection()` 在同一个读写事务里重新读一遍，版本或状态变过的
 *      逐条跳过并说明原因，不自动补最新版本绕过用户重新确认。
 *
 * 硬删除（彻底删除 / 移出待看）仍然先写清理快照，写不进去一条都不删。
 */

import {
  nowIso,
  type BulkAction,
  type BulkEntryState,
  type BulkPreview,
  type BulkResult,
  type BulkTarget,
  type BulkToken,
  type Bookmark,
  type ReadingItem,
  type Tombstone,
} from '@shiye/core';
import { type ShiyeDB } from './db.js';
import { deriveIndexFields } from './db.js';
import { softDeleteBookmark } from './batch-cleanup.js';
import { triggerDeleteHook, writePurgeSnapshot, type PurgeHooks } from './purge.js';

const ACTION_VERB: Record<BulkAction, string> = {
  trash: '移入回收站',
  restore: '恢复',
  purge: '彻底删除',
  'reading-remove': '移出待看',
};

/** 动作面向哪张表：只有移出待看是待看，其余都是收藏。 */
function kindOf(action: BulkAction): 'bookmark' | 'reading' {
  return action === 'reading-remove' ? 'reading' : 'bookmark';
}

function bookmarkState(row: Bookmark): BulkEntryState {
  return row.deletedAt ? 'trashed' : 'active';
}

function readingState(row: ReadingItem): BulkEntryState {
  if (row.relatedBookmarkId) return 'converted';
  return row.status === 'completed' ? 'completed' : 'pending';
}

/**
 * 确认这一刻就不该处理的理由；能处理返回 null。
 *
 * 这里只判断「这个动作的前提还成不成立」：已经在回收站的不用再移一次、
 * 不在回收站的谈不上恢复、已完成 / 已转收藏的不算待看。版本变化不在这里
 * 判——冻结时记下的就是当下的版本，保护的是确认之后的新变化。
 */
function bookmarkBlocker(action: BulkAction, row: Bookmark | undefined): string | null {
  if (!row) return '已不在库里';
  if (action === 'trash' && row.deletedAt) return '已在回收站';
  if (action === 'restore' && !row.deletedAt) return '不在回收站';
  return null;
}

function readingBlocker(row: ReadingItem | undefined): string | null {
  if (!row) return '已不在待看里';
  if (row.relatedBookmarkId) return '已转成收藏';
  if (row.status === 'completed') return '已完成';
  return null;
}

function labelOf(action: BulkAction, count: number): string {
  if (action === 'reading-remove') return `手动移除的 ${count} 条待看`;
  return `手动选择的 ${count} 条收藏`;
}

/**
 * 冻结本次勾选。
 *
 * 只读事务：界面拿到 `actionable` 后才让用户点确认，避免「确认框写 12 条、
 * 实际只处理 9 条」这种当场的错愕；真正被挡下的差额在确认前就说清楚。
 */
export async function prepareBulkSelection(
  db: ShiyeDB,
  action: BulkAction,
  ids: readonly string[]
): Promise<BulkPreview> {
  const unique = [...new Set(ids)];
  const frozenAt = nowIso();
  const excluded: BulkPreview['excluded'] = [];
  const items: BulkTarget[] = [];

  if (unique.length === 0) {
    return {
      action,
      requested: 0,
      actionable: 0,
      excludedCount: 0,
      excluded,
      token: { action, frozenAt, label: labelOf(action, 0), items },
      frozenAt,
    };
  }

  if (kindOf(action) === 'reading') {
    await db.transaction('r', db.readingItems, async () => {
      const rows = await db.readingItems.bulkGet(unique);
      unique.forEach((id, index) => {
        const row = rows[index];
        const blocker = readingBlocker(row);
        if (!row || blocker) {
          excluded.push({ entityId: id, title: row?.title ?? '', reason: blocker ?? '已不在待看里' });
          return;
        }
        items.push({
          entityId: row.id,
          kind: 'reading',
          title: row.title,
          localRevision: row.localRevision,
          state: readingState(row),
        });
      });
    });
  } else {
    await db.transaction('r', db.bookmarks, async () => {
      const rows = await db.bookmarks.bulkGet(unique);
      unique.forEach((id, index) => {
        const row = rows[index];
        const blocker = bookmarkBlocker(action, row);
        if (!row || blocker) {
          excluded.push({ entityId: id, title: row?.title ?? '', reason: blocker ?? '已不在库里' });
          return;
        }
        items.push({
          entityId: row.id,
          kind: 'bookmark',
          title: row.title,
          localRevision: row.localRevision,
          state: bookmarkState(row),
        });
      });
    });
  }

  return {
    action,
    requested: unique.length,
    actionable: items.length,
    excludedCount: excluded.length,
    excluded,
    token: { action, frozenAt, label: labelOf(action, items.length), items },
    frozenAt,
  };
}

/** 冻结之后状态变了：说清变成了什么，别只报「跳过 N 条」。 */
function stateChangeReason(action: BulkAction, expected: BulkEntryState, now: BulkEntryState): string {
  if (action === 'reading-remove') {
    if (now === 'completed') return '确认后已完成，已保留';
    if (now === 'converted') return '确认后已转成收藏，已保留';
    return '确认后已回到待看，已保留';
  }
  if (action === 'restore') {
    return now === 'active' ? '确认后已恢复，跳过' : '确认后状态已变，已保留';
  }
  if (expected === 'trashed' && now === 'active') return '确认后已从回收站恢复，已保留';
  if (expected === 'active' && now === 'trashed') return '确认后已被移入回收站，已保留';
  return '确认后状态已变，已保留';
}

/**
 * 执行冻结清单。
 *
 * 事务里重新读、逐条复核，再动手；硬删除先写快照。返回真正处理掉的条数
 * 与每一处跳过，界面按这个结果说话，而不是按勾选数假装成功。
 */
export async function runBulkSelection(
  db: ShiyeDB,
  token: BulkToken,
  hooks?: PurgeHooks
): Promise<BulkResult> {
  const action = token.action;
  const skipped: BulkResult['skipped'] = [];
  if (token.items.length === 0) {
    return { action, removed: 0, skipped, snapshotId: null };
  }

  const tables =
    kindOf(action) === 'reading'
      ? [db.readingItems, db.settings, db.purgeSnapshots, db.meta]
      : [db.bookmarks, db.tombstones, db.categories, db.settings, db.purgeSnapshots, db.meta];

  return db.transaction('rw', tables, async () => {
    const trash: Bookmark[] = [];
    const restore: Bookmark[] = [];
    const hardBookmarks: Bookmark[] = [];
    const hardReadings: ReadingItem[] = [];

    for (const item of token.items) {
      if (item.kind === 'reading') {
        const row = await db.readingItems.get(item.entityId);
        if (!row) {
          skipped.push({ entityId: item.entityId, title: item.title, reason: '已不在待看里' });
          continue;
        }
        // 先看状态变没变：变了要说清「变成了完成 / 收藏」，比笼统的「已完成」有用。
        const now = readingState(row);
        if (now !== item.state) {
          skipped.push({ entityId: row.id, title: row.title, reason: stateChangeReason(action, item.state, now) });
          continue;
        }
        const blocker = readingBlocker(row);
        if (blocker) {
          skipped.push({ entityId: row.id, title: row.title, reason: blocker });
          continue;
        }
        if (row.localRevision !== item.localRevision) {
          skipped.push({ entityId: row.id, title: row.title, reason: '确认后被修改，已保留' });
          continue;
        }
        hardReadings.push(row);
        continue;
      }

      const row = await db.bookmarks.get(item.entityId);
      if (!row) {
        skipped.push({ entityId: item.entityId, title: item.title, reason: '已不在库里' });
        continue;
      }
      const now = bookmarkState(row);
      if (now !== item.state) {
        skipped.push({ entityId: row.id, title: row.title, reason: stateChangeReason(action, item.state, now) });
        continue;
      }
      const blocker = bookmarkBlocker(action, row);
      if (blocker) {
        skipped.push({ entityId: row.id, title: row.title, reason: blocker });
        continue;
      }
      if (row.localRevision !== item.localRevision) {
        skipped.push({ entityId: row.id, title: row.title, reason: '确认后被修改，已保留' });
        continue;
      }
      if (action === 'trash') trash.push(row);
      else if (action === 'restore') restore.push(row);
      else hardBookmarks.push(row);
    }

    const now = nowIso();
    let snapshotId: string | null = null;

    if (hardBookmarks.length > 0 || hardReadings.length > 0) {
      // 墓碑只属于收藏：待看没有墓碑表，移出待看时去读会被 Dexie 判成「事务里没有这张表」，
      // 整条事务直接失败。所以只在确实有收藏要删时才查。
      const hardIds = new Set(hardBookmarks.map((row) => row.id));
      const tombstones =
        hardBookmarks.length === 0
          ? []
          : (await db.tombstones.toArray()).filter(
              (tombstone: Tombstone) => tombstone.entityType === 'bookmark' && hardIds.has(tombstone.id)
            );
      snapshotId = await writePurgeSnapshot(
        db,
        {
          entry: 'selection',
          // 标签写「真正删掉的条数」，而不是勾选数：确认后被改过的那几条还在库里，
          // 写成 12 会让「找回」时以为它们也是这次清掉的。
          scopeLabel: labelOf(action, hardBookmarks.length + hardReadings.length),
          bookmarks: hardBookmarks,
          readingItems: hardReadings,
          tombstones,
        },
        hooks
      );
      await triggerDeleteHook(hooks);
    }

    for (const row of trash) await softDeleteBookmark(db, row, now);

    for (const row of restore) {
      let categoryId = row.categoryId;
      if (categoryId && !(await db.categories.get(categoryId))) categoryId = null;
      const next: Bookmark = {
        ...row,
        deletedAt: null,
        categoryId,
        revision: row.revision + 1,
        localRevision: row.localRevision + 1,
        updatedAt: now,
      };
      // 派生索引键（lifeState / unreadFlag / categoryKey）必须跟着恢复一起改，
      // 否则记录虽然删掉了 deletedAt，列表按 lifeState 索引仍看不到它。
      Object.assign(next, deriveIndexFields(next));
      await db.bookmarks.put(next);
      await db.tombstones.delete(['bookmark', row.id]);
    }

    if (hardBookmarks.length > 0) {
      await db.bookmarks.bulkDelete(hardBookmarks.map((row) => row.id));
      const hardIds = new Set(hardBookmarks.map((row) => row.id));
      const stale = (await db.tombstones.toArray()).filter(
        (tombstone: Tombstone) => tombstone.entityType === 'bookmark' && hardIds.has(tombstone.id)
      );
      await db.tombstones.bulkDelete(
        stale.map((tombstone) => [tombstone.entityType, tombstone.id] as [string, string])
      );
    }

    if (hardReadings.length > 0) {
      await db.readingItems.bulkDelete(hardReadings.map((row) => row.id));
    }

    return {
      action,
      removed: trash.length + restore.length + hardBookmarks.length + hardReadings.length,
      skipped,
      snapshotId,
    };
  });
}

export { ACTION_VERB };
