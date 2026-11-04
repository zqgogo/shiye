import {
  AppError,
  LIMITS,
  domainOf,
  newId,
  nowIso,
  type Bookmark,
  type Category,
  type PurgeEntry,
  type PurgeRestoreDecision,
  type PurgeRestorePreview,
  type PurgeSnapshot,
  type PurgeSnapshotDetail,
  type PurgeSnapshotEntry,
  type ReadingItem,
  type Tombstone,
} from '@shiye/core';
import { deriveIndexFields, type MetaRow, type ShiyeDB } from './db.js';

type FloorEntity = 'bookmark' | 'reading';

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
  categoryDependencies?: Category[];
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
    bytes: bytesOf({ bookmarks, readingItems, tombstones, categoryDependencies: payload.categoryDependencies ?? [] }),
    restoredAt: null,
    restoredCounts: null,
    restoredIds: [],
    ...(payload.categoryDependencies ? { categoryDependencies: payload.categoryDependencies } : {}),
  };

  if (total > LIMITS.purgeSnapshotMaxItems || snapshot.bytes > LIMITS.purgeSnapshotMaxBytes) {
    throw new AppError(
      'SNAPSHOT_TOO_LARGE',
      `这次要清理 ${total} 条（约 ${mb(snapshot.bytes)}），超过单份清理快照上限（${LIMITS.purgeSnapshotMaxItems} 条 / ${mb(LIMITS.purgeSnapshotMaxBytes)}）。请先到「数据与备份」导出完整 JSON，再分批清理。`,
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
  await recordRevisionFloors(db, { bookmarks, readingItems });
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

/** 每个实体一条版本高水位记录，键里带类型，收藏与待看同 id 也不会串。 */
function floorKey(entityType: FloorEntity, id: string): string {
  return `revfloor:${entityType}:${id}`;
}

/**
 * 硬删除前记下这些实体用过的最高版本号。
 *
 * 恢复如果直接写回「快照里的版本」或退回 1，清理前打开的编辑页仍拿着旧基线，
 * 版本校验会重新放行，让旧页面覆盖恢复后的内容。所以版本必须只增不减：
 * 删除时记高水位，恢复时从高水位往上加。放在写快照这一步统一做，
 * 是因为所有硬删除入口都必经此处，没有第二条路会漏记。
 */
export async function recordRevisionFloors(
  db: ShiyeDB,
  payload: Pick<PurgeSnapshotPayload, 'bookmarks' | 'readingItems'>
): Promise<void> {
  const entries: MetaRow[] = [];
  for (const row of payload.bookmarks ?? []) {
    entries.push({ key: floorKey('bookmark', row.id), value: Math.max(row.revision, row.localRevision) });
  }
  for (const row of payload.readingItems ?? []) {
    entries.push({ key: floorKey('reading', row.id), value: Math.max(row.revision, row.localRevision) });
  }
  if (entries.length === 0) return;

  const stored = await db.meta.bulkGet(entries.map((entry) => entry.key));
  await db.meta.bulkPut(
    entries.map((entry, index) => {
      const previous = stored[index]?.value;
      const floor = typeof previous === 'number' ? previous : 0;
      const value = typeof entry.value === 'number' ? entry.value : 0;
      return { key: entry.key, value: Math.max(floor, value) };
    })
  );
}

/**
 * 分配恢复后的版本号：严格大于这条记录用过的任何版本。
 *
 * 只比「快照里的版本」大是不够的：从更早的快照恢复时，中间那几次编辑的版本
 * 可能已经更高，回退到「快照版本 + 1」正好撞上旧基线。高水位记录只增不减，
 * 所以无论是第几次恢复、从哪份快照恢复，新版本都必然大于此前所有基线。
 */
async function allocateRestoredVersion(
  db: ShiyeDB,
  entityType: FloorEntity,
  row: { id: string; revision: number; localRevision: number }
): Promise<number> {
  const key = floorKey(entityType, row.id);
  const stored = await db.meta.get(key);
  const floor = typeof stored?.value === 'number' ? stored.value : 0;
  const next = Math.max(floor, row.revision, row.localRevision) + 1;
  await db.meta.put({ key, value: next });
  return next;
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
  for (const row of snapshot.bookmarks) {
    const decision = await decideBookmark(db, row);
    if (decision.action === 'restore' && row.categoryId && snapshot.categoryDependencies?.some((category) => category.id === row.categoryId) && !(await db.categories.get(row.categoryId))) {
      decision.reason = '将恢复或复用原分类层级';
    }
    decisions.push(decision);
  }
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
 * 「看看能找回什么」背后的逐条明细：每条长什么样、现在能不能回来、为什么不能。
 *
 * 判定直接复用 `planRestore`，界面上的计数与恢复执行走的是同一套逻辑；
 * 这里只额外补上展示需要的字段（站点、原始目录、分类名），不另算一套规则。
 */
export async function readPurgeSnapshotDetail(
  db: ShiyeDB,
  snapshotId: string
): Promise<PurgeSnapshotDetail> {
  return db.transaction(
    'r',
    [db.purgeSnapshots, db.bookmarks, db.readingItems, db.categories],
    async () => {
      const snapshot = await db.purgeSnapshots.get(snapshotId);
      if (!snapshot) throw new AppError('NOT_FOUND', '这条清理快照已经不在了。');
      const decisions = await planRestore(db, snapshot);
      const byId = new Map(decisions.map((row) => [row.id, row]));
      const categories = new Map((await db.categories.toArray()).map((row) => [row.id, row.name]));
      const restoredIds = new Set(snapshot.restoredIds ?? []);
      const entries: PurgeSnapshotEntry[] = [];

      for (const row of snapshot.bookmarks) {
        // 快照是硬删除前的副本，条目可能被早先的恢复带回去，也可能因同网址冲突回不来；
        // 这里照抄判定结果，不自己重算。
        const decision = byId.get(row.id) ?? skip(row.id, row.title, '这条记录不在本次判定范围内');
        entries.push({
          id: row.id,
          kind: 'bookmark',
          title: row.title,
          url: row.originalUrl,
          host: domainOf(row.originalUrl),
          // 一份快照可能横跨多次导入，取最近一条带目录的来源；待看与手动添加没有目录。
          folder:
            [...row.sources].reverse().find((entry) => entry.originalFolder)?.originalFolder?.trim() || null,
          categoryName: row.categoryId ? categories.get(row.categoryId) ?? null : null,
          trashed: Boolean(row.deletedAt),
          restored: restoredIds.has(row.id),
          action: decision.action,
          reason: decision.reason,
        });
      }
      for (const row of snapshot.readingItems) {
        const decision = byId.get(row.id) ?? skip(row.id, row.title, '这条记录不在本次判定范围内');
        entries.push({
          id: row.id,
          kind: 'reading',
          title: row.title,
          url: row.originalUrl,
          host: domainOf(row.originalUrl),
          folder: null,
          categoryName: null,
          trashed: false,
          restored: restoredIds.has(row.id),
          action: decision.action,
          reason: decision.reason,
        });
      }

      return {
        snapshotId: snapshot.id,
        entry: snapshot.entry,
        scopeLabel: snapshot.scopeLabel,
        createdAt: snapshot.createdAt,
        totals: {
          candidates: decisions.length,
          restorable: decisions.filter((row) => row.action === 'restore').length,
          skipped: decisions.filter((row) => row.action === 'skip').length,
          conflicted: decisions.filter((row) => row.action === 'conflict').length,
        },
        entries,
      };
    }
  );
}

/**
 * 只把这一份快照删掉的条目加回来。
 *
 * 与整库替换恢复相反：不清表、不覆盖、不触碰快照之外的记录；
 * 计划在事务内重算一遍，预览之后被改动过的条目按最新状态重新判定。
 *
 * 传 `ids` 时只处理勾选的那几条（「找回一部分」）：没勾的不动，也不写进已找回名单。
 * 判定仍然逐条重算，所以勾了之后库里刚发生变化，照样会按最新状态跳过，而不是照单全收。
 */
export async function restorePurgeSnapshot(
  db: ShiyeDB,
  snapshotId: string,
  ids?: string[]
): Promise<{ preview: PurgeRestorePreview; restored: number }> {
  return db.transaction(
    'rw',
    [db.bookmarks, db.readingItems, db.tombstones, db.categories, db.purgeSnapshots, db.meta],
    async () => {
      const snapshot = await db.purgeSnapshots.get(snapshotId);
      if (!snapshot) throw new AppError('NOT_FOUND', '这条清理快照已经不在了。');

      const wanted = ids ? new Set(ids) : null;
      const all = await planRestore(db, snapshot);
      const decisions = wanted ? all.filter((row) => wanted.has(row.id)) : all;
      if (decisions.length === 0) {
        throw new AppError('INVALID_INPUT', '没有勾选可找回的条目。');
      }
      const preview = summarize(snapshot, decisions);
      const categoryMapping = new Map<string, string>();
      const dependencies = snapshot.categoryDependencies ?? [];
      const needed = new Set<string>();
      for (const decision of decisions) {
        if (decision.action !== 'restore') continue;
        let categoryId = snapshot.bookmarks.find((row) => row.id === decision.id)?.categoryId;
        while (categoryId && !needed.has(categoryId)) {
          needed.add(categoryId);
          categoryId = dependencies.find((row) => row.id === categoryId)?.parentId;
        }
      }
      const pending = dependencies.filter((row) => needed.has(row.id));
      while (pending.length) {
        const index = pending.findIndex((row) => !row.parentId || !needed.has(row.parentId) || categoryMapping.has(row.parentId));
        if (index < 0) throw new AppError('INVALID_INPUT', '快照的分类层级无效，恢复已停止。');
        const saved = pending.splice(index, 1)[0]!;
        if (await db.categories.get(saved.id)) { categoryMapping.set(saved.id, saved.id); continue; }
        const parentId = saved.parentId ? categoryMapping.get(saved.parentId) ?? ((await db.categories.get(saved.parentId)) ? saved.parentId : null) : null;
        const same = (await db.categories.where('name').equals(saved.name).toArray()).find((row) => (row.parentId ?? null) === parentId);
        if (!same) await db.categories.put({ ...saved, parentId, revision: saved.revision + 1, updatedAt: nowIso() });
        categoryMapping.set(saved.id, same?.id ?? saved.id);
      }
      const bookmarkById = new Map(snapshot.bookmarks.map((row) => [row.id, row]));
      const readingById = new Map(snapshot.readingItems.map((row) => [row.id, row]));
      const now = nowIso();

      const restoredBookmarkIds: string[] = [];
      const restoredReadingIds: string[] = [];
      let restored = 0;

      for (const decision of decisions) {
        if (decision.action !== 'restore') continue;
        const bookmark = bookmarkById.get(decision.id);
        if (bookmark) {
          const categoryId =
            bookmark.categoryId ? categoryMapping.get(bookmark.categoryId) ?? ((await db.categories.get(bookmark.categoryId)) ? bookmark.categoryId : null) : null;
          // 版本只能往上走：写回快照里的版本（甚至退回 1）会让清理前的旧编辑基线重新生效，
          // 旧页面一保存就把恢复后的内容覆盖掉，而版本校验还认为「没冲突」。
          const version = await allocateRestoredVersion(db, 'bookmark', bookmark);
          const next: Bookmark = {
            ...bookmark,
            categoryId,
            // 原本在回收站的就回回收站，不复活的条目不会突然出现在收藏列表里。
            deletedAt: bookmark.deletedAt ?? null,
            revision: version,
            localRevision: version,
            updatedAt: now,
          };
          Object.assign(next, deriveIndexFields(next));
          await db.bookmarks.put(next);
          restoredBookmarkIds.push(next.id);
          restored += 1;
          continue;
        }
        const reading = readingById.get(decision.id);
        if (reading) {
          // 待看同样要换版本：旧页面拿着的 localRevision 不能再用来转换或改写这条。
          const version = await allocateRestoredVersion(db, 'reading', reading);
          await db.readingItems.put({ ...reading, revision: version, localRevision: version });
          restoredReadingIds.push(reading.id);
          restored += 1;
        }
      }

      // 恢复的条目要能再次导入：清掉同 ID 或同网址的删除标记。
      if (restoredBookmarkIds.length > 0) {
        const restoredRows = snapshot.bookmarks.filter((row) => restoredBookmarkIds.includes(row.id));
        const urls = new Set(restoredRows.map((row) => row.canonicalUrl));
        const tombstones = await db.tombstones.toArray();
        const stale = tombstones.filter(
          (row) =>
            row.entityType === 'bookmark' &&
            (restoredBookmarkIds.includes(row.id) || (row.canonicalUrl ? urls.has(row.canonicalUrl) : false))
        );
        await db.tombstones.bulkDelete(
          stale.map((row) => [String(row.entityType), String(row.id)] as [string, string])
        );
      }

      // 已找回名单是累计的：同一份快照可能被分几次找回，界面靠它标出「这条已经回来了」。
      const alreadyRestored = snapshot.restoredIds ?? [];
      const restoredIds = [...new Set([...alreadyRestored, ...restoredBookmarkIds, ...restoredReadingIds])];

      await db.purgeSnapshots.put({
        ...snapshot,
        restoredAt: now,
        restoredCounts: {
          restored,
          skipped: preview.skipped,
          conflicted: preview.conflicted,
        },
        restoredIds,
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
