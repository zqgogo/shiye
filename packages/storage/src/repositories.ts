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
  Bookmark,
  BookmarkPatch,
  Category,
  ImportBatch,
  ImportRow,
  Policy,
  ReadingItem,
  SourceInfo,
  Tag,
  Tombstone,
} from '@shiye/core';
import type {
  BackupRepository,
  BookmarkRepository,
  CategoryRepository,
  CommitImportParams,
  CommitImportResult,
  ConvertReadingParams,
  CreateBookmarkParams,
  CreateReadingParams,
  ImportRepository,
  ReadingRepository,
  Repositories,
  SettingsRepository,
  TagRepository,
} from '@shiye/application';
import { DEFAULT_POLICY, DEFAULT_SETTINGS, ShiyeDB, deriveIndexFields, type SettingsRow } from './db.js';
import { createBackupRepository } from './backup.js';

function assertNotDeleted(bookmark: Bookmark): void {
  if (bookmark.deletedAt) {
    throw new AppError('DELETED_RECORD', '这条收藏已删除，请先在回收站恢复。');
  }
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
  constructor(private readonly db: ShiyeDB) {}

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

  async restore(id: string): Promise<Bookmark> {
    return this.db.transaction('rw', this.db.bookmarks, this.db.tombstones, this.db.categories, async () => {
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
    context: { taskId: string; batchId: string }
  ): Promise<{ status: 'applied' | 'unchanged'; bookmark: Bookmark }> {
    return this.db.transaction('rw', this.db.bookmarks, this.db.appliedChanges, this.db.categories, this.db.tags, async () => {
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
    });
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
  constructor(private readonly db: ShiyeDB) {}

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
        const next: ReadingItem = {
          ...existing,
          status: 'pending',
          completedAt: null,
          addedAt: nowIso(),
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

  async purgeCompleted(): Promise<number> {
    return this.db.transaction('rw', this.db.readingItems, async () => {
      const completed = await this.listCompleted();
      await this.db.readingItems.bulkDelete(completed.map((item) => item.id));
      return completed.length;
    });
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
  constructor(private readonly db: ShiyeDB) {}

  async getBatch(id: string): Promise<ImportBatch | undefined> {
    return this.db.importBatches.get(id);
  }

  async listBatches(): Promise<ImportBatch[]> {
    return this.db.importBatches.orderBy('createdAt').reverse().limit(20).toArray();
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

export function createRepositories(db: ShiyeDB, backup?: BackupRepository): Repositories {
  return {
    bookmarks: new DexieBookmarkRepository(db),
    reading: new DexieReadingRepository(db),
    categories: new DexieCategoryRepository(db),
    tags: new DexieTagRepository(db),
    settings: new DexieSettingsRepository(db),
    imports: new DexieImportRepository(db),
    backup: backup ?? createBackupRepository(db),
  };
}

export { createBackupRepository };
export type { ImportRow, SettingsRow };
