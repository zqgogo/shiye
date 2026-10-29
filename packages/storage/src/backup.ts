import {
  AppError,
  SCHEMA_VERSION,
  canonicalizeUrl,
  clampForStorage,
  LIMITS,
  newId,
  nowIso,
  toIso,
  toIsoOrNull,
} from '@shiye/core';
import type {
  BackupDocument,
  Bookmark,
  Category,
  Policy,
  ReadingItem,
  Tag,
  Tombstone,
} from '@shiye/core';
import type { BackupRepository, RestoreResult } from '@shiye/application';
import { ShiyeDB, DEFAULT_POLICY, deriveIndexFields } from './db.js';

type Raw = Record<string, unknown>;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sanitizeBookmark(raw: Raw, warnings: Set<string>): Bookmark | null {
  const originalUrl = str(raw['originalUrl'], str(raw['url']));
  let canonicalUrl = str(raw['canonicalUrl'], '');
  try {
    canonicalUrl = canonicalizeUrl(originalUrl).canonicalUrl;
  } catch {
    if (!canonicalUrl) return null;
  }
  if (!canonicalUrl) return null;
  const id = str(raw['id'], '');
  if (!id) return null;
  const deletedAt = toIsoOrNull(raw['deletedAt']);
  const categoryId = typeof raw['categoryId'] === 'string' ? raw['categoryId'] : null;
  if (raw['valueLevel'] !== undefined || raw['valueReason'] !== undefined) {
    warnings.add('备份包含旧价值等级字段，已按 v2 规则忽略。');
  }
  const rawTitle = str(raw['title'], str(raw['description'], ''));
  const title = clampForStorage(rawTitle || '未命名收藏', LIMITS.title);
  if ([...(rawTitle || '')].length > LIMITS.title) {
    warnings.add('部分标题超过长度上限，已截断。');
  }
  const privacyRaw = (raw['privacy'] ?? {}) as Raw;
  const sourceDescription = clampForStorage(
    str(raw['sourceDescription'], str(raw['description'])),
    LIMITS.sourceDescription
  );
  const note = clampForStorage(str(raw['note']), LIMITS.note);
  const selectedText = clampForStorage(str(raw['selectedText']), LIMITS.selectedText);
  const now = nowIso();
  const inboxUnread =
    typeof raw['inboxUnread'] === 'boolean'
      ? raw['inboxUnread']
      : categoryId === null && deletedAt === null;
  const bookmark: Bookmark = {
    id,
    originalUrl,
    canonicalUrl,
    title,
    sourceDescription,
    aiPurpose: clampForStorage(str(raw['aiPurpose']), LIMITS.aiPurpose),
    note,
    selectedText,
    categoryId,
    tagIds: arr(raw['tagIds']).filter((value): value is string => typeof value === 'string'),
    inboxUnread,
    pinned: bool(raw['pinned']),
    lastOpenedAt: toIsoOrNull(raw['lastOpenedAt']),
    privacy: { localOnly: bool(privacyRaw['localOnly']), aiBlocked: bool(privacyRaw['aiBlocked']) },
    lockedFields: arr(raw['lockedFields']).filter(
      (value): value is 'categoryId' | 'tagIds' | 'aiPurpose' =>
        value === 'categoryId' || value === 'tagIds' || value === 'aiPurpose'
    ),
    sources: arr(raw['sources']).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const sourceRaw = entry as Raw;
      const sourceType = str(sourceRaw['sourceType'], 'json');
      if (!['extension', 'manual', 'html', 'json'].includes(sourceType)) return [];
      return [
        {
          sourceType: sourceType as 'extension' | 'manual' | 'html' | 'json',
          capturedAt: toIso(sourceRaw['capturedAt'], now),
        },
      ];
    }),
    revision: num(raw['revision']),
    localRevision: num(raw['localRevision'], num(raw['revision'])),
    changeVersion: null,
    createdAt: toIso(raw['createdAt'], now),
    updatedAt: toIso(raw['updatedAt'], now),
    deletedAt,
    lifeState: deletedAt ? 'deleted' : 'active',
    unreadFlag: inboxUnread ? 1 : 0,
    categoryKey: categoryId ?? 'uncategorized',
  };
  return bookmark;
}

function sanitizeReading(raw: Raw): ReadingItem | null {
  const originalUrl = str(raw['originalUrl'], str(raw['url']));
  let canonicalUrl = str(raw['canonicalUrl'], '');
  try {
    canonicalUrl = canonicalizeUrl(originalUrl).canonicalUrl;
  } catch {
    if (!canonicalUrl) return null;
  }
  const id = str(raw['id'], '');
  if (!id || !canonicalUrl) return null;
  const now = nowIso();
  const completedAt = toIsoOrNull(raw['completedAt']);
  const status = raw['status'] === 'completed' || Boolean(completedAt) ? 'completed' : 'pending';
  return {
    id,
    originalUrl,
    canonicalUrl,
    title: clampForStorage(str(raw['title'], '未命名阅读'), LIMITS.title),
    note: clampForStorage(str(raw['note']), LIMITS.note),
    status,
    addedAt: toIso(raw['addedAt'], now),
    completedAt: status === 'completed' ? completedAt ?? now : null,
    relatedBookmarkId: typeof raw['relatedBookmarkId'] === 'string' ? raw['relatedBookmarkId'] : null,
    sources: [],
    revision: num(raw['revision']),
    localRevision: num(raw['localRevision'], num(raw['revision'])),
    changeVersion: null,
  };
}

function sanitizeCategory(raw: Raw): Category | null {
  const id = str(raw['id']);
  const name = clampForStorage(str(raw['name'], '未命名分类'), LIMITS.categoryName);
  if (!id || !name) return null;
  return {
    id,
    name,
    description: str(raw['description'], str(raw['desc'])),
    revision: num(raw['revision']),
    createdAt: toIso(raw['createdAt'], nowIso()),
    updatedAt: toIso(raw['updatedAt'], nowIso()),
  };
}

function sanitizeTag(raw: Raw): Tag | null {
  const id = str(raw['id']);
  const name = clampForStorage(str(raw['name']), LIMITS.tagName);
  if (!id || !name) return null;
  return { id, name, revision: num(raw['revision']), createdAt: toIso(raw['createdAt'], nowIso()) };
}

function sanitizeTombstone(raw: Raw): Tombstone | null {
  const id = str(raw['id']);
  const entityType = str(raw['entityType'], 'bookmark');
  if (!id) return null;
  if (!['bookmark', 'readingItem', 'category', 'tag', 'policy'].includes(entityType)) return null;
  return {
    entityType: entityType as Tombstone['entityType'],
    id,
    revision: num(raw['revision']),
    changeVersion: null,
    deletedAt: toIso(raw['deletedAt'], nowIso()),
    privacyScope: raw['privacyScope'] === 'local' ? 'local' : 'main',
    ...(typeof raw['canonicalUrl'] === 'string' ? { canonicalUrl: raw['canonicalUrl'] } : {}),
    ...(typeof raw['title'] === 'string' ? { title: raw['title'] } : {}),
  };
}

export function createBackupRepository(db: ShiyeDB): BackupRepository {
  return {
    async exportDocument({ includeLocalOnly }): Promise<BackupDocument> {
      return db.transaction(
        'r',
        [
          db.bookmarks,
          db.readingItems,
          db.categories,
          db.tags,
          db.tombstones,
          db.settings,
          db.policies,
        ],
        async () => {
          const exportedAt = nowIso();
          const settingsRow = await db.settings.get('app');
          const [categories, tags, policy, bookmarks, readingItems, tombstones] = await Promise.all([
            db.categories.toArray(),
            db.tags.toArray(),
            db.policies.get('default'),
            db.bookmarks.toArray(),
            db.readingItems.toArray(),
            db.tombstones.toArray(),
          ]);
          const settings = settingsRow?.value as BackupDocument['settings'];
          return {
            schemaVersion: SCHEMA_VERSION,
            libraryId: settings?.libraryId ?? 'local-library',
            exportedAt,
            dataCutoffAt: exportedAt,
            scope: 'device',
            includesLocalOnly: includeLocalOnly,
            categories,
            tags,
            // 从没打开过策略页时库里没有 default 行，导出的是「此刻生效的默认策略」，
            // 否则备份会写着 policy: null，恢复后说不清当时用的是哪一版。
            policy: policy ?? DEFAULT_POLICY(),
            settings: settings ?? null,
            bookmarks: includeLocalOnly
              ? bookmarks
              : bookmarks.filter((bookmark) => !bookmark.privacy.localOnly),
            readingItems,
            tombstones: includeLocalOnly
              ? tombstones
              : tombstones.filter((tombstone) => tombstone.privacyScope !== 'local'),
          };
        }
      );
    },

    async listTombstones(): Promise<Tombstone[]> {
      return db.tombstones.toArray();
    },

    async restore(document: BackupDocument, mode: 'merge' | 'replace'): Promise<RestoreResult> {
      if (document.schemaVersion > SCHEMA_VERSION) {
        throw new AppError('UNSUPPORTED_VERSION', '备份来自更新版本，请先升级扩展。');
      }
      const warnings = new Set<string>();
      const categories = document.categories
        .map((raw) => sanitizeCategory(raw as unknown as Raw))
        .filter((row): row is Category => row !== null);
      const tags = document.tags
        .map((raw) => sanitizeTag(raw as unknown as Raw))
        .filter((row): row is Tag => row !== null);
      const bookmarks = document.bookmarks
        .map((raw) => sanitizeBookmark(raw as unknown as Raw, warnings))
        .filter((row): row is Bookmark => row !== null);
      const readingItems = document.readingItems
        .map((raw) => sanitizeReading(raw as unknown as Raw))
        .filter((row): row is ReadingItem => row !== null);
      const tombstones = (document.tombstones ?? [])
        .map((raw) => sanitizeTombstone(raw as unknown as Raw))
        .filter((row): row is Tombstone => row !== null);

      // 备份可能来自另一台设备或只恢复了部分数据：引用到不存在的分类/标签时清空，
      // 否则恢复后会出现指向空气的条目，「未分类」计数与分类页都会对不上。
      const knownCategories = new Set(categories.map((row) => row.id));
      const knownTags = new Set(tags.map((row) => row.id));
      let danglingReferences = 0;
      for (const bookmark of bookmarks) {
        if (bookmark.categoryId && !knownCategories.has(bookmark.categoryId)) {
          bookmark.categoryId = null;
          danglingReferences += 1;
        }
        const keptTags = bookmark.tagIds.filter((id) => knownTags.has(id));
        if (keptTags.length !== bookmark.tagIds.length) {
          danglingReferences += bookmark.tagIds.length - keptTags.length;
          bookmark.tagIds = keptTags;
        }
        Object.assign(bookmark, deriveIndexFields(bookmark));
      }
      if (danglingReferences > 0) {
        warnings.add(`有 ${danglingReferences} 处引用指向本次未恢复的分类或标签，已清空这些引用。`);
      }

      if (document.schemaVersion < SCHEMA_VERSION) {
        warnings.add(`备份为旧版格式（v${document.schemaVersion}），已显式迁移到 v${SCHEMA_VERSION}。`);
      }
      if (!document.tombstones) {
        warnings.add('备份不包含墓碑，删除记录可能被旧数据重新带回；已按现有删除状态处理。');
      }
      if (!document.includesLocalOnly) {
        warnings.add('备份未包含本地专用条目，这部分内容不会恢复。');
      }

      const result: RestoreResult = {
        mode,
        bookmarksAdded: 0,
        bookmarksSkipped: 0,
        readingAdded: 0,
        categoriesAdded: 0,
        tagsAdded: 0,
        tombstonesAdded: 0,
        danglingReferences,
        handoffInvalidated: 0,
        librarySwitch: null,
        warnings: [...warnings],
      };

      await db.transaction(
        'rw',
        [
          db.bookmarks,
          db.readingItems,
          db.categories,
          db.tags,
          db.tombstones,
          db.settings,
          db.policies,
          db.importBatches,
          db.importItems,
          db.handoffBatches,
          db.handoffItems,
          db.appliedChanges,
          db.aiTasks,
          db.meta,
        ],
        async () => {
          const beforeSettings = await db.settings.get('app');
          const beforeLibraryId = str((beforeSettings?.value as Raw)?.['libraryId'], '');
          if (mode === 'replace') {
            // 替换前先记下会被作废的在途批次：旧主库的编号映射对新主库没有意义，
            // 留着会让「继续这一批」把建议应用到同 ID 的另一条记录上。
            result.handoffInvalidated = await db.handoffBatches.count();
            await Promise.all([
              db.bookmarks.clear(),
              db.readingItems.clear(),
              db.categories.clear(),
              db.tags.clear(),
              db.tombstones.clear(),
              db.importBatches.clear(),
              db.importItems.clear(),
              db.handoffBatches.clear(),
              db.handoffItems.clear(),
              db.appliedChanges.clear(),
              db.aiTasks.clear(),
            ]);
          }

          for (const category of categories) {
            const existing = await db.categories.get(category.id);
            if (!existing || mode === 'replace') {
              await db.categories.put(category);
              result.categoriesAdded += 1;
            }
          }
          for (const tag of tags) {
            const existing = await db.tags.get(tag.id);
            if (!existing || mode === 'replace') {
              await db.tags.put(tag);
              result.tagsAdded += 1;
            }
          }

          for (const bookmark of bookmarks) {
            const existing = await db.bookmarks.get(bookmark.id);
            if (existing && mode === 'merge') {
              if (existing.localRevision >= bookmark.localRevision) {
                result.bookmarksSkipped += 1;
                continue;
              }
            }
            const sameUrl = await db.bookmarks
              .where('canonicalUrl')
              .equals(bookmark.canonicalUrl)
              .filter((row) => row.id !== bookmark.id && !row.deletedAt)
              .first();
            if (sameUrl && mode === 'merge') {
              result.bookmarksSkipped += 1;
              warnings.add('有收藏与现有记录网址相同，合并时跳过。');
              continue;
            }
            Object.assign(bookmark, deriveIndexFields(bookmark));
            await db.bookmarks.put(bookmark);
            result.bookmarksAdded += 1;
          }

          for (const item of readingItems) {
            const existing = await db.readingItems.get(item.id);
            if (existing && mode === 'merge' && existing.status === item.status) {
              continue;
            }
            if (existing && mode === 'merge' && existing.status === 'pending') {
              continue;
            }
            await db.readingItems.put(item);
            result.readingAdded += 1;
          }

          for (const tombstone of tombstones) {
            await db.tombstones.put(tombstone);
            result.tombstonesAdded += 1;
          }

          const incomingSettings =
            document.settings && typeof document.settings === 'object'
              ? (document.settings as unknown as Raw)
              : null;
          const currentRow = await db.settings.get('app');
          const currentSettings = (currentRow?.value as Raw) ?? null;
          if (mode === 'replace' || !currentRow) {
            const base = incomingSettings ?? currentSettings ?? {};
            if (!incomingSettings && mode === 'replace') {
              warnings.add('备份不含设置，已保留当前设备的显示设置，并采用备份中的主库身份。');
            }
            // 身份以信封顶层的 libraryId 为准：settings 里的那份可能被手改或来自旧格式，
            // 而顶层字段是导出时写死的主库标识，恢复后要靠它判断「是不是同一份库」。
            const identity = str(document.libraryId, '') || str(base['libraryId'], '') || newId();
            await db.settings.put({
              key: 'app',
              value: {
                ...base,
                libraryId: identity,
                pinnedCategoryIds: arr(base['pinnedCategoryIds']).filter(
                  (value): value is string => typeof value === 'string'
                ),
              },
            });
          }
          if (mode === 'replace') {
            const policy = document.policy as unknown as Policy | null | undefined;
            if (policy) {
              await db.policies.put({
                ...policy,
                id: 'default',
                examples: Array.isArray(policy.examples) ? policy.examples : [],
              });
            } else {
              // 替换是「让主库变回备份那一刻」：备份没有策略就该回到默认策略，
              // 否则本机旧策略会悄悄影响接下来的整理版本号。
              await db.policies.put(DEFAULT_POLICY());
              warnings.add('备份不含整理策略，已重置为默认策略。');
            }
          }

          const afterSettings = await db.settings.get('app');
          const afterLibraryId = str((afterSettings?.value as Raw)?.['libraryId'], '');
          if (mode === 'replace' && beforeLibraryId && afterLibraryId && beforeLibraryId !== afterLibraryId) {
            result.librarySwitch = { from: beforeLibraryId, to: afterLibraryId };
          }
          if (result.handoffInvalidated > 0) {
            warnings.add(
              `替换已作废 ${result.handoffInvalidated} 个在途 AI 交接批次；旧主库的编号映射不再可用，请勿回到旧库继续整理。`
            );
          }

          await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION });
          await db.meta.put({ key: 'lastRestoreAt', value: nowIso() });
        }
      );

      result.warnings = [...warnings];
      return result;
    },
  };
}
