import Dexie from 'dexie';
import {
  AppError,
  BookmarkPatchSchema,
  LIMITS,
  canonicalizeUrl,
  fallbackTitle,
  newId,
  nowIso,
  optionalText,
  requireText,
} from '@shiye/core';
import type {
  AIField,
  AISuggestionPatch,
  AppliedChange,
  Bookmark,
  BookmarkPatch,
  Category,
  HandoffBatch,
  HandoffBatchStatus,
  HandoffItem,
  ImportBatch,
  ImportItem,
  ImportRow,
  ImportUndoItem,
  ImportUndoReason,
  Policy,
  PurgeCounts,
  PurgeRestorePreview,
  PurgeSnapshot,
  ReadingItem,
  SourceInfo,
  Tag,
  Tombstone,
} from '@shiye/core';
import type {
  ApplySuggestionContext,
  BackupRepository,
  BookmarkRepository,
  CategoryRepository,
  CommitImportParams,
  CommitImportResult,
  ConvertReadingParams,
  CreateBookmarkParams,
  CreateHandoffParams,
  CreateReadingParams,
  HandoffRepository,
  ImportBatchPage,
  ImportBatchQuery,
  ImportRepository,
  ImportUndoPreview,
  ImportUndoResult,
  ReadingRepository,
  Repositories,
  PurgeSnapshotRepository,
  SettingsRepository,
  TagRepository,
} from '@shiye/application';
import { DEFAULT_POLICY, DEFAULT_SETTINGS, ShiyeDB, deriveIndexFields, type SettingsRow } from './db.js';
import { createBackupRepository } from './backup.js';
import {
  deletePurgeSnapshot,
  listPurgeSnapshots,
  previewPurgeRestore,
  restorePurgeSnapshot,
  triggerDeleteHook,
  writePurgeSnapshot,
  type PurgeHooks,
} from './purge.js';

function assertNotDeleted(bookmark: Bookmark): void {
  if (bookmark.deletedAt) {
    throw new AppError('DELETED_RECORD', '这条收藏已删除，请先在回收站恢复。');
  }
}

/** 批次列表一页最多取多少条，防止误传大数把界面拖死。 */
const BATCH_PAGE_MAX = 200;

const BATCH_STATUS_LABEL: Record<ImportBatch['status'], string> = {
  planned: '待提交',
  applied: '已写入',
  failed: '失败',
  reverted: '已撤销',
};

/** 判定一条导入记录的去向；removed 与 keep / missing 互斥。 */
type UndoJudgement =
  | { action: 'removeBookmark'; bookmark: Bookmark }
  | { action: 'removeReading'; reading: ReadingItem }
  | { action: 'keep'; item: ImportUndoItem }
  | { action: 'missing'; item: ImportUndoItem };

/** 预览与执行共用：不能撤回的批次给出同一个理由，避免两处文案不一致。 */
function undoBlockedReason(batch: ImportBatch): string | null {
  if (batch.status === 'reverted') return '这一批已经撤销过了。';
  if (batch.status !== 'applied') return '这一批没有写入任何条目，不需要撤销。';
  return null;
}

function toUndoItem(
  row: { id: string; title: string; originalUrl: string },
  reason: ImportUndoReason
): ImportUndoItem {
  return { entityId: row.id, title: row.title, originalUrl: row.originalUrl, reason };
}

/** 实体已不在库里，标题与网址都无从查起，只能如实标注，不能编造。 */
function missingItem(entityId: string): ImportUndoItem {
  return { entityId, title: '', originalUrl: '', reason: 'missing' };
}

function assertRevision(current: { localRevision: number }, expected: number): void {
  if (current.localRevision !== expected) {
    throw new AppError('REVISION_CONFLICT', '内容已在别处修改，请刷新后重新确认。', {
      expected,
      current: current.localRevision,
    });
  }
}

function buildBookmark(params: CreateBookmarkParams): Bookmark {
  const checked = canonicalizeUrl(params.originalUrl);
  const rawTitle = (params.title ?? '').trim();
  const title = rawTitle ? requireText(rawTitle, '标题', LIMITS.title) : fallbackTitle(checked.originalUrl);
  const sourceDescription = optionalText(params.sourceDescription ?? '', '来源描述', LIMITS.sourceDescription);
  const note = optionalText(params.note ?? '', '人工备注', LIMITS.note);
  const selectedText = optionalText(params.selectedText ?? '', '选中文字', LIMITS.selectedText);
  const tagIds = [...new Set(params.tagIds ?? [])];
  if (tagIds.length > LIMITS.tagsPerBookmark) {
    throw new AppError('INVALID_INPUT', `一条收藏最多 ${LIMITS.tagsPerBookmark} 个标签。`);
  }
  const createdAt = params.createdAt ?? nowIso();
  const sourceType = params.sourceType ?? 'manual';
  const source: SourceInfo = { sourceType, capturedAt: createdAt };
  if (params.importBatchId) source.importBatchId = params.importBatchId;
  if (params.sourceFolder) source.originalFolder = params.sourceFolder;
  const bookmark: Bookmark = {
    id: params.id ?? newId(),
    originalUrl: checked.originalUrl,
    canonicalUrl: checked.canonicalUrl,
    title,
    sourceDescription,
    aiPurpose: '',
    note,
    selectedText,
    categoryId: params.categoryId ?? null,
    tagIds,
    inboxUnread: params.inboxUnread ?? true,
    pinned: params.pinned ?? false,
    lastOpenedAt: null,
    privacy: {
      localOnly: params.privacy?.localOnly === true,
      aiBlocked: params.privacy?.aiBlocked === true,
    },
    lockedFields: [],
    sources: [source],
    revision: 1,
    localRevision: 1,
    changeVersion: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    lifeState: 'active',
    unreadFlag: (params.inboxUnread ?? true) ? 1 : 0,
    categoryKey: params.categoryId ?? 'uncategorized',
  };
  return bookmark;
}

export class DexieBookmarkRepository implements BookmarkRepository {
  constructor(private readonly db: ShiyeDB, private readonly hooks?: PurgeHooks) {}

  async get(id: string): Promise<Bookmark | undefined> {
    return this.db.bookmarks.get(id);
  }

  async listActive(): Promise<Bookmark[]> {
    return this.db.bookmarks.where('lifeState').equals('active').toArray();
  }

  async listDeleted(): Promise<Bookmark[]> {
    return this.db.bookmarks.where('lifeState').equals('deleted').toArray();
  }

  async findByCanonical(canonicalUrl: string): Promise<Bookmark | undefined> {
    const rows = await this.db.bookmarks.where('canonicalUrl').equals(canonicalUrl).toArray();
    return rows.find((row) => !row.deletedAt);
  }

  async findAnyByCanonical(canonicalUrl: string): Promise<Bookmark | undefined> {
    const rows = await this.db.bookmarks.where('canonicalUrl').equals(canonicalUrl).toArray();
    return rows[0];
  }

  async create(params: CreateBookmarkParams): Promise<Bookmark> {
    const bookmark = buildBookmark(params);
    return this.db.transaction('rw', this.db.bookmarks, this.db.categories, this.db.tags, this.db.tombstones, async () => {
      const existing = await this.findAnyByCanonical(bookmark.canonicalUrl);
      if (existing) {
        if (existing.deletedAt) {
          throw new AppError('TOMBSTONED', '相同网址的收藏已删除，请先明确恢复或单独新建。', {
            bookmarkId: existing.id,
          });
        }
        throw new AppError('DUPLICATE', `相同网址已经收藏为「${existing.title}」。`, {
          bookmarkId: existing.id,
        });
      }
      await this.assertReferences(bookmark.categoryId, bookmark.tagIds);
      await this.db.bookmarks.add(bookmark);
      return bookmark;
    });
  }

  async update(
    id: string,
    expectedLocalRevision: number,
    rawPatch: BookmarkPatch,
    source: 'human' | 'ai'
  ): Promise<Bookmark> {
    const patch = BookmarkPatchSchema.parse(rawPatch);
    return this.db.transaction('rw', this.db.bookmarks, this.db.categories, this.db.tags, async () => {
      const current = await this.db.bookmarks.get(id);
      if (!current) throw new AppError('NOT_FOUND', '没有找到这条收藏。');
      assertNotDeleted(current);
      assertRevision(current, expectedLocalRevision);

      if (source === 'ai') {
        const aiFields = ['categoryId', 'tagIds', 'aiPurpose'] as const;
        for (const field of aiFields) {
          if (patch[field] !== undefined && current.lockedFields.includes(field)) {
            throw new AppError('LOCKED_FIELD', `字段「${field}」已被人工锁定，AI 不得修改。`);
          }
        }
        if (patch.privacy !== undefined || patch.note !== undefined || patch.selectedText !== undefined) {
          throw new AppError('INVALID_INPUT', 'AI 通道不能修改备注、选中文字或隐私设置。');
        }
      }

      if (patch.title !== undefined) requireText(patch.title, '标题', LIMITS.title);
      if (patch.sourceDescription !== undefined) {
        optionalText(patch.sourceDescription, '来源描述', LIMITS.sourceDescription);
      }
      if (patch.aiPurpose !== undefined) optionalText(patch.aiPurpose, 'AI 用途', LIMITS.aiPurpose);
      if (patch.note !== undefined) optionalText(patch.note, '人工备注', LIMITS.note);
      if (patch.selectedText !== undefined) {
        optionalText(patch.selectedText, '选中文字', LIMITS.selectedText);
      }
      if (patch.tagIds !== undefined) {
        const unique = [...new Set(patch.tagIds)];
        if (unique.length > LIMITS.tagsPerBookmark) {
          throw new AppError('INVALID_INPUT', `一条收藏最多 ${LIMITS.tagsPerBookmark} 个标签。`);
        }
        patch.tagIds = unique;
      }
      await this.assertReferences(
        patch.categoryId === undefined ? current.categoryId : patch.categoryId,
        patch.tagIds ?? current.tagIds
      );

      const next: Bookmark = {
        ...current,
        revision: current.revision + 1,
        localRevision: current.localRevision + 1,
        updatedAt: nowIso(),
      };
      if (patch.title !== undefined) next.title = patch.title;
      if (patch.sourceDescription !== undefined) next.sourceDescription = patch.sourceDescription;
      if (patch.aiPurpose !== undefined) next.aiPurpose = patch.aiPurpose;
      if (patch.note !== undefined) next.note = patch.note;
      if (patch.selectedText !== undefined) next.selectedText = patch.selectedText;
      if (patch.categoryId !== undefined) next.categoryId = patch.categoryId;
      if (patch.tagIds !== undefined) next.tagIds = patch.tagIds;
      if (patch.pinned !== undefined) next.pinned = patch.pinned;
      if (patch.inboxUnread !== undefined) next.inboxUnread = patch.inboxUnread;
      if (patch.privacy !== undefined) next.privacy = patch.privacy;
      if (patch.lockedFields !== undefined) next.lockedFields = patch.lockedFields;
      Object.assign(next, deriveIndexFields(next));
      await this.db.bookmarks.put(next);
      return next;
    });
  }

  async softDelete(id: string): Promise<Bookmark> {
    return this.db.transaction('rw', this.db.bookmarks, this.db.tombstones, async () => {
      const current = await this.db.bookmarks.get(id);
      if (!current) throw new AppError('NOT_FOUND', '没有找到这条收藏。');
      if (current.deletedAt) return current;
      const next: Bookmark = {
        ...current,
        deletedAt: nowIso(),
        revision: current.revision + 1,
        localRevision: current.localRevision + 1,
        updatedAt: nowIso(),
      };
      Object.assign(next, deriveIndexFields(next));
      await this.db.bookmarks.put(next);
      const tombstone: Tombstone = {
        entityType: 'bookmark',
        id: current.id,
        revision: next.revision,
        changeVersion: null,
        deletedAt: next.deletedAt ?? nowIso(),
        privacyScope: current.privacy.localOnly ? 'local' : 'main',
        canonicalUrl: current.canonicalUrl,
        title: current.title,
      };
      await this.db.tombstones.put(tombstone);
      return next;
    });
  }

  async restore(id: string): Promise<Bookmark> {    return this.db.transaction('rw', this.db.bookmarks, this.db.tombstones, this.db.categories, async () => {
      const current = await this.db.bookmarks.get(id);
      if (!current) throw new AppError('NOT_FOUND', '没有找到这条收藏。');
      if (!current.deletedAt) return current;
      let categoryId = current.categoryId;
      if (categoryId) {
        const exists = await this.db.categories.get(categoryId);
        if (!exists) categoryId = null;
      }
      const next: Bookmark = {
        ...current,
        deletedAt: null,
        categoryId,
        revision: current.revision + 1,
        localRevision: current.localRevision + 1,
        updatedAt: nowIso(),
      };
      Object.assign(next, deriveIndexFields(next));
      await this.db.bookmarks.put(next);
      await this.db.tombstones.delete(['bookmark', id]);
      return next;
    });
  }

  /**
   * 清空整库：删记录，也删这本书的墓碑。
   *
   * 只清记录不清墓碑，重新导入同一批书签会全部撞在「存在已删除收藏，未绕过墓碑」上，
   * 用户会以为「清空了却导不进来」。所以清空必须把墓碑一起带走——代价是它不可恢复，
   * 界面上必须按「彻底清空」说清楚，不能和「移到回收站」混为一谈。
   */
  async purgeAll(): Promise<number> {
    return this.db.transaction(
      'rw',
      [this.db.bookmarks, this.db.tombstones, this.db.settings, this.db.purgeSnapshots],
      async () => {
        const rows = await this.db.bookmarks.toArray();
        const tombstones = (await this.db.tombstones.toArray()).filter(
          (tombstone) => tombstone.entityType === 'bookmark'
        );
        // 先落快照再删：写不进去就整条事务回滚，一条都不会少。
        await writePurgeSnapshot(
          this.db,
          { entry: 'all', scopeLabel: '整个收藏库', bookmarks: rows, tombstones },
          this.hooks
        );
        await triggerDeleteHook(this.hooks);
        await this.db.bookmarks.clear();
        await this.db.tombstones.bulkDelete(
          tombstones.map((tombstone) => [tombstone.entityType, tombstone.id] as [string, string])
        );
        return rows.length;
      }
    );
  }

  /** 清空一个分类（null = 未分类）：移走该分类下的收藏与墓碑，分类本身不动。 */
  async purgeCategory(categoryId: string | null): Promise<number> {
    return this.db.transaction(
      'rw',
      [this.db.bookmarks, this.db.tombstones, this.db.categories, this.db.settings, this.db.purgeSnapshots],
      async () => {
        const rows = (
          await this.db.bookmarks.toArray()
        ).filter((bookmark) => (bookmark.categoryId ?? null) === categoryId);
        if (rows.length === 0) return 0;
        const ids = new Set(rows.map((bookmark) => bookmark.id));
        const tombstones = (await this.db.tombstones.toArray()).filter(
          (tombstone) => tombstone.entityType === 'bookmark' && ids.has(tombstone.id)
        );
        const category = categoryId ? await this.db.categories.get(categoryId) : null;
        await writePurgeSnapshot(
          this.db,
          {
            entry: categoryId ? 'category' : 'uncategorized',
            scopeLabel: categoryId ? `分类：${category?.name ?? categoryId}` : '未分类的收藏',
            bookmarks: rows,
            tombstones,
          },
          this.hooks
        );
        await triggerDeleteHook(this.hooks);
        await this.db.bookmarks.bulkDelete(rows.map((bookmark) => bookmark.id));
        await this.db.tombstones.bulkDelete(
          tombstones.map((tombstone) => [tombstone.entityType, tombstone.id] as [string, string])
        );
        return rows.length;
      }
    );
  }

  /** 清空整库的条数明细：回收站里的记录同样会被删掉，必须单独报出来。 */
  async countPurgeAll(): Promise<PurgeCounts> {
    const [rows, tombstones] = await Promise.all([
      this.db.bookmarks.toArray(),
      this.db.tombstones.toArray(),
    ]);
    return {
      active: rows.filter((row) => !row.deletedAt).length,
      trashed: rows.filter((row) => Boolean(row.deletedAt)).length,
      tombstones: tombstones.filter((tombstone) => tombstone.entityType === 'bookmark').length,
    };
  }

  async countPurgeCategory(categoryId: string | null): Promise<PurgeCounts> {
    const rows = (await this.db.bookmarks.toArray()).filter(
      (bookmark) => (bookmark.categoryId ?? null) === categoryId
    );
    const ids = new Set(rows.map((bookmark) => bookmark.id));
    const tombstones = (await this.db.tombstones.toArray()).filter(
      (tombstone) => tombstone.entityType === 'bookmark' && ids.has(tombstone.id)
    );
    return {
      active: rows.filter((row) => !row.deletedAt).length,
      trashed: rows.filter((row) => Boolean(row.deletedAt)).length,
      tombstones: tombstones.length,
    };
  }

  async markRead(ids: string[]): Promise<number> {
    return this.db.transaction('rw', this.db.bookmarks, async () => {
      let changed = 0;
      for (const id of [...new Set(ids)]) {
        const current = await this.db.bookmarks.get(id);
        if (!current || current.deletedAt || !current.inboxUnread) continue;
        const next: Bookmark = {
          ...current,
          inboxUnread: false,
          revision: current.revision + 1,
          localRevision: current.localRevision + 1,
          updatedAt: nowIso(),
        };
        Object.assign(next, deriveIndexFields(next));
        await this.db.bookmarks.put(next);
        changed += 1;
      }
      return changed;
    });
  }

  async markUnread(ids: string[]): Promise<number> {
    return this.db.transaction('rw', this.db.bookmarks, async () => {
      let changed = 0;
      for (const id of [...new Set(ids)]) {
        const current = await this.db.bookmarks.get(id);
        if (!current || current.deletedAt || current.inboxUnread) continue;
        const next: Bookmark = {
          ...current,
          inboxUnread: true,
          revision: current.revision + 1,
          localRevision: current.localRevision + 1,
          updatedAt: nowIso(),
        };
        Object.assign(next, deriveIndexFields(next));
        await this.db.bookmarks.put(next);
        changed += 1;
      }
      return changed;
    });
  }

  async setPinned(id: string, pinned: boolean): Promise<Bookmark> {
    return this.db.transaction('rw', this.db.bookmarks, async () => {
      const current = await this.db.bookmarks.get(id);
      if (!current) throw new AppError('NOT_FOUND', '没有找到这条收藏。');
      if (current.pinned === pinned) return current;
      const next: Bookmark = {
        ...current,
        pinned,
        revision: current.revision + 1,
        localRevision: current.localRevision + 1,
        updatedAt: nowIso(),
      };
      await this.db.bookmarks.put(next);
      return next;
    });
  }

  /** 最近打开是浏览行为，不进入 revision，也不会让 AI 结果过期。 */
  async touchOpened(id: string): Promise<void> {
    await this.db.bookmarks.update(id, { lastOpenedAt: nowIso() });
  }

  async applySuggestion(
    id: string,
    expectedLocalRevision: number,
    patch: AISuggestionPatch,
    context: ApplySuggestionContext
  ): Promise<{ status: 'applied' | 'unchanged'; bookmark: Bookmark }> {
    return this.db.transaction(
      'rw',
      [
        this.db.bookmarks,
        this.db.appliedChanges,
        this.db.categories,
        this.db.tags,
        // 批次、主库身份与策略必须和写入在同一个事务里读。事务外查一遍、再开事务写，
        // 中间那段时间正好够另一个标签页改策略，旧建议就会带着「已检查」的标记写进库。
        this.db.handoffBatches,
        this.db.settings,
        this.db.policies,
      ],
      async () => {
        await this.assertHandoffStillValid(context);
        const current = await this.db.bookmarks.get(id);
        if (!current) throw new AppError('NOT_FOUND', '没有找到这条收藏。');
        assertNotDeleted(current);
        if (current.privacy.localOnly || current.privacy.aiBlocked) {
          throw new AppError('PRIVACY_BLOCKED', '这条收藏已禁止发送 AI，不能应用建议。');
        }
        assertRevision(current, expectedLocalRevision);

        const changedFields: AIField[] = [];
        const before: Partial<Record<AIField, unknown>> = {};
        const after: Partial<Record<AIField, unknown>> = {};
        const next: Bookmark = { ...current };

        if (patch.categoryId !== undefined && patch.categoryId !== current.categoryId) {
          if (current.lockedFields.includes('categoryId')) {
            throw new AppError('LOCKED_FIELD', '分类已被人工锁定，不能应用建议。');
          }
          if (patch.categoryId) {
            const category = await this.db.categories.get(patch.categoryId);
            if (!category) throw new AppError('INVALID_INPUT', '建议的分类已不存在。');
          }
          before.categoryId = current.categoryId;
          after.categoryId = patch.categoryId;
          next.categoryId = patch.categoryId;
          changedFields.push('categoryId');
        }
        if (patch.tagIds !== undefined) {
          const nextTags = [...new Set(patch.tagIds)];
          const same =
            nextTags.length === current.tagIds.length &&
            nextTags.every((tag) => current.tagIds.includes(tag));
          if (!same) {
            if (current.lockedFields.includes('tagIds')) {
              throw new AppError('LOCKED_FIELD', '标签已被人工锁定，不能应用建议。');
            }
            if (nextTags.length > LIMITS.tagsPerBookmark) {
              throw new AppError('INVALID_INPUT', `一条收藏最多 ${LIMITS.tagsPerBookmark} 个标签。`);
            }
            if (nextTags.length) {
              const found = await this.db.tags.bulkGet(nextTags);
              if (found.some((tag) => !tag)) {
                throw new AppError('INVALID_INPUT', '建议包含不存在的标签。');
              }
            }
            before.tagIds = [...current.tagIds];
            after.tagIds = nextTags;
            next.tagIds = nextTags;
            changedFields.push('tagIds');
          }
        }
        if (patch.aiPurpose !== undefined && patch.aiPurpose !== current.aiPurpose) {
          if (current.lockedFields.includes('aiPurpose')) {
            throw new AppError('LOCKED_FIELD', 'AI 用途已被人工锁定，不能应用建议。');
          }
          optionalText(patch.aiPurpose, 'AI 用途', LIMITS.aiPurpose);
          before.aiPurpose = current.aiPurpose;
          after.aiPurpose = patch.aiPurpose;
          next.aiPurpose = patch.aiPurpose;
          changedFields.push('aiPurpose');
        }

        if (changedFields.length === 0) {
          return { status: 'unchanged', bookmark: current };
        }

        next.revision = current.revision + 1;
        next.localRevision = current.localRevision + 1;
        next.updatedAt = nowIso();
        Object.assign(next, deriveIndexFields(next));
        await this.db.bookmarks.put(next);
        await this.db.appliedChanges.add({
          id: newId(),
          taskId: context.taskId,
          batchId: context.batchId,
          bookmarkId: id,
          appliedAt: next.updatedAt,
          changedFields,
          before,
          after,
          appliedLocalRevision: next.localRevision,
          undoneAt: null,
        });
        return { status: 'applied', bookmark: next };
      }
    );
  }

  /**
   * 事务内的交接有效性复核。
   *
   * 读的是这一笔事务里的批次、设置与策略：调用方在事务外查过也不算数，
   * 那之后到事务开始之间仍可能有人改了策略或换了主库。
   */
  private async assertHandoffStillValid(context: ApplySuggestionContext): Promise<void> {
    const batch = await this.db.handoffBatches.get(context.batchId);
    if (!batch) throw new AppError('STALE_SUGGESTION', '这批交接已被删除，停止应用。');
    if (batch.status === 'invalidated' || batch.status === 'applied') {
      throw new AppError('STALE_SUGGESTION', '这批交接已经应用或已失效，停止应用。');
    }
    const settingsRow = await this.db.settings.get('app');
    const libraryId = (settingsRow?.value as { libraryId?: unknown } | undefined)?.libraryId;
    if (typeof libraryId !== 'string' || !libraryId || batch.libraryId !== libraryId) {
      throw new AppError('STALE_SUGGESTION', '主库身份已变化，停止应用。');
    }
    const policy = await this.db.policies.get('default');
    const policyVersion = policy ? policy.policyVersion : DEFAULT_POLICY().policyVersion;
    if (
      policyVersion !== batch.policyVersion ||
      policyVersion !== context.policyVersion
    ) {
      throw new AppError(
        'STALE_SUGGESTION',
        '整理策略已更新，这批建议按旧规则生成，未继续应用。请重新生成材料包。'
      );
    }
  }

  /**
   * 撤销一条应用记录。
   *
   * 只有「应用之后没人再动过这条收藏」才允许撤销：`appliedLocalRevision` 与应用时的
   * 版本对齐才写回 before 值，否则返回冲突。撤销本身也递增版本，于是撤销本身
   * 也能被下一次撤销的反向检查识别出来，不会互相覆盖。
   */
  async revertChange(
    changeId: string
  ): Promise<{ status: 'reverted' | 'conflict' | 'skipped'; reason?: string }> {
    return this.db.transaction(
      'rw',
      [this.db.bookmarks, this.db.appliedChanges, this.db.categories, this.db.tags],
      async () => {
        const change = await this.db.appliedChanges.get(changeId);
        if (!change) throw new AppError('NOT_FOUND', '没有找到这条应用记录。');
        if (change.undoneAt) return { status: 'skipped', reason: '这次修改已经撤销过。' };
        const current = await this.db.bookmarks.get(change.bookmarkId);
        if (!current) return { status: 'skipped', reason: '收藏已不存在，无法撤销。' };
        if (current.deletedAt) return { status: 'skipped', reason: '收藏在回收站中，无法撤销。' };
        if (current.localRevision !== change.appliedLocalRevision) {
          return { status: 'conflict', reason: '应用之后这条收藏又被修改过，撤销会覆盖那些修改。' };
        }

        const next: Bookmark = { ...current };
        for (const field of change.changedFields) {
          if (field === 'categoryId') {
            if (current.lockedFields.includes('categoryId')) {
              return { status: 'conflict', reason: '分类已被人工锁定，撤销会改动锁定字段。' };
            }
            const before = (change.before['categoryId'] ?? null) as string | null;
            if (before) {
              const category = await this.db.categories.get(before);
              if (!category) {
                return { status: 'conflict', reason: '原来的分类已被删除，无法还原。' };
              }
            }
            next.categoryId = before;
          } else if (field === 'tagIds') {
            if (current.lockedFields.includes('tagIds')) {
              return { status: 'conflict', reason: '标签已被人工锁定，撤销会改动锁定字段。' };
            }
            const before = (change.before['tagIds'] ?? []) as string[];
            if (before.length) {
              const found = await this.db.tags.bulkGet(before);
              if (found.some((tag) => !tag)) {
                return { status: 'conflict', reason: '原来的标签已被删除，无法还原。' };
              }
            }
            next.tagIds = [...before];
          } else if (field === 'aiPurpose') {
            if (current.lockedFields.includes('aiPurpose')) {
              return { status: 'conflict', reason: 'AI 用途已被人工锁定，撤销会改动锁定字段。' };
            }
            next.aiPurpose = (change.before['aiPurpose'] ?? '') as string;
          }
        }

        next.revision = current.revision + 1;
        next.localRevision = current.localRevision + 1;
        next.updatedAt = nowIso();
        Object.assign(next, deriveIndexFields(next));
        await this.db.bookmarks.put(next);
        await this.db.appliedChanges.update(changeId, { undoneAt: next.updatedAt });
        return { status: 'reverted' };
      }
    );
  }

  private async assertReferences(categoryId: string | null, tagIds: string[]): Promise<void> {
    if (categoryId) {
      const category = await this.db.categories.get(categoryId);
      if (!category) throw new AppError('INVALID_INPUT', '所选分类已不存在，请重新选择。');
    }
    if (tagIds.length) {
      const found = await this.db.tags.bulkGet([...new Set(tagIds)]);
      if (found.some((tag) => !tag)) {
        throw new AppError('INVALID_INPUT', '包含不存在的标签，请刷新后重试。');
      }
    }
  }
}

export class DexieReadingRepository implements ReadingRepository {
  constructor(private readonly db: ShiyeDB, private readonly hooks?: PurgeHooks) {}

  async get(id: string): Promise<ReadingItem | undefined> {
    return this.db.readingItems.get(id);
  }

  async listPending(): Promise<ReadingItem[]> {
    return this.db.readingItems.where('status').equals('pending').toArray();
  }

  async listCompleted(): Promise<ReadingItem[]> {
    return this.db.readingItems.where('status').equals('completed').toArray();
  }

  async findByCanonical(canonicalUrl: string): Promise<ReadingItem | undefined> {
    return this.db.readingItems.where('canonicalUrl').equals(canonicalUrl).first();
  }

  async add(params: CreateReadingParams): Promise<{ item: ReadingItem; reactivated: boolean }> {
    const checked = canonicalizeUrl(params.originalUrl);
    const title = params.title?.trim()
      ? requireText(params.title, '标题', LIMITS.title)
      : fallbackTitle(checked.originalUrl);
    const note = optionalText(params.note ?? '', '备注', LIMITS.note);
    return this.db.transaction('rw', this.db.readingItems, async () => {
      const existing = await this.findByCanonical(checked.canonicalUrl);
      if (existing && existing.status === 'pending') {
        throw new AppError('DUPLICATE', '已经在待看列表里。', { readingId: existing.id });
      }
      if (existing) {
        // 重新激活一条已完成待看时，关联信息也要跟着这次调用更新：
        // 只改状态和时间，会让「从本地专用收藏加入待看」留下一个没有关联的待看，
        // 导出时就绕过了按关联编号做的隐私过滤。
        const related = params.relatedBookmarkId ?? existing.relatedBookmarkId ?? null;
        const next: ReadingItem = {
          ...existing,
          status: 'pending',
          completedAt: null,
          addedAt: nowIso(),
          relatedBookmarkId: related,
          revision: existing.revision + 1,
          localRevision: existing.localRevision + 1,
        };
        await this.db.readingItems.put(next);
        return { item: next, reactivated: true };
      }
      const source: SourceInfo = {
        sourceType: params.sourceType ?? 'manual',
        capturedAt: nowIso(),
      };
      if (params.importBatchId) source.importBatchId = params.importBatchId;
      if (params.sourceFolder) source.originalFolder = params.sourceFolder;
      const item: ReadingItem = {
        id: params.id ?? newId(),
        originalUrl: checked.originalUrl,
        canonicalUrl: checked.canonicalUrl,
        title,
        note,
        status: 'pending',
        addedAt: nowIso(),
        completedAt: null,
        relatedBookmarkId: params.relatedBookmarkId ?? null,
        sources: [source],
        revision: 1,
        localRevision: 1,
        changeVersion: null,
      };
      await this.db.readingItems.add(item);
      return { item, reactivated: false };
    });
  }

  async complete(id: string): Promise<ReadingItem> {
    return this.db.transaction('rw', this.db.readingItems, async () => {
      const current = await this.db.readingItems.get(id);
      if (!current) throw new AppError('NOT_FOUND', '没有找到这条待看。');
      if (current.status === 'completed') return current;
      const next: ReadingItem = {
        ...current,
        status: 'completed',
        completedAt: nowIso(),
        revision: current.revision + 1,
        localRevision: current.localRevision + 1,
      };
      await this.db.readingItems.put(next);
      return next;
    });
  }

  async reopen(id: string): Promise<ReadingItem> {
    return this.db.transaction('rw', this.db.readingItems, async () => {
      const current = await this.db.readingItems.get(id);
      if (!current) throw new AppError('NOT_FOUND', '没有找到这条待看。');
      if (current.status === 'pending') return current;
      const next: ReadingItem = {
        ...current,
        status: 'pending',
        completedAt: null,
        revision: current.revision + 1,
        localRevision: current.localRevision + 1,
      };
      await this.db.readingItems.put(next);
      return next;
    });
  }

  /** 清空待看队列。待看没有墓碑，重新加入同一网址不会被挡住。 */
  async purgePending(): Promise<number> {
    return this.db.transaction(
      'rw',
      [this.db.readingItems, this.db.settings, this.db.purgeSnapshots],
      async () => {
        const pending = await this.listPending();
        if (pending.length === 0) return 0;
        await writePurgeSnapshot(
          this.db,
          { entry: 'readingPending', scopeLabel: '待看队列', readingItems: pending },
          this.hooks
        );
        await triggerDeleteHook(this.hooks);
        await this.db.readingItems.bulkDelete(pending.map((item) => item.id));
        return pending.length;
      }
    );
  }

  async purgeCompleted(): Promise<number> {
    return this.db.transaction(
      'rw',
      [this.db.readingItems, this.db.settings, this.db.purgeSnapshots],
      async () => {
        const completed = await this.listCompleted();
        if (completed.length === 0) return 0;
        await writePurgeSnapshot(
          this.db,
          { entry: 'readingCompleted', scopeLabel: '已完成待看', readingItems: completed },
          this.hooks
        );
        await triggerDeleteHook(this.hooks);
        await this.db.readingItems.bulkDelete(completed.map((item) => item.id));
        return completed.length;
      }
    );
  }

  async convertToBookmark(
    queueId: string,
    expectedLocalRevision: number,
    params: ConvertReadingParams
  ): Promise<{ bookmark: Bookmark; item: ReadingItem }> {
    return this.db.transaction(
      'rw',
      [
        this.db.readingItems,
        this.db.bookmarks,
        this.db.tombstones,
        this.db.categories,
        this.db.tags,
      ],
      async () => {
        const queued = await this.db.readingItems.get(queueId);
        if (!queued) throw new AppError('NOT_FOUND', '没有找到这条待看。');
        if (queued.status !== 'pending') {
          throw new AppError('INVALID_INPUT', '这条待看已经完成，请先从完成历史恢复。');
        }
        assertRevision(queued, expectedLocalRevision);

        const existing = await this.db.bookmarks
          .where('canonicalUrl')
          .equals(queued.canonicalUrl)
          .toArray();
        const active = existing.find((row) => !row.deletedAt);
        if (active) {
          throw new AppError('DUPLICATE', `相同网址已经收藏为「${active.title}」。`, {
            bookmarkId: active.id,
          });
        }
        const deletedOne = existing.find((row) => row.deletedAt);
        if (deletedOne) {
          throw new AppError('TOMBSTONED', '相同网址存在已删除的收藏，请明确恢复或单独新建。', {
            bookmarkId: deletedOne.id,
          });
        }

        const bookmarkParams: CreateBookmarkParams = {
          originalUrl: queued.originalUrl,
          title: params.title ?? queued.title,
          note: params.note ?? queued.note,
          categoryId: params.categoryId ?? null,
          tagIds: params.tagIds ?? [],
          inboxUnread: true,
          sourceType: 'manual',
        };
        const originalFolder = queued.sources[0]?.originalFolder;
        if (originalFolder) bookmarkParams.sourceFolder = originalFolder;
        const bookmark = buildBookmark(bookmarkParams);
        if (bookmark.categoryId) {
          const category = await this.db.categories.get(bookmark.categoryId);
          if (!category) throw new AppError('INVALID_INPUT', '所选分类已不存在，请重新选择。');
        }
        await this.db.bookmarks.add(bookmark);
        const next: ReadingItem = {
          ...queued,
          status: 'completed',
          completedAt: nowIso(),
          relatedBookmarkId: bookmark.id,
          revision: queued.revision + 1,
          localRevision: queued.localRevision + 1,
        };
        await this.db.readingItems.put(next);
        return { bookmark, item: next };
      }
    );
  }
}

export class DexieCategoryRepository implements CategoryRepository {
  constructor(private readonly db: ShiyeDB) {}

  async list(): Promise<Category[]> {
    const rows = await this.db.categories.toArray();
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async create(name: string, description = ''): Promise<Category> {
    const cleanName = requireText(name, '分类名称', LIMITS.categoryName);
    const cleanDesc = optionalText(description, '分类说明', LIMITS.categoryDescription);
    return this.db.transaction('rw', this.db.categories, async () => {
      const sameName = await this.db.categories.where('name').equals(cleanName).first();
      if (sameName) throw new AppError('DUPLICATE', '已经有同名分类。');
      const now = nowIso();
      const category: Category = {
        id: newId(),
        name: cleanName,
        description: cleanDesc,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.db.categories.add(category);
      return category;
    });
  }

  async rename(id: string, patch: { name?: string; description?: string }): Promise<Category> {
    return this.db.transaction('rw', this.db.categories, async () => {
      const current = await this.db.categories.get(id);
      if (!current) throw new AppError('NOT_FOUND', '没有找到这个分类。');
      const name =
        patch.name === undefined ? current.name : requireText(patch.name, '分类名称', LIMITS.categoryName);
      const description =
        patch.description === undefined
          ? current.description
          : optionalText(patch.description, '分类说明', LIMITS.categoryDescription);
      if (name !== current.name) {
        const sameName = await this.db.categories.where('name').equals(name).first();
        if (sameName) throw new AppError('DUPLICATE', '已经有同名分类。');
      }
      const next: Category = {
        ...current,
        name,
        description,
        revision: current.revision + 1,
        updatedAt: nowIso(),
      };
      await this.db.categories.put(next);
      return next;
    });
  }

  async remove(id: string, migrateTo: string | null): Promise<{ movedBookmarks: number }> {
    return this.db.transaction(
      'rw',
      [this.db.categories, this.db.bookmarks, this.db.settings],
      async () => {
        const current = await this.db.categories.get(id);
        if (!current) throw new AppError('NOT_FOUND', '没有找到这个分类。');
        if (migrateTo) {
          const target = await this.db.categories.get(migrateTo);
          if (!target || migrateTo === id) {
            throw new AppError('INVALID_INPUT', '迁移目标分类无效。');
          }
        }
        const affected = await this.db.bookmarks.where('categoryKey').equals(id).toArray();
        for (const bookmark of affected) {
          const next: Bookmark = {
            ...bookmark,
            categoryId: migrateTo,
            revision: bookmark.revision + 1,
            localRevision: bookmark.localRevision + 1,
            updatedAt: nowIso(),
          };
          Object.assign(next, deriveIndexFields(next));
          await this.db.bookmarks.put(next);
        }
        await this.db.categories.delete(id);
        const settingsRow = await this.db.settings.get('app');
        if (settingsRow) {
          const value = settingsRow.value as { pinnedCategoryIds?: string[] };
          const pinned = (value.pinnedCategoryIds ?? []).filter((cid) => cid !== id);
          await this.db.settings.put({
            key: 'app',
            value: { ...value, pinnedCategoryIds: pinned },
          });
        }
        return { movedBookmarks: affected.length };
      }
    );
  }
}

export class DexieTagRepository implements TagRepository {
  constructor(private readonly db: ShiyeDB) {}

  async list(): Promise<Tag[]> {
    const rows = await this.db.tags.toArray();
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async create(name: string): Promise<Tag> {
    const cleanName = requireText(name, '标签名称', LIMITS.tagName);
    return this.db.transaction('rw', this.db.tags, async () => {
      const sameName = await this.db.tags.where('name').equals(cleanName).first();
      if (sameName) return sameName;
      const tag: Tag = { id: newId(), name: cleanName, revision: 1, createdAt: nowIso() };
      await this.db.tags.add(tag);
      return tag;
    });
  }
}

export class DexieSettingsRepository implements SettingsRepository {
  constructor(private readonly db: ShiyeDB) {}

  private async readValue<T>(key: string): Promise<T | undefined> {
    const row = await this.db.settings.get(key);
    return row?.value as T | undefined;
  }

  async getApp() {
    const existing = await this.readValue<ReturnType<typeof DEFAULT_SETTINGS>>('app');
    if (existing) return existing;
    const created = DEFAULT_SETTINGS(newId());
    await this.db.settings.put({ key: 'app', value: created });
    return created;
  }

  async updateApp(patch: Partial<{ pinnedCategoryIds: string[]; includeNoteInSnapshot: boolean; includeTextInSnapshot: boolean }>) {
    return this.db.transaction('rw', this.db.settings, this.db.categories, async () => {
      const current = await this.getApp();
      let pinnedCategoryIds = current.pinnedCategoryIds;
      if (patch.pinnedCategoryIds) {
        const unique = [...new Set(patch.pinnedCategoryIds)];
        if (unique.length > LIMITS.pinnedCategories) {
          throw new AppError('PINNED_LIMIT', `左侧最多置顶 ${LIMITS.pinnedCategories} 个分类。`);
        }
        const found = await this.db.categories.bulkGet(unique);
        pinnedCategoryIds = unique.filter((_, index) => Boolean(found[index]));
      }
      const next = {
        ...current,
        pinnedCategoryIds,
        includeNoteInSnapshot: patch.includeNoteInSnapshot ?? current.includeNoteInSnapshot,
        includeTextInSnapshot: patch.includeTextInSnapshot ?? current.includeTextInSnapshot,
        updatedAt: nowIso(),
      };
      await this.db.settings.put({ key: 'app', value: next });
      return next;
    });
  }

  async getPolicy(): Promise<Policy> {
    const existing = await this.db.policies.get('default');
    if (existing) return existing;
    const policy = DEFAULT_POLICY();
    await this.db.policies.put(policy);
    return policy;
  }

  async updatePolicy(instruction: string): Promise<Policy> {
    const clean = optionalText(instruction, '整理策略', LIMITS.sourceDescription);
    return this.db.transaction('rw', this.db.policies, async () => {
      const current = await this.getPolicy();
      const next: Policy = {
        ...current,
        instruction: clean,
        revision: current.revision + 1,
        policyVersion: current.policyVersion + 1,
        updatedAt: nowIso(),
      };
      await this.db.policies.put(next);
      return next;
    });
  }

  async bumpPolicyVersion(): Promise<Policy> {
    return this.updatePolicy((await this.getPolicy()).instruction);
  }
}

export class DexieImportRepository implements ImportRepository {
  constructor(private readonly db: ShiyeDB, private readonly hooks?: PurgeHooks) {}

  async getBatch(id: string): Promise<ImportBatch | undefined> {
    return this.db.importBatches.get(id);
  }

  /**
   * 批次历史：按文件名 / 状态搜索并分页。
   *
   * 以前固定只给最近 20 批，导错一次之后可能要翻很多页才找得到——用户找的是「那份文件」，
   * 不是「最近那几批」，所以搜索比截断更重要。批次数量级本来就小，全量读进内存再切片即可。
   */
  async listBatches(query: ImportBatchQuery = {}): Promise<ImportBatchPage> {
    const limit = Math.max(1, Math.min(query.limit ?? 20, BATCH_PAGE_MAX));
    const offset = Math.max(0, query.offset ?? 0);
    const search = (query.search ?? '').trim().toLowerCase();
    const all = await this.db.importBatches.orderBy('createdAt').reverse().toArray();
    const filtered = all.filter((batch) => {
      if (query.status && batch.status !== query.status) return false;
      if (!search) return true;
      return (
        batch.fileName.toLowerCase().includes(search) ||
        `${batch.destination === 'library' ? '收藏库' : '待看'}`.includes(search) ||
        BATCH_STATUS_LABEL[batch.status].includes(search)
      );
    });
    const rows = filtered.slice(offset, offset + limit);
    return { rows, total: filtered.length, hasMore: offset + rows.length < filtered.length };
  }

  /**
   * 逐条判定一批导入里的每个条目该怎么处理。
   *
   * 预览与执行共用这一套规则，所以「预览说会删 8 条」与「实际删了 8 条」不会对不上。
   * 判定只看当前状态，不改任何东西。
   */
  private async judgeBatchItems(batch: ImportBatch): Promise<{
    items: ImportItem[];
    judgements: UndoJudgement[];
  }> {
    const items = await this.db.importItems
      .where('[batchId+sourceKey]')
      .between([batch.id, Dexie.minKey], [batch.id, Dexie.maxKey])
      .toArray();
    const judgements: UndoJudgement[] = [];
    for (const item of items) {
      if (batch.destination === 'library') {
        const row = await this.db.bookmarks.get(item.entityId);
        if (!row) {
          judgements.push({ action: 'missing', item: missingItem(item.entityId) });
          continue;
        }
        if (row.deletedAt) {
          // 先进回收站再说：撤回不替用户撤销「我要删它」这个决定。
          judgements.push({ action: 'keep', item: toUndoItem(row, 'trashed') });
          continue;
        }
        if (row.localRevision > 1) {
          judgements.push({ action: 'keep', item: toUndoItem(row, 'modified') });
          continue;
        }
        judgements.push({ action: 'removeBookmark', bookmark: row });
        continue;
      }
      const row = await this.db.readingItems.get(item.entityId);
      if (!row) {
        judgements.push({ action: 'missing', item: missingItem(item.entityId) });
        continue;
      }
      if (row.relatedBookmarkId) {
        judgements.push({ action: 'keep', item: toUndoItem(row, 'converted') });
        continue;
      }
      if (row.status === 'completed') {
        judgements.push({ action: 'keep', item: toUndoItem(row, 'completed') });
        continue;
      }
      if (row.localRevision > 1) {
        judgements.push({ action: 'keep', item: toUndoItem(row, 'modified') });
        continue;
      }
      judgements.push({ action: 'removeReading', reading: row });
    }
    return { items, judgements };
  }

  async previewUndoBatch(batchId: string): Promise<ImportUndoPreview> {
    const batch = await this.db.importBatches.get(batchId);
    if (!batch) throw new AppError('NOT_FOUND', '找不到这次导入的记录。');
    const blockedReason = undoBlockedReason(batch);
    if (blockedReason) {
      return { batch, total: 0, removed: 0, kept: 0, missing: 0, items: [], blockedReason };
    }
    const { judgements } = await this.judgeBatchItems(batch);
    const removed = judgements.filter(
      (entry) => entry.action === 'removeBookmark' || entry.action === 'removeReading'
    ).length;
    const rest = judgements.filter((entry) => entry.action === 'keep' || entry.action === 'missing');
    return {
      batch,
      total: judgements.length,
      removed,
      kept: rest.filter((entry) => entry.action === 'keep').length,
      missing: rest.filter((entry) => entry.action === 'missing').length,
      items: rest.map((entry) => (entry as { item: ImportUndoItem }).item),
      blockedReason: null,
    };
  }

  /**
   * 撤销一批导入：把这批新建的条目删掉，回到「导入之前」。
   *
   * 判据用 localRevision：导入时新建的记录是 1，之后被人工编辑、应用 AI 建议、标记已读、
   * 完成或转入收藏都会让它变大。撤销只回滚「原样留着」的条目——用户之后做的决定
   * 不该被一次「撤销导入」抹掉，宁可少删并如实报数。
   *
   * 收藏的墓碑必须一起删：这批条目是新建的，本身没有墓碑，但如果在撤销前被用户删过，
   * 留下的墓碑会让同一网址的下一次导入被判成「存在已删除收藏」。
   */
  async undoBatch(batchId: string): Promise<ImportUndoResult> {
    return this.db.transaction(
      'rw',
      [
        this.db.bookmarks,
        this.db.readingItems,
        this.db.tombstones,
        this.db.importBatches,
        this.db.importItems,
        this.db.settings,
        this.db.purgeSnapshots,
      ],
      async () => {
        const batch = await this.db.importBatches.get(batchId);
        if (!batch) throw new AppError('NOT_FOUND', '找不到这次导入的记录。');
        const blocked = undoBlockedReason(batch);
        if (blocked) throw new AppError('INVALID_INPUT', blocked);

        // 先判定再删除：判定阶段只收集，删除阶段统一执行，
        // 中间才有位置写清理快照（撤销是硬删，误撤同样需要能找回）。
        // 判定结果同时决定「保留项与原因」，执行后要持久化下来，刷新仍可回看。
        const { items, judgements } = await this.judgeBatchItems(batch);
        const removeBookmarks = judgements
          .filter(
            (entry): entry is Extract<UndoJudgement, { action: 'removeBookmark' }> =>
              entry.action === 'removeBookmark'
          )
          .map((entry) => entry.bookmark);
        const removeReadings = judgements
          .filter(
            (entry): entry is Extract<UndoJudgement, { action: 'removeReading' }> =>
              entry.action === 'removeReading'
          )
          .map((entry) => entry.reading);
        const keptItems = judgements
          .filter((entry) => entry.action === 'keep' || entry.action === 'missing')
          .map((entry) => (entry as { item: ImportUndoItem }).item);

        const removedIds = new Set(removeBookmarks.map((row) => row.id));
        const batchTombstones = (await this.db.tombstones.toArray()).filter(
          (tombstone) => tombstone.entityType === 'bookmark' && removedIds.has(tombstone.id)
        );
        if (removeBookmarks.length > 0 || removeReadings.length > 0) {
          await writePurgeSnapshot(
            this.db,
            {
              entry: 'importBatch',
              scopeLabel: `批次：${batch.fileName}`,
              bookmarks: removeBookmarks,
              readingItems: removeReadings,
              tombstones: batchTombstones,
            },
            this.hooks
          );
          await triggerDeleteHook(this.hooks);
        }

        await this.db.bookmarks.bulkDelete(removeBookmarks.map((row) => row.id));
        await this.db.tombstones.bulkDelete(
          batchTombstones.map((tombstone) => [tombstone.entityType, tombstone.id] as [string, string])
        );
        await this.db.readingItems.bulkDelete(removeReadings.map((row) => row.id));

        await this.db.importItems.bulkDelete(
          items.map((item) => [item.batchId, item.sourceKey] as [string, string])
        );
        // importItems 马上就要被清空，撤回结果从此只能靠批次上的这几个字段回看。
        const removed = removeBookmarks.length + removeReadings.length;
        const kept = keptItems.filter((entry) => entry.reason !== 'missing').length;
        const missing = keptItems.filter((entry) => entry.reason === 'missing').length;
        const reverted: ImportBatch = {
          ...batch,
          status: 'reverted',
          revertedAt: nowIso(),
          undoCounts: { removed, kept, missing },
          undoKept: keptItems,
        };
        await this.db.importBatches.put(reverted);
        return { batch: reverted, removed, kept, missing, items: keptItems };
      }
    );
  }

  async commit(params: CommitImportParams): Promise<CommitImportResult> {
    return this.db.transaction(
      'rw',
      [
        this.db.bookmarks,
        this.db.readingItems,
        this.db.importBatches,
        this.db.importItems,
        this.db.tombstones,
        this.db.categories,
      ],
      async () => {
        const existingBatch = await this.db.importBatches.get(params.batchId);
        if (existingBatch && existingBatch.status === 'applied') {
          throw new AppError('ALREADY_APPLIED', '这一批已经写入，不会重复新增。', {
            batchId: params.batchId,
          });
        }

        const selected = params.rows.filter((row) => row.selected && row.status === 'new');
        const skippedReasons: { line: number; reason: string }[] = [];
        const createdIds: string[] = [];
        const now = nowIso();

        const batch: ImportBatch = {
          id: params.batchId,
          source: params.source,
          fileName: params.fileName,
          fileHash: params.fileHash,
          destination: params.destination,
          status: 'planned',
          total: params.rows.length,
          inserted: 0,
          skipped: 0,
          invalid: params.rows.filter((row) => row.status === 'invalid').length,
          createdAt: now,
          appliedAt: null,
          error: null,
          revertedAt: null,
          undoCounts: null,
          undoKept: [],
        };
        await this.db.importBatches.put(batch);

        for (const row of selected) {
          if (!row.canonicalUrl) {
            skippedReasons.push({ line: row.line, reason: '缺少有效网址' });
            continue;
          }
          if (params.destination === 'library') {
            const active = await this.db.bookmarks
              .where('canonicalUrl')
              .equals(row.canonicalUrl)
              .filter((bookmark) => !bookmark.deletedAt)
              .first();
            if (active) {
              skippedReasons.push({ line: row.line, reason: '已经收藏，本次跳过' });
              continue;
            }
            const deleted = await this.db.bookmarks
              .where('canonicalUrl')
              .equals(row.canonicalUrl)
              .filter((bookmark) => Boolean(bookmark.deletedAt))
              .first();
            if (deleted) {
              skippedReasons.push({ line: row.line, reason: '存在已删除收藏，未绕过墓碑' });
              continue;
            }
            const bookmark = buildBookmark({
              id: newId(),
              originalUrl: row.originalUrl,
              title: row.title,
              categoryId: row.targetCategoryId,
              inboxUnread: true,
              sourceType: params.source === 'paste' ? 'manual' : 'html',
              sourceFolder: row.sourceFolder,
              importBatchId: params.batchId,
            });
            if (bookmark.categoryId) {
              const category = await this.db.categories.get(bookmark.categoryId);
              if (!category) bookmark.categoryId = null;
              Object.assign(bookmark, deriveIndexFields(bookmark));
            }
            await this.db.bookmarks.add(bookmark);
            await this.db.importItems.put({
              batchId: params.batchId,
              sourceKey: row.sourceKey,
              entityId: bookmark.id,
            });
            createdIds.push(bookmark.id);
          } else {
            const pending = await this.db.readingItems
              .where('canonicalUrl')
              .equals(row.canonicalUrl)
              .first();
            if (pending && pending.status === 'pending') {
              skippedReasons.push({ line: row.line, reason: '已经在待看中，本次跳过' });
              continue;
            }
            const source: SourceInfo = {
              sourceType: params.source === 'paste' ? 'manual' : 'html',
              capturedAt: now,
              importBatchId: params.batchId,
            };
            if (row.sourceFolder) source.originalFolder = row.sourceFolder;
            const item: ReadingItem = {
              id: newId(),
              originalUrl: row.originalUrl,
              canonicalUrl: row.canonicalUrl,
              title: row.title || fallbackTitle(row.originalUrl),
              note: '',
              status: 'pending',
              addedAt: now,
              completedAt: null,
              relatedBookmarkId: null,
              sources: [source],
              revision: 1,
              localRevision: 1,
              changeVersion: null,
            };
            await this.db.readingItems.add(item);
            await this.db.importItems.put({
              batchId: params.batchId,
              sourceKey: row.sourceKey,
              entityId: item.id,
            });
            createdIds.push(item.id);
          }
        }

        const applied: ImportBatch = {
          ...batch,
          status: 'applied',
          inserted: createdIds.length,
          skipped: skippedReasons.length,
          appliedAt: nowIso(),
        };
        await this.db.importBatches.put(applied);
        return {
          batch: applied,
          inserted: createdIds.length,
          skipped: skippedReasons.length,
          skippedReasons,
          createdIds,
        };
      }
    );
  }
}

export class DexieHandoffRepository implements HandoffRepository {
  constructor(private readonly db: ShiyeDB) {}

  async createBatch(params: CreateHandoffParams): Promise<HandoffBatch> {
    return this.db.transaction('rw', [this.db.handoffBatches, this.db.handoffItems], async () => {
      const batch: HandoffBatch = {
        id: params.id,
        protocolVersion: params.protocolVersion,
        createdAt: nowIso(),
        policyVersion: params.policyVersion,
        libraryId: params.libraryId,
        status: 'exported',
        parts: 1,
        itemCount: params.items.length,
        materialText: params.materialText,
      };
      await this.db.handoffBatches.put(batch);
      await this.db.handoffItems.bulkPut(
        params.items.map((item) => ({
          batchId: params.id,
          n: item.n,
          part: item.part,
          bookmarkId: item.bookmarkId,
          baseRevision: item.baseRevision,
          baseLocalRevision: item.baseLocalRevision,
          inputHash: item.inputHash,
          status: 'pending' as const,
          patch: null,
          reason: '',
        }))
      );
      return batch;
    });
  }

  async getBatch(id: string): Promise<HandoffBatch | undefined> {
    return this.db.handoffBatches.get(id);
  }

  async listBatches(limit = 10): Promise<HandoffBatch[]> {
    return this.db.handoffBatches.orderBy('createdAt').reverse().limit(limit).toArray();
  }

  async listItems(batchId: string): Promise<HandoffItem[]> {
    const items = await this.db.handoffItems.where('[batchId+n]').between([batchId, -Infinity], [batchId, Infinity]).toArray();
    return items.sort((a, b) => a.n - b.n);
  }

  async saveItemResults(
    batchId: string,
    results: { n: number; status: HandoffItem['status']; patch: AISuggestionPatch | null; reason: string }[]
  ): Promise<void> {
    await this.db.transaction('rw', this.db.handoffItems, async () => {
      for (const result of results) {
        await this.db.handoffItems.update([batchId, result.n], {
          status: result.status,
          patch: result.patch,
          reason: result.reason,
        });
      }
    });
  }

  async setStatus(batchId: string, status: HandoffBatchStatus): Promise<void> {
    await this.db.handoffBatches.update(batchId, { status });
  }

  async listAppliedChanges(batchId: string): Promise<AppliedChange[]> {
    // appliedChanges 的索引只有 id / taskId / bookmarkId / appliedAt，没有 batchId；
    // 应用日志的总量由批次数决定（每批最多一批条目），在内存里筛比加索引更稳妥。
    const changes = await this.db.appliedChanges.toArray();
    return changes
      .filter((change) => change.batchId === batchId && !change.undoneAt)
      .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
  }
}

export class DexiePurgeRepository implements PurgeSnapshotRepository {
  constructor(private readonly db: ShiyeDB) {}

  list(): Promise<PurgeSnapshot[]> {
    return listPurgeSnapshots(this.db);
  }

  preview(snapshotId: string): Promise<PurgeRestorePreview> {
    return previewPurgeRestore(this.db, snapshotId);
  }

  restore(snapshotId: string): Promise<{ preview: PurgeRestorePreview; restored: number }> {
    return restorePurgeSnapshot(this.db, snapshotId);
  }

  remove(snapshotId: string): Promise<void> {
    return deletePurgeSnapshot(this.db, snapshotId);
  }
}

export function createRepositories(
  db: ShiyeDB,
  backup?: BackupRepository,
  hooks?: PurgeHooks
): Repositories {
  return {
    bookmarks: new DexieBookmarkRepository(db, hooks),
    reading: new DexieReadingRepository(db, hooks),
    categories: new DexieCategoryRepository(db),
    tags: new DexieTagRepository(db),
    settings: new DexieSettingsRepository(db),
    imports: new DexieImportRepository(db, hooks),
    handoff: new DexieHandoffRepository(db),
    backup: backup ?? createBackupRepository(db),
    purge: new DexiePurgeRepository(db),
  };
}

export { createBackupRepository };
export type { ImportRow, SettingsRow };
