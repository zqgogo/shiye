import Dexie, { type Table, type Transaction } from 'dexie';
import { canonicalizeUrl, toIso, toIsoOrNull, nowIso, SCHEMA_VERSION } from '@shiye/core';
import type {
  AiTask,
  AppliedChange,
  AppSettings,
  Bookmark,
  Category,
  HandoffBatch,
  HandoffItem,
  ImportBatch,
  ImportItem,
  Policy,
  PurgeSnapshot,
  ReadingItem,
  Tag,
  Tombstone,
} from '@shiye/core';

export interface MetaRow {
  key: string;
  value: unknown;
}

export interface SettingsRow {
  key: string;
  value: unknown;
}

export interface AiTaskSnapshotRow {
  itemId: string;
  localRevision: number;
  inputHash: string;
}

export type AiTaskRecord = AiTask;
export type HandoffBatchRecord = HandoffBatch;
export type HandoffItemRecord = HandoffItem;
export type AppliedChangeRecord = AppliedChange;

export const DB_NAME = 'shiye';

/**
 * 版本 1 是引入派生索引键之前的旧主库（原型同构），保留其表定义用于真实迁移。
 * 版本 2 增加派生索引键、墓碑、批次与 AI 表；迁移只补字段，不重置用户状态。
 */
export class ShiyeDB extends Dexie {
  bookmarks!: Table<Bookmark, string>;
  readingItems!: Table<ReadingItem, string>;
  categories!: Table<Category, string>;
  tags!: Table<Tag, string>;
  settings!: Table<SettingsRow, string>;
  policies!: Table<Policy, string>;
  tombstones!: Table<Tombstone, [string, string]>;
  aiTasks!: Table<AiTaskRecord, string>;
  handoffBatches!: Table<HandoffBatchRecord, string>;
  handoffItems!: Table<HandoffItemRecord, [string, number]>;
  appliedChanges!: Table<AppliedChangeRecord, string>;
  importBatches!: Table<ImportBatch, string>;
  importItems!: Table<ImportItem, [string, string]>;
  purgeSnapshots!: Table<PurgeSnapshot, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string = DB_NAME) {
    super(name);

    this.version(1).stores({
      bookmarks: '&id, canonicalUrl, categoryId, createdAt, lastOpenedAt',
      readingItems: '&id, canonicalUrl, status, addedAt',
      categories: '&id, name',
      tags: '&id, name',
      settings: '&key',
    });

    // 版本 2 的表结构写死在这里，不要用 SCHEMA_VERSION：常量会随新版本递增，
    // 一旦共用，升级链上每个版本都会指向同一份最新 schema，迁移就断了。
    this.version(2).stores({
      bookmarks:
        '&id, canonicalUrl, categoryKey, lifeState, [lifeState+unreadFlag], createdAt, lastOpenedAt, localRevision, *tagIds',
      readingItems: '&id, canonicalUrl, status, [status+addedAt], relatedBookmarkId, localRevision',
      categories: '&id, name',
      tags: '&id, name',
      settings: '&key',
      policies: '&id',
      tombstones: '&[entityType+id], deletedAt, canonicalUrl',
      aiTasks: '&id, kind, state, createdAt',
      handoffBatches: '&id, createdAt, status',
      handoffItems: '&[batchId+n], [batchId+bookmarkId], status',
      appliedChanges: '&id, taskId, bookmarkId, appliedAt',
      importBatches: '&id, fileHash, status, createdAt',
      importItems: '&[batchId+sourceKey], entityId',
      meta: '&key',
    });

    this.version(2).upgrade((tx) => migrateV1ToV2(tx));

    // 版本 3 只新增清理快照表，不改动既有记录；不写 upgrade 即为「不迁移数据」。
    this.version(SCHEMA_VERSION).stores({
      bookmarks:
        '&id, canonicalUrl, categoryKey, lifeState, [lifeState+unreadFlag], createdAt, lastOpenedAt, localRevision, *tagIds',
      readingItems: '&id, canonicalUrl, status, [status+addedAt], relatedBookmarkId, localRevision',
      categories: '&id, name',
      tags: '&id, name',
      settings: '&key',
      policies: '&id',
      tombstones: '&[entityType+id], deletedAt, canonicalUrl',
      aiTasks: '&id, kind, state, createdAt',
      handoffBatches: '&id, createdAt, status',
      handoffItems: '&[batchId+n], [batchId+bookmarkId], status',
      appliedChanges: '&id, taskId, bookmarkId, appliedAt',
      importBatches: '&id, fileHash, status, createdAt',
      importItems: '&[batchId+sourceKey], entityId',
      purgeSnapshots: '&id, createdAt, entry',
      meta: '&key',
    });
  }
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 旧库升级：补齐字段、生成派生索引键、移除价值等级。
 * - 已有 inboxUnread 不重置；
 * - 无 inboxUnread 的记录：未分类且未删除 → 未读，其余默认已读；
 * - valueLevel / valueReason 不映射为任何新字段，直接丢弃。
 */
export async function migrateV1ToV2(tx: Transaction): Promise<void> {
  const now = nowIso();
  await tx
    .table('bookmarks')
    .toCollection()
    .modify((record: Record<string, unknown>) => {
      const legacyUrl = asText(record['originalUrl'], asText(record['url']));
      const originalUrl = asText(legacyUrl);
      let canonicalUrl = originalUrl;
      try {
        canonicalUrl = canonicalizeUrl(originalUrl).canonicalUrl;
      } catch {
        canonicalUrl = originalUrl;
      }
      record['originalUrl'] = originalUrl;
      record['canonicalUrl'] = canonicalUrl;
      record['title'] = asText(record['title'], '未命名收藏').slice(0, 300);
      record['sourceDescription'] = asText(
        record['sourceDescription'],
        asText(record['description'])
      );
      record['aiPurpose'] = asText(record['aiPurpose']);
      record['note'] = asText(record['note']);
      record['selectedText'] = asText(record['selectedText']);
      const categoryId = typeof record['categoryId'] === 'string' ? record['categoryId'] : null;
      record['categoryId'] = categoryId;
      record['tagIds'] = Array.isArray(record['tagIds']) ? record['tagIds'] : [];
      record['pinned'] = record['pinned'] === true;
      record['lastOpenedAt'] = toIsoOrNull(record['lastOpenedAt']);
      record['deletedAt'] = toIsoOrNull(record['deletedAt']);
      const deletedAt = record['deletedAt'] as string | null;
      record['inboxUnread'] =
        typeof record['inboxUnread'] === 'boolean'
          ? record['inboxUnread']
          : categoryId === null && deletedAt === null;
      const privacy = (record['privacy'] ?? {}) as Record<string, unknown>;
      record['privacy'] = {
        localOnly: privacy['localOnly'] === true,
        aiBlocked: privacy['aiBlocked'] === true,
      };
      record['lockedFields'] = Array.isArray(record['lockedFields']) ? record['lockedFields'] : [];
      record['sources'] = Array.isArray(record['sources']) ? record['sources'] : [];
      const revision = typeof record['revision'] === 'number' ? record['revision'] : 1;
      record['revision'] = revision;
      record['localRevision'] =
        typeof record['localRevision'] === 'number' ? record['localRevision'] : revision;
      record['changeVersion'] = null;
      record['createdAt'] = toIso(record['createdAt'], now);
      record['updatedAt'] = toIso(record['updatedAt'], asText(record['createdAt'], now));
      record['lifeState'] = deletedAt ? 'deleted' : 'active';
      record['unreadFlag'] = record['inboxUnread'] === true ? 1 : 0;
      record['categoryKey'] = categoryId ?? 'uncategorized';
      delete record['valueLevel'];
      delete record['valueReason'];
      delete record['url'];
      delete record['description'];
      delete record['done'];
    });

  await tx
    .table('readingItems')
    .toCollection()
    .modify((record: Record<string, unknown>) => {
      const originalUrl = asText(record['originalUrl'], asText(record['url']));
      let canonicalUrl = originalUrl;
      try {
        canonicalUrl = canonicalizeUrl(originalUrl).canonicalUrl;
      } catch {
        canonicalUrl = originalUrl;
      }
      record['originalUrl'] = originalUrl;
      record['canonicalUrl'] = canonicalUrl;
      record['title'] = asText(record['title'], '未命名阅读');
      record['note'] = asText(record['note']);
      const legacyDone = record['done'] === true;
      record['status'] = record['status'] === 'completed' || legacyDone ? 'completed' : 'pending';
      record['addedAt'] = toIso(record['addedAt'], now);
      record['completedAt'] = toIsoOrNull(record['completedAt']);
      record['relatedBookmarkId'] =
        typeof record['relatedBookmarkId'] === 'string' ? record['relatedBookmarkId'] : null;
      record['sources'] = Array.isArray(record['sources']) ? record['sources'] : [];
      const revision = typeof record['revision'] === 'number' ? record['revision'] : 1;
      record['revision'] = revision;
      record['localRevision'] =
        typeof record['localRevision'] === 'number' ? record['localRevision'] : revision;
      record['changeVersion'] = null;
      delete record['done'];
      delete record['url'];
    });

  const categories = tx.table('categories');
  await categories.toCollection().modify((record: Record<string, unknown>) => {
    record['name'] = asText(record['name'], '未命名分类');
    record['description'] = asText(record['description'], asText(record['desc']));
    record['revision'] = typeof record['revision'] === 'number' ? record['revision'] : 1;
    record['createdAt'] = toIso(record['createdAt'], now);
    record['updatedAt'] = toIso(record['updatedAt'], now);
    delete record['desc'];
  });

  await tx
    .table('tags')
    .toCollection()
    .modify((record: Record<string, unknown>) => {
      record['name'] = asText(record['name'], '未命名标签');
      record['revision'] = typeof record['revision'] === 'number' ? record['revision'] : 1;
      record['createdAt'] = toIso(record['createdAt'], now);
    });

  await tx.table('meta').put({ key: 'schemaVersion', value: SCHEMA_VERSION });
  await tx.table('meta').put({ key: 'migratedAt', value: now });
}

export function deriveIndexFields(bookmark: Bookmark): Pick<Bookmark, 'lifeState' | 'unreadFlag' | 'categoryKey'> {
  return {
    lifeState: bookmark.deletedAt ? 'deleted' : 'active',
    unreadFlag: bookmark.inboxUnread ? 1 : 0,
    categoryKey: bookmark.categoryId ?? 'uncategorized',
  };
}

export const DEFAULT_SETTINGS = (libraryId: string): AppSettings => {
  const now = nowIso();
  return {
    libraryId,
    pinnedCategoryIds: [],
    includeNoteInSnapshot: true,
    includeTextInSnapshot: false,
    createdAt: now,
    updatedAt: now,
  };
};

export const DEFAULT_POLICY = (): Policy => ({
  id: 'default',
  policyVersion: 1,
  revision: 1,
  instruction:
    '优先按用途归类；保留人工锁定；用途描述具体到能判断它为什么被收藏；信息不足时保持未分类，不编造正文，不依据年代建议删除。',
  examples: [],
  updatedAt: nowIso(),
});
