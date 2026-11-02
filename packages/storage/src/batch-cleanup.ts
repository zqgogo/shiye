import Dexie from 'dexie';
import {
  AppError,
  nowIso,
  type BatchCleanupCriteria,
  type BatchCleanupMode,
  type BatchCleanupPreview,
  type BatchCleanupResult,
  type BatchCleanupToken,
  type BatchEntryRow,
  type BatchEntryState,
  type BatchEntryView,
  type Bookmark,
  type ImportBatch,
  type ReadingItem,
  type SourceInfo,
  type Tombstone,
} from '@shiye/core';
import { deriveIndexFields, type ShiyeDB } from './db.js';
import { triggerDeleteHook, writePurgeSnapshot, type PurgeHooks } from './purge.js';

const READ_TABLES = (db: ShiyeDB) => [
  db.importBatches,
  db.importItems,
  db.bookmarks,
  db.readingItems,
];

function emptyCounts(): Record<BatchEntryState, number> {
  return { untouched: 0, modified: 0, trashed: 0, converted: 0, completed: 0, missing: 0 };
}

/** 站点按主机名归堆，去掉 www 前缀，免得同一个站分成两组。 */
function hostOf(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 导入时 Chrome 收藏夹的目录名；待看没有目录，返回空串。 */
function folderOf(row: { sources: SourceInfo[] }, batchId: string): string {
  const source = row.sources.find((entry) => entry.importBatchId === batchId) ?? row.sources[0];
  return (source?.originalFolder ?? '').trim();
}

function bookmarkState(row: Bookmark | undefined): BatchEntryState {
  if (!row) return 'missing';
  if (row.deletedAt) return 'trashed';
  // 导入时新建的记录版本为 1；之后的编辑、AI、已读都会让它变大。
  return row.localRevision > 1 ? 'modified' : 'untouched';
}

function readingState(row: ReadingItem | undefined): BatchEntryState {
  if (!row) return 'missing';
  if (row.relatedBookmarkId) return 'converted';
  if (row.status === 'completed') return 'completed';
  return row.localRevision > 1 ? 'modified' : 'untouched';
}

async function readBatchEntries(db: ShiyeDB, batch: ImportBatch): Promise<BatchEntryRow[]> {
  const mappings = await db.importItems
    .where('[batchId+sourceKey]')
    .between([batch.id, Dexie.minKey], [batch.id, Dexie.maxKey])
    .toArray();

  const rows: BatchEntryRow[] = [];
  for (const mapping of mappings) {
    if (batch.destination === 'library') {
      const row = await db.bookmarks.get(mapping.entityId);
      rows.push({
        entityId: mapping.entityId,
        title: row?.title ?? '',
        originalUrl: row?.originalUrl ?? '',
        site: row ? hostOf(row.canonicalUrl) : '',
        folder: row ? folderOf(row, batch.id) : '',
        state: bookmarkState(row),
        localRevision: row?.localRevision ?? 0,
      });
      continue;
    }
    const row = await db.readingItems.get(mapping.entityId);
    rows.push({
      entityId: mapping.entityId,
      title: row?.title ?? '',
      originalUrl: row?.originalUrl ?? '',
      site: row ? hostOf(row.canonicalUrl) : '',
      folder: row ? folderOf(row, batch.id) : '',
      state: readingState(row),
      localRevision: row?.localRevision ?? 0,
    });
  }
  return rows;
}

function summarize(rows: BatchEntryRow[]): {
  folders: string[];
  sites: string[];
  counts: Record<BatchEntryState, number>;
} {
  const folders = new Set<string>();
  const sites = new Set<string>();
  const counts = emptyCounts();
  for (const row of rows) {
    if (row.folder) folders.add(row.folder);
    if (row.site) sites.add(row.site);
    counts[row.state] += 1;
  }
  return {
    folders: [...folders].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    sites: [...sites].sort((a, b) => a.localeCompare(b, 'en')),
    counts,
  };
}

/**
 * 「查看本批」：只读列出这一批实际新建的记录与各自现状。
 *
 * 依据是编号映射（importItems），不是「同目录下的记录」——导入时被判成重复而跳过、
 * 或者库里早就存在的条目不会冒充本批新建。撤回之后映射会被清空，这时如实返回
 * 「查不到了」，而不是拿目录去猜一份看起来完整的列表。
 */
export async function listBatchEntries(db: ShiyeDB, batchId: string): Promise<BatchEntryView> {
  return db.transaction('r', READ_TABLES(db), async () => {
    const batch = await db.importBatches.get(batchId);
    if (!batch) throw new AppError('NOT_FOUND', '找不到这次导入的记录。');
    const rows = await readBatchEntries(db, batch);
    const summary = summarize(rows);
    return {
      batch,
      total: rows.length,
      rows,
      folders: summary.folders,
      sites: summary.sites,
      counts: summary.counts,
      note:
        batch.status === 'reverted'
          ? '这一批已撤回，编号映射已清空，查不到原批次明细；只能从撤回留档或对应的清理快照回看。'
          : null,
    };
  });
}

function matchesCriteria(row: BatchEntryRow, criteria: BatchCleanupCriteria): boolean {
  if (criteria.folders.length > 0 && !criteria.folders.includes(row.folder)) return false;
  if (criteria.sites.length > 0 && !criteria.sites.includes(row.site)) return false;
  if (criteria.states.length > 0 && !criteria.states.includes(row.state)) return false;
  return true;
}

function describeScope(criteria: BatchCleanupCriteria, batch: ImportBatch): string {
  const parts: string[] = [];
  if (criteria.folders.length === 1) parts.push(`目录：${criteria.folders[0] || '（无目录）'}`);
  else if (criteria.folders.length > 1) parts.push(`${criteria.folders.length} 个目录`);
  if (criteria.sites.length === 1) parts.push(`站点：${criteria.sites[0]}`);
  else if (criteria.sites.length > 1) parts.push(`${criteria.sites.length} 个站点`);
  if (criteria.states.length === 1 && criteria.states[0] !== 'untouched') {
    parts.push(`状态：${criteria.states[0]}`);
  }
  return `批次：${batch.fileName}${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`;
}

/**
 * 预览「处理全部匹配」。
 *
 * 命中数按筛选条件算，处理范围只冻结其中 untouched 的记录，并把版本一并记下。
 * 执行阶段只认这份冻结清单：预览之后新导入、新改动的条目不会被默默算进去。
 */
export async function previewBatchCleanup(
  db: ShiyeDB,
  criteria: BatchCleanupCriteria
): Promise<BatchCleanupPreview> {
  return db.transaction('r', READ_TABLES(db), async () => {
    const batch = await db.importBatches.get(criteria.batchId);
    if (!batch) throw new AppError('NOT_FOUND', '找不到这次导入的记录。');
    if (batch.status === 'reverted') {
      throw new AppError('INVALID_INPUT', '这一批已经撤回，编号映射已清空，没有可处理的条目。');
    }

    const rows = await readBatchEntries(db, batch);
    const matchedRows = rows.filter((row) => matchesCriteria(row, criteria));
    const actionable = matchedRows.filter((row) => row.state === 'untouched');
    const byState = emptyCounts();
    for (const row of matchedRows) byState[row.state] += 1;

    const frozenAt = nowIso();
    const token: BatchCleanupToken = {
      batchId: batch.id,
      frozenAt,
      label: describeScope(criteria, batch),
      items: actionable.map((row) => ({ entityId: row.entityId, localRevision: row.localRevision })),
    };

    return {
      batch,
      total: rows.length,
      matched: matchedRows.length,
      actionable: actionable.length,
      protectedCount: matchedRows.length - actionable.length,
      byState,
      sample: matchedRows.slice(0, 50),
      token,
      frozenAt,
    };
  });
}

async function softDeleteBookmark(db: ShiyeDB, row: Bookmark, now: string): Promise<void> {
  const next: Bookmark = {
    ...row,
    deletedAt: now,
    revision: row.revision + 1,
    localRevision: row.localRevision + 1,
    updatedAt: now,
  };
  Object.assign(next, deriveIndexFields(next));
  await db.bookmarks.put(next);
  const tombstone: Tombstone = {
    entityType: 'bookmark',
    id: row.id,
    revision: next.revision,
    changeVersion: null,
    deletedAt: now,
    privacyScope: row.privacy.localOnly ? 'local' : 'main',
    canonicalUrl: row.canonicalUrl,
    title: row.title,
  };
  await db.tombstones.put(tombstone);
}

/**
 * 执行「处理全部匹配」。
 *
 * 只处理冻结清单里的条目，并在事务内复核：不在本批名下、已删除、预览后改动过的一律跳过并报原因。
 * 收藏默认进回收站（可撤销）；彻底删除与待看删除都先写本机清理快照，写不进去就一条都不删。
 */
export async function cleanupBatch(
  db: ShiyeDB,
  token: BatchCleanupToken,
  mode: BatchCleanupMode,
  hooks?: PurgeHooks
): Promise<BatchCleanupResult> {
  if (token.items.length === 0) {
    throw new AppError('INVALID_INPUT', '这次没有匹配到可处理的条目。');
  }

  return db.transaction(
    'rw',
    [
      db.bookmarks,
      db.readingItems,
      db.tombstones,
      db.settings,
      db.purgeSnapshots,
      db.meta,
      db.importBatches,
      db.importItems,
    ],
    async () => {
      const batch = await db.importBatches.get(token.batchId);
      if (!batch) throw new AppError('NOT_FOUND', '找不到这次导入的记录。');
      if (batch.status === 'reverted') {
        throw new AppError('INVALID_INPUT', '这一批已经撤回，没有可处理的条目。');
      }

      const mappings = await db.importItems
        .where('[batchId+sourceKey]')
        .between([batch.id, Dexie.minKey], [batch.id, Dexie.maxKey])
        .toArray();
      const belongsToBatch = new Set(mappings.map((mapping) => mapping.entityId));

      const skipped: BatchCleanupResult['skipped'] = [];
      const trash: Bookmark[] = [];
      const hardBookmarks: Bookmark[] = [];
      const hardReadings: ReadingItem[] = [];

      for (const item of token.items) {
        if (!belongsToBatch.has(item.entityId)) {
          skipped.push({ entityId: item.entityId, title: '', reason: '已不属于这一批' });
          continue;
        }
        if (batch.destination === 'library') {
          const row = await db.bookmarks.get(item.entityId);
          if (!row) {
            skipped.push({ entityId: item.entityId, title: '', reason: '已不在库里' });
            continue;
          }
          if (row.deletedAt) {
            skipped.push({ entityId: item.entityId, title: row.title, reason: '已在回收站里' });
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
        // 待看没有回收站：无论选哪一档都是彻底删除，靠清理快照找回。
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
            entry: 'importBatch',
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
          (tombstone) => tombstone.entityType === 'bookmark' && hardIds.has(tombstone.id)
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
