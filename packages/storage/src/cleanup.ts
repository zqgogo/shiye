import {
  AppError,
  isBatchCleanupActionable,
  matchesCleanupCriteria,
  nowIso,
  type BatchCleanupMode,
  type BatchEntryState,
  type Bookmark,
  type CleanupCriteria,
  type CleanupEntryRow,
  type CleanupPreview,
  type CleanupResult,
  type CleanupScope,
  type CleanupScopeView,
  type CleanupToken,
  type PurgeEntry,
  type ReadingItem,
  type Tombstone,
} from '@shiye/core';
import { type ShiyeDB } from './db.js';
import { softDeleteBookmark } from './batch-cleanup.js';
import { triggerDeleteHook, writePurgeSnapshot, type PurgeHooks } from './purge.js';

const READ_TABLES = (db: ShiyeDB) => [db.bookmarks, db.readingItems, db.categories];

function emptyCounts(): Record<BatchEntryState, number> {
  return { untouched: 0, modified: 0, trashed: 0, converted: 0, completed: 0, missing: 0 };
}

function hostOf(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 一条记录可能有多个来源（先收藏后导入）；取第一个带目录的，别把同一批拆成两堆。 */
function folderOf(row: { sources: { originalFolder?: string }[] }): string {
  for (const source of row.sources) {
    const folder = (source.originalFolder ?? '').trim();
    if (folder) return folder;
  }
  return '';
}

function bookmarkState(row: Bookmark): BatchEntryState {
  if (row.deletedAt) return 'trashed';
  return row.localRevision > 1 ? 'modified' : 'untouched';
}

function readingState(row: ReadingItem): BatchEntryState {
  if (row.relatedBookmarkId) return 'converted';
  if (row.status === 'completed') return 'completed';
  return row.localRevision > 1 ? 'modified' : 'untouched';
}

function baseLabel(scope: CleanupScope, categoryName: string | null): string {
  if (scope.kind === 'reading') return '待看';
  if (scope.kind === 'uncategorized') return '未分类';
  if (scope.kind === 'category') return `分类：${categoryName ?? '（已删除的分类）'}`;
  return '全部收藏';
}

/**
 * 读范围内的全部记录。
 *
 * 固定按「正常 + 回收站」读，不在这一层按 `presence` 过滤：
 * 界面要同时显示「正常 N 条 / 回收站 M 条」，用户切三态时数字不能闪成 0。
 * 真正的命中判定由 `matchesCriteria()` 做，预览与执行共用它。
 */
async function collectRows(
  db: ShiyeDB,
  scope: CleanupScope
): Promise<{ rows: CleanupEntryRow[]; label: string }> {
  if (scope.kind === 'reading') {
    // 待看页只列还没读完的：已完成、已转收藏有各自的入口，不在这里冒充「待看」。
    const pending = (await db.readingItems.toArray()).filter(
      (row) => row.status === 'pending' && !row.relatedBookmarkId
    );
    return {
      label: baseLabel(scope, null),
      rows: pending
        .map<CleanupEntryRow>((row) => ({
          entityId: row.id,
          kind: 'reading',
          title: row.title,
          originalUrl: row.originalUrl,
          site: hostOf(row.canonicalUrl),
          folder: folderOf(row),
          categoryId: null,
          categoryName: null,
          state: readingState(row),
          localRevision: row.localRevision,
        }))
        .sort(byTitle),
    };
  }

  const categories = new Map((await db.categories.toArray()).map((row) => [row.id, row.name]));
  const all = await db.bookmarks.toArray();
  const scoped = all.filter((row) => {
    if (scope.kind === 'category') return row.categoryId === (scope.categoryId ?? '');
    if (scope.kind === 'uncategorized') return !row.categoryId;
    return true;
  });

  return {
    label: baseLabel(scope, scope.categoryId ? (categories.get(scope.categoryId) ?? null) : null),
    rows: scoped
      .map<CleanupEntryRow>((row) => ({
        entityId: row.id,
        kind: 'bookmark',
        title: row.title,
        originalUrl: row.originalUrl,
        site: hostOf(row.canonicalUrl),
        folder: folderOf(row),
        categoryId: row.categoryId,
        categoryName: row.categoryId ? (categories.get(row.categoryId) ?? null) : null,
        state: bookmarkState(row),
        localRevision: row.localRevision,
      }))
      .sort(byTitle),
  };
}

function byTitle(a: CleanupEntryRow, b: CleanupEntryRow): number {
  return a.title.localeCompare(b.title, 'zh-Hans-CN') || a.entityId.localeCompare(b.entityId);
}

/**
 * 命中判定在 `@shiye/core`：界面计数、预览冻结、执行复核共用同一份实现。
 * 这里保留一个薄封装，只是为了让本文件的调用点读起来短一点。
 */
function matches(row: CleanupEntryRow, criteria: CleanupCriteria): boolean {
  return matchesCleanupCriteria(row, criteria);
}

function describeScope(
  label: string,
  criteria: CleanupCriteria,
  actionableByState: Record<BatchEntryState, number>
): string {
  const parts: string[] = [];
  if (criteria.folders.length === 1) parts.push(`目录：${criteria.folders[0] || '（无目录）'}`);
  else if (criteria.folders.length > 1) parts.push(`${criteria.folders.length} 个目录`);
  if (criteria.sites.length === 1) parts.push(`站点：${criteria.sites[0]}`);
  else if (criteria.sites.length > 1) parts.push(`${criteria.sites.length} 个站点`);
  if (criteria.mode === 'delete') parts.push('彻底删除');
  // 快照范围要能读出「这次动了回收站里的记录」，否则事后分不清删的是哪一段。
  if (actionableByState.trashed > 0) parts.push(`含回收站 ${actionableByState.trashed} 条`);
  return parts.length > 0 ? `${label} · ${parts.join(' · ')}` : label;
}

/** 只读：列出范围内的记录与可选目录 / 站点，供面板渲染筛选器。 */
export async function readCleanupScope(db: ShiyeDB, scope: CleanupScope): Promise<CleanupScopeView> {
  return db.transaction('r', READ_TABLES(db), async () => {
    const { rows, label } = await collectRows(db, scope);
    const folders = [...new Set(rows.map((row) => row.folder).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'zh-Hans-CN')
    );
    const sites = [...new Set(rows.map((row) => row.site).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b, 'en')
    );
    const counts = emptyCounts();
    for (const row of rows) counts[row.state] += 1;
    return { scope, label, rows, folders, sites, counts, total: rows.length };
  });
}

/**
 * 预览：命中了多少、这个动作能处理多少、要处理哪些 id 与版本（冻结）。
 *
 * 动作必须在预览时给出：彻底删除会收已在回收站里的记录，范围比移入回收站大；
 * 等确认时再选动作，就会出现「预览 30 条、实删 33 条」。
 */
export async function previewCleanup(db: ShiyeDB, criteria: CleanupCriteria): Promise<CleanupPreview> {
  return db.transaction('r', READ_TABLES(db), async () => {
    const { rows, label } = await collectRows(db, criteria.scope);
    const matchedRows = rows.filter((row) => matches(row, criteria));
    const destination = criteria.scope.kind === 'reading' ? 'reading' : 'library';
    const actionableRows = matchedRows.filter((row) =>
      isBatchCleanupActionable(row.state, destination, criteria.mode)
    );

    const byState = emptyCounts();
    for (const row of matchedRows) byState[row.state] += 1;
    const actionableByState = emptyCounts();
    for (const row of actionableRows) actionableByState[row.state] += 1;

    const frozenAt = nowIso();
    const token: CleanupToken = {
      scope: criteria.scope,
      mode: criteria.mode,
      frozenAt,
      label: describeScope(label, criteria, actionableByState),
      items: actionableRows.map((row) => ({
        entityId: row.entityId,
        kind: row.kind,
        localRevision: row.localRevision,
        state: row.state,
      })),
    };

    return {
      scope: criteria.scope,
      mode: criteria.mode,
      total: rows.length,
      matched: matchedRows.length,
      actionable: actionableRows.length,
      protectedCount: matchedRows.length - actionableRows.length,
      byState,
      actionableByState,
      sample: matchedRows.slice(0, 50),
      token,
      frozenAt,
    };
  });
}

function snapshotEntryFor(scope: CleanupScope): PurgeEntry {
  if (scope.kind === 'reading') return 'readingPending';
  if (scope.kind === 'category') return 'category';
  if (scope.kind === 'uncategorized') return 'uncategorized';
  return 'all';
}

/**
 * 执行清理。
 *
 * 只认冻结清单：预览之后新增的命中不会因为「条件还成立」被卷进来；
 * 状态或版本变了一律跳过并报原因，不按冻结时的数字假装成功。
 * 硬删除（彻底删除、待看移除）先写本机清理快照，写不进去一条都不删。
 */
export async function runCleanup(
  db: ShiyeDB,
  token: CleanupToken,
  hooks?: PurgeHooks
): Promise<CleanupResult> {
  if (token.items.length === 0) {
    throw new AppError('INVALID_INPUT', '这次没有匹配到可处理的条目。');
  }
  const mode: BatchCleanupMode = token.mode;

  return db.transaction(
    'rw',
    [
      db.bookmarks,
      db.readingItems,
      db.tombstones,
      db.settings,
      db.purgeSnapshots,
      db.meta,
    ],
    async () => {
      const skipped: CleanupResult['skipped'] = [];
      const trash: Bookmark[] = [];
      const hardBookmarks: Bookmark[] = [];
      const hardReadings: ReadingItem[] = [];

      for (const item of token.items) {
        if (item.kind === 'bookmark') {
          const row = await db.bookmarks.get(item.entityId);
          if (!row) {
            skipped.push({ entityId: item.entityId, title: '', reason: '已不在库里' });
            continue;
          }
          // 预览之后状态变了：不是这次要处理的那一段，留下并说清楚。
          if (item.state !== 'trashed' && row.deletedAt) {
            skipped.push({ entityId: item.entityId, title: row.title, reason: '预览后被移入回收站，已保留' });
            continue;
          }
          if (item.state === 'trashed' && !row.deletedAt) {
            skipped.push({ entityId: item.entityId, title: row.title, reason: '预览后已从回收站恢复，已保留' });
            continue;
          }
          if (row.localRevision !== item.localRevision) {
            skipped.push({ entityId: item.entityId, title: row.title, reason: '预览后被修改，已保留' });
            continue;
          }
          if (mode === 'delete') hardBookmarks.push(row);
          else trash.push(row);
          continue;
        }

        const row = await db.readingItems.get(item.entityId);
        if (!row) {
          skipped.push({ entityId: item.entityId, title: '', reason: '已不在待看里' });
          continue;
        }
        if (row.relatedBookmarkId) {
          skipped.push({ entityId: item.entityId, title: row.title, reason: '已转成收藏' });
          continue;
        }
        if (row.status === 'completed') {
          skipped.push({ entityId: item.entityId, title: row.title, reason: '已完成' });
          continue;
        }
        if (row.localRevision !== item.localRevision) {
          skipped.push({ entityId: item.entityId, title: row.title, reason: '预览后被修改，已保留' });
          continue;
        }
        // 待看没有回收站：无论哪一档都是彻底删除，靠清理快照找回。
        hardReadings.push(row);
      }

      const now = nowIso();
      let snapshotId: string | null = null;

      if (hardBookmarks.length > 0 || hardReadings.length > 0) {
        const hardIds = new Set(hardBookmarks.map((row) => row.id));
        const tombstones = (await db.tombstones.toArray()).filter(
          (tombstone) => tombstone.entityType === 'bookmark' && hardIds.has(tombstone.id)
        );
        snapshotId = await writePurgeSnapshot(
          db,
          {
            entry: snapshotEntryFor(token.scope),
            scopeLabel: token.label,
            bookmarks: hardBookmarks,
            readingItems: hardReadings,
            tombstones,
          },
          hooks
        );
        await triggerDeleteHook(hooks);
      }

      for (const row of trash) await softDeleteBookmark(db, row, now);
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
        mode,
        removed: trash.length + hardBookmarks.length + hardReadings.length,
        skipped,
        snapshotId,
      };
    }
  );
}
