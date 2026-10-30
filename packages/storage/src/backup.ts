import {
  AppError,
  SCHEMA_VERSION,
  clampForStorage,
  LIMITS,
  newId,
  nowIso,
  toIso,
  toIsoOrNull,
  tryCanonicalizeUrl,
  truncateMiddle,
} from '@shiye/core';
import type {
  BackupDocument,
  Bookmark,
  Category,
  Policy,
  ReadingItem,
  SourceInfo,
  Tag,
  Tombstone,
} from '@shiye/core';
import type { BackupRepository, RestoreResult, SafetyCopy } from '@shiye/application';
import { ShiyeDB, DEFAULT_POLICY, deriveIndexFields } from './db.js';

type Raw = Record<string, unknown>;

/** 一条记录被拒的原因：收集起来一次性告诉用户，而不是 filter 掉之后静默。 */
type Reject = (reason: string) => void;

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

/**
 * 网址只认「原始链接重新解析」的结果。
 *
 * 备份里的 canonicalUrl 是派生字段：如果直接采信它，一条 javascript: 链接配上一个
 * 合法的 canonicalUrl 就能通过校验进入主库，界面再把它渲染成可点的 href。
 */
function urlPair(
  raw: Raw,
  reject: Reject
): { originalUrl: string; canonicalUrl: string } | null {
  const originalUrl = str(raw['originalUrl'], str(raw['url']));
  if (!originalUrl) {
    reject('缺少网址');
    return null;
  }
  const checked = tryCanonicalizeUrl(originalUrl);
  if (!checked) {
    reject(`网址不是有效的 http / https 链接（${truncateMiddle(originalUrl, 48)}）`);
    return null;
  }
  return { originalUrl: checked.originalUrl, canonicalUrl: checked.canonicalUrl };
}

/** 来源信息按 SourceInfo 白名单逐字段还原：目录与导入批次是用户能看见的历史。 */
function sanitizeSource(entry: unknown, now: string): SourceInfo | null {
  if (!entry || typeof entry !== 'object') return null;
  const sourceRaw = entry as Raw;
  const sourceType = str(sourceRaw['sourceType'], 'json');
  if (!['extension', 'manual', 'html', 'json'].includes(sourceType)) return null;
  const source: SourceInfo = {
    sourceType: sourceType as SourceInfo['sourceType'],
    capturedAt: toIso(sourceRaw['capturedAt'], now),
  };
  const batchId = str(sourceRaw['importBatchId'], '');
  if (batchId) source.importBatchId = batchId.slice(0, 64);
  const folder = str(sourceRaw['originalFolder'], '');
  if (folder) source.originalFolder = clampForStorage(folder, 1000);
  return source;
}

function sanitizeBookmark(raw: Raw, reject: Reject, warnings: Set<string>): Bookmark | null {
  const id = str(raw['id'], '');
  if (!id) {
    reject('缺少编号（id）');
    return null;
  }
  const pair = urlPair(raw, reject);
  if (!pair) return null;
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
    originalUrl: pair.originalUrl,
    canonicalUrl: pair.canonicalUrl,
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
      const source = sanitizeSource(entry, now);
      return source ? [source] : [];
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

function sanitizeReading(raw: Raw, reject: Reject): ReadingItem | null {
  const id = str(raw['id'], '');
  if (!id) {
    reject('缺少编号（id）');
    return null;
  }
  const pair = urlPair(raw, reject);
  if (!pair) return null;
  const now = nowIso();
  const completedAt = toIsoOrNull(raw['completedAt']);
  const status = raw['status'] === 'completed' || Boolean(completedAt) ? 'completed' : 'pending';
  return {
    id,
    originalUrl: pair.originalUrl,
    canonicalUrl: pair.canonicalUrl,
    title: clampForStorage(str(raw['title'], '未命名阅读'), LIMITS.title),
    note: clampForStorage(str(raw['note']), LIMITS.note),
    status,
    addedAt: toIso(raw['addedAt'], now),
    completedAt: status === 'completed' ? completedAt ?? now : null,
    relatedBookmarkId: typeof raw['relatedBookmarkId'] === 'string' ? raw['relatedBookmarkId'] : null,
    sources: arr(raw['sources']).flatMap((entry) => {
      const source = sanitizeSource(entry, now);
      return source ? [source] : [];
    }),
    revision: num(raw['revision']),
    localRevision: num(raw['localRevision'], num(raw['revision'])),
    changeVersion: null,
  };
}

function sanitizeCategory(raw: Raw, reject: Reject): Category | null {
  const id = str(raw['id']);
  const name = clampForStorage(str(raw['name'], '未命名分类'), LIMITS.categoryName);
  if (!id) {
    reject('缺少编号（id）');
    return null;
  }
  if (!name) {
    reject('缺少名称');
    return null;
  }
  return {
    id,
    name,
    description: str(raw['description'], str(raw['desc'])),
    revision: num(raw['revision']),
    createdAt: toIso(raw['createdAt'], nowIso()),
    updatedAt: toIso(raw['updatedAt'], nowIso()),
  };
}

function sanitizeTag(raw: Raw, reject: Reject): Tag | null {
  const id = str(raw['id']);
  const name = clampForStorage(str(raw['name']), LIMITS.tagName);
  if (!id) {
    reject('缺少编号（id）');
    return null;
  }
  if (!name) {
    reject('缺少名称');
    return null;
  }
  return { id, name, revision: num(raw['revision']), createdAt: toIso(raw['createdAt'], nowIso()) };
}

function sanitizeTombstone(raw: Raw, reject: Reject): Tombstone | null {
  const id = str(raw['id']);
  const entityType = str(raw['entityType'], 'bookmark');
  if (!id) {
    reject('缺少编号（id）');
    return null;
  }
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

const SAFETY_COPY_KEY = 'safetyBackup';

/** meta 里的安全副本既可能是新格式（带编号），也可能是旧格式（只有文本），统一读出来。 */
function safetyCopyOf(row: { value: unknown } | undefined): SafetyCopy | null {
  const value = row?.value as Raw | undefined;
  const text = str(value?.['text'], '');
  if (!text) return null;
  const id = str(value?.['id'], '');
  return {
    // 旧格式没有编号：给一个稳定的占位符，按编号清理时仍然能对上它自己。
    id: id || 'legacy-safety-copy',
    text,
    savedAt: str(value?.['savedAt'], ''),
  };
}

/** 一份备份清洗后的结果：写入与「只校验」两条路径共用同一套判定。 */interface PreparedRestore {
  categories: Category[];
  tags: Tag[];
  bookmarks: Bookmark[];
  readingItems: ReadingItem[];
  tombstones: Tombstone[];
  /** 逐条被拒的原因；replace 模式下任意一条都会让整次替换停下。 */
  issues: string[];
  warnings: string[];
  danglingReferences: number;
}

function invalidBackupError(issues: string[]): AppError {
  const preview = issues.slice(0, 3).join('；');
  const rest = issues.length > 3 ? ` 等 ${issues.length} 条` : '';
  return new AppError(
    'INVALID_BACKUP_RECORDS',
    `备份里有条目无法恢复（${preview}${rest}）。替换会清空当前主库，已停止，数据未改动。请回原环境重新导出，或改用「合并」逐条跳过。`
  );
}

/**
 * 清洗并裁决整份备份，不写任何一张表。
 *
 * restore 与 validateRestore 都走这里：界面要在覆盖安全副本之前拿到同一个结论，
 * 两套判定各写一遍迟早会分叉。
 */
function prepareRestore(document: BackupDocument): PreparedRestore {
  if (document.schemaVersion > SCHEMA_VERSION) {
    throw new AppError('UNSUPPORTED_VERSION', '备份来自更新版本，请先升级扩展。');
  }
  const warnings = new Set<string>();
  const issues: string[] = [];

  /** 逐条清洗并收集被拒原因：静默 filter 会让「恢复成功」变成假象。 */
  const collect = <T>(
    rows: unknown[],
    label: string,
    sanitize: (raw: Raw, reject: Reject) => T | null
  ): T[] => {
    const out: T[] = [];
    rows.forEach((raw, index) => {
      const value = sanitize(
        (raw ?? {}) as Raw,
        (reason) => issues.push(`${label}第 ${index + 1} 条${reason}`)
      );
      if (value !== null) out.push(value);
    });
    return out;
  };

  const categories = collect(document.categories, '分类', (raw, reject) =>
    sanitizeCategory(raw, reject)
  );
  const tags = collect(document.tags, '标签', (raw, reject) => sanitizeTag(raw, reject));
  const bookmarks = collect(document.bookmarks, '收藏', (raw, reject) =>
    sanitizeBookmark(raw, reject, warnings)
  );
  const readingItems = collect(document.readingItems, '待看', (raw, reject) =>
    sanitizeReading(raw, reject)
  );
  const tombstones = collect(document.tombstones ?? [], '墓碑', (raw, reject) =>
    sanitizeTombstone(raw, reject)
  );

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
  if (document.exclusions?.readingForLocalOnly) {
    warnings.add(
      `导出时排除了 ${document.exclusions.readingForLocalOnly} 条关联本地专用收藏的待看，恢复后不会有这些。`
    );
  }

  return {
    categories,
    tags,
    bookmarks,
    readingItems,
    tombstones,
    issues,
    warnings: [...warnings],
    danglingReferences,
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
          const localOnlyBookmarkIds = new Set(
            bookmarks.filter((bookmark) => bookmark.privacy.localOnly).map((bookmark) => bookmark.id)
          );
          // 待看没有自己的隐私字段，但它可能是「加入待看」从某条收藏复制出来的（带
          // relatedBookmarkId，标题与网址都一样）。收藏被排除而待看照样导出，
          // 本地专用就会从这条缝里漏出去。
          //
          // 关联编号并不可靠：重新激活一条已完成待看、跨设备恢复、或先独立加入待看再把
          // 同网址收藏设成本地专用，都会留下 relatedBookmarkId 为空或指向别处的记录。
          // 所以再按网址核对一次；回收站里的本地专用收藏同样计入（宁可少导出，不漏）。
          const localOnlyCanonical = new Set(
            bookmarks
              .filter((bookmark) => bookmark.privacy.localOnly)
              .map((bookmark) => bookmark.canonicalUrl)
          );
          const exportedReading = includeLocalOnly
            ? readingItems
            : readingItems.filter((item) => {
                if (item.relatedBookmarkId && localOnlyBookmarkIds.has(item.relatedBookmarkId)) {
                  return false;
                }
                return !localOnlyCanonical.has(item.canonicalUrl);
              });
          const excludedReading = readingItems.length - exportedReading.length;
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
            readingItems: exportedReading,
            tombstones: includeLocalOnly
              ? tombstones
              : tombstones.filter((tombstone) => tombstone.privacyScope !== 'local'),
            ...(excludedReading > 0
              ? { exclusions: { readingForLocalOnly: excludedReading } }
              : {}),
          };
        }
      );
    },

    async listTombstones(): Promise<Tombstone[]> {
      return db.tombstones.toArray();
    },

    /**
     * 替换前的安全备份不能只活在内存里：替换一旦提交就不可撤销，
     * 而下载可能被拦、被取消，或者页面直接被关掉。
     *
     * 但「存下来」不等于「已交付」：上一份还没确认保存时，这一份不许覆盖它。
     * 否则连着做两次替换，第一份（往往才是原始数据）就被第二份顶掉了。
     */
    async saveSafetyCopy(text: string): Promise<SafetyCopy> {
      return db.transaction('rw', db.meta, async () => {
        const existing = safetyCopyOf(await db.meta.get(SAFETY_COPY_KEY));
        if (existing) {
          throw new AppError(
            'SAFETY_COPY_PENDING',
            `本机还留着一份 ${existing.savedAt} 的替换前安全备份，尚未确认保存。请先把它保存到磁盘并清理本机副本，再做下一次替换。`
          );
        }
        const copy: SafetyCopy = { id: newId(), text, savedAt: nowIso() };
        await db.meta.put({ key: SAFETY_COPY_KEY, value: copy });
        return copy;
      });
    },

    async readSafetyCopy(): Promise<SafetyCopy | null> {
      return safetyCopyOf(await db.meta.get(SAFETY_COPY_KEY));
    },

    async clearSafetyCopy(id: string): Promise<void> {
      await db.transaction('rw', db.meta, async () => {
        const existing = safetyCopyOf(await db.meta.get(SAFETY_COPY_KEY));
        // 编号对不上说明这份已经被替换或清理过：旧标签页的按钮不该动新副本。
        if (!existing || existing.id !== id) return;
        await db.meta.delete(SAFETY_COPY_KEY);
      });
    },

    async validateRestore(document: BackupDocument, mode: 'merge' | 'replace'): Promise<void> {
      const prepared = prepareRestore(document);
      if (mode === 'replace' && prepared.issues.length > 0) {
        throw invalidBackupError(prepared.issues);
      }
    },

    async restore(document: BackupDocument, mode: 'merge' | 'replace'): Promise<RestoreResult> {
      const prepared = prepareRestore(document);
      const { categories, tags, bookmarks, readingItems, tombstones } = prepared;
      const issues = prepared.issues;
      const warnings = new Set<string>(prepared.warnings);
      const danglingReferences = prepared.danglingReferences;

      if (issues.length > 0) {
        const preview = issues.slice(0, 3).join('；');
        const rest = issues.length > 3 ? ` 等 ${issues.length} 条` : '';
        if (mode === 'replace') {
          // 替换会先清空主库：带着无法恢复的记录提交，结果就是「显示成功、数据没了」。
          throw invalidBackupError(issues);
        }
        warnings.add(`备份里有条目无法恢复，已跳过：${preview}${rest}`);
      }

      const result: RestoreResult = {
        mode,
        bookmarksAdded: 0,
        bookmarksSkipped: 0,
        readingAdded: 0,
        readingSkipped: 0,
        categoriesAdded: 0,
        tagsAdded: 0,
        tombstonesAdded: 0,
        danglingReferences,
        handoffInvalidated: 0,
        librarySwitch: null,
        keptLocalDeletes: 0,
        adoptedSettings: false,
        excludedReading: document.exclusions?.readingForLocalOnly ?? 0,
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

          // 「当前主库为空吗」必须在写入任何一条之前问：写完分类再问，答案永远是否。
          const freshLibrary =
            (await db.bookmarks.count()) === 0 &&
            (await db.readingItems.count()) === 0 &&
            (await db.categories.count()) === 0 &&
            (await db.tags.count()) === 0;
          const adoptSettings = mode === 'replace' || freshLibrary;

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
            if (mode === 'merge') {
              // 合并只新增：文档承诺「同 ID 保留本机现有版本」。localRevision 是各自的
              // 写入次数，跨设备比较没有意义，用它决定胜负会覆盖本机的人工修改。
              if (existing) {
                result.bookmarksSkipped += 1;
                if (existing.deletedAt && !bookmark.deletedAt) result.keptLocalDeletes += 1;
                continue;
              }
              // 同一条网址在本机可能挂着另一个编号的记录（两台设备各自收藏过同一个页面）。
              // 普通创建路径遇到同网址会要求明确恢复，合并不能因为「编号不同」就绕过去。
              const sameUrlRows = await db.bookmarks
                .where('canonicalUrl')
                .equals(bookmark.canonicalUrl)
                .toArray();
              if (sameUrlRows.some((row) => !row.deletedAt)) {
                result.bookmarksSkipped += 1;
                warnings.add('有收藏与现有记录网址相同，合并时跳过；需要合并内容请在本机单独处理。');
                continue;
              }
              // 本机删过、实体已被清掉只剩墓碑，或只剩删除留下的墓碑：都不能被备份复活。
              const localTombstone =
                (await db.tombstones.get(['bookmark', bookmark.id])) ??
                (await db.tombstones.where('canonicalUrl').equals(bookmark.canonicalUrl).first());
              if (!bookmark.deletedAt && (sameUrlRows.length > 0 || localTombstone)) {
                result.bookmarksSkipped += 1;
                result.keptLocalDeletes += 1;
                continue;
              }
            }
            Object.assign(bookmark, deriveIndexFields(bookmark));
            await db.bookmarks.put(bookmark);
            result.bookmarksAdded += 1;
            if (bookmark.deletedAt) {
              // 删除态必须同时留墓碑：否则同一条网址之后能被静默重新创建，
              // 回收站里也找不到这次删除。
              await db.tombstones.put({
                entityType: 'bookmark',
                id: bookmark.id,
                revision: bookmark.revision,
                changeVersion: null,
                deletedAt: bookmark.deletedAt,
                privacyScope: bookmark.privacy.localOnly ? 'local' : 'main',
                canonicalUrl: bookmark.canonicalUrl,
                title: bookmark.title,
              });
            } else {
              // 活跃条目与同 ID 墓碑不能并存，否则「已删除」与「在库里」同时成立。
              await db.tombstones.delete(['bookmark', bookmark.id]);
            }
          }
          if (result.keptLocalDeletes > 0) {
            warnings.add(
              `有 ${result.keptLocalDeletes} 条收藏在备份里仍是活跃状态，但本机已删除，已保留本机的删除；需要找回请到回收站单独恢复。`
            );
          }

          /** 同一条网址只留一条待看：普通新增路径本来就拒绝重复，恢复不能破例。 */
          const pendingUrls = new Set<string>();
          if (mode === 'merge') {
            for (const row of await db.readingItems.toArray()) {
              if (!row.completedAt) pendingUrls.add(row.canonicalUrl);
            }
          }
          for (const item of readingItems) {
            if (pendingUrls.has(item.canonicalUrl)) {
              result.readingSkipped += 1;
              continue;
            }
            const existing = await db.readingItems.get(item.id);
            if (mode === 'merge' && existing) {
              // 本机同 ID 已有这条：已完成的不会被降级回待看，已存在的也不覆盖。
              result.readingSkipped += 1;
              continue;
            }
            await db.readingItems.put(item);
            result.readingAdded += 1;
            if (!item.completedAt) pendingUrls.add(item.canonicalUrl);
          }
          if (result.readingSkipped > 0) {
            warnings.add(
              `有 ${result.readingSkipped} 条待看因为同一条网址已经存在（或本机已有同编号记录）而跳过。`
            );
          }

          // 墓碑与「在库里」不能并存。判据必须是事务里最终的活跃实体，而不是备份数组：
          // 备份里可能只有墓碑、没有对应收藏，那条收藏在本机仍然活跃。
          let conflictingTombstones = 0;
          for (const tombstone of tombstones) {
            if (tombstone.entityType === 'bookmark') {
              const live = await db.bookmarks.get(tombstone.id);
              if (live && !live.deletedAt) {
                conflictingTombstones += 1;
                continue;
              }
            }
            await db.tombstones.put(tombstone);
            result.tombstonesAdded += 1;
          }
          if (conflictingTombstones > 0) {
            warnings.add(
              `备份里有 ${conflictingTombstones} 条墓碑对应本次恢复为活跃的收藏，已忽略这些墓碑。`
            );
          }

          // 空库合并（换新设备的默认选择）应当等于一次完整导入：库里没有可被覆盖的东西，
          // 设置与整理策略都该跟着备份走，否则用户会以为「恢复完成」却还在用默认策略。
          const incomingSettings =
            document.settings && typeof document.settings === 'object'
              ? (document.settings as unknown as Raw)
              : null;
          const currentRow = await db.settings.get('app');
          const currentSettings = (currentRow?.value as Raw) ?? null;
          if (adoptSettings) {
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
          const policy = document.policy as unknown as Policy | null | undefined;
          if (policy && adoptSettings) {
            // 空库合并也写：换新设备默认选「合并」，不跟着备份走就会一直用默认策略整理。
            await db.policies.put({
              ...policy,
              id: 'default',
              examples: Array.isArray(policy.examples) ? policy.examples : [],
            });
            if (mode === 'merge') {
              warnings.add('当前主库为空，已按首次迁移恢复整理策略与显示设置。');
            }
          } else if (mode === 'replace') {
            // 替换是「让主库变回备份那一刻」：备份没有策略就该回到默认策略，
            // 否则本机旧策略会悄悄影响接下来的整理版本号。
            await db.policies.put(DEFAULT_POLICY());
            warnings.add('备份不含整理策略，已重置为默认策略。');
          }
          result.adoptedSettings = adoptSettings;

          const afterSettings = await db.settings.get('app');
          const afterLibraryId = str((afterSettings?.value as Raw)?.['libraryId'], '');
          if (adoptSettings && beforeLibraryId && afterLibraryId && beforeLibraryId !== afterLibraryId) {
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
