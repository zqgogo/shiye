import {
  AI_INSTRUCTION,
  toUserMessage,
  AppError,
  BookmarkCreateSchema,
  BookmarkPatchSchema,
  LIMITS,
  ReadingCreateSchema,
  SCHEMA_VERSION,
  buildAskMaterial,
  buildOrganizeMaterial,
  buildAiItem,
  buildSnapshotHtml,
  canonicalizeUrl,
  computeInputHash,
  extractJsonObject,
  newId,
  nowIso,
  parseBackup,
  planImport,
  parseBookmarkHtml,
  parsePasteInput,
  sha256Hex,
  snapshotFileName,
  backupFileName,
  type AiInputItem,
  type AIReply,
  type BackupDocument,
  type Bookmark,
  type BookmarkPatch,
  type Category,
  type ImportDestination,
  type ImportParseResult,
  type ImportPlan,
  type ImportRow,
  type ImportSource,
  type Policy,
  type ReadingItem,
  type AppSettings,
  type Tag,
  AI_PROTOCOL_VERSION,
} from '@shiye/core';
import { AIReplySchema, AISuggestionSchema } from '@shiye/core';
import { z } from 'zod';
import type { CommitImportResult, Repositories, RestoreResult } from './ports.js';
import { createSearchIndex, type LocalSearchIndex, type SearchHit } from './search.js';

export interface WorkspaceSnapshot {
  bookmarks: Bookmark[];
  categories: Category[];
  tags: Tag[];
  settings: AppSettings;
  policy: Policy;
  pendingReading: ReadingItem[];
  completedReading: ReadingItem[];
}

export interface ImportPreview {
  plan: ImportPlan;
  warnings: ImportParseResult['warnings'];
  fileName: string;
  fileHash: string | null;
  source: ImportSource;
  entries: ImportParseResult['entries'];
}

export interface BackupBundle {
  fileName: string;
  text: string;
  document: BackupDocument;
}

export class WorkspaceService {
  private searchCache: { key: string; index: LocalSearchIndex; bookmarks: Bookmark[] } | null = null;

  constructor(private readonly repos: Repositories) {}

  private async ensureSearchIndex(): Promise<{ index: LocalSearchIndex; bookmarks: Bookmark[] }> {
    const [bookmarks, categories, tags] = await Promise.all([
      this.repos.bookmarks.listActive(),
      this.repos.categories.list(),
      this.repos.tags.list(),
    ]);
    const key = [
      bookmarks
        .map((bookmark) => `${bookmark.id}:${bookmark.localRevision}:${bookmark.categoryId ?? ''}:${bookmark.tagIds.join(',')}`)
        .join('|'),
      categories.map((category) => `${category.id}:${category.name}`).join('|'),
      tags.map((tag) => `${tag.id}:${tag.name}`).join('|'),
    ].join('#');
    if (this.searchCache?.key === key) {
      return { index: this.searchCache.index, bookmarks };
    }
    const index = createSearchIndex(bookmarks, categories, tags);
    this.searchCache = { key, index, bookmarks };
    return { index, bookmarks };
  }

  private async loadAll(): Promise<WorkspaceSnapshot> {
    const [bookmarks, categories, tags, settings, policy, pendingReading, completedReading] =
      await Promise.all([
        this.repos.bookmarks.listActive(),
        this.repos.categories.list(),
        this.repos.tags.list(),
        this.repos.settings.getApp(),
        this.repos.settings.getPolicy(),
        this.repos.reading.listPending(),
        this.repos.reading.listCompleted(),
      ]);
    return { bookmarks, categories, tags, settings, policy, pendingReading, completedReading };
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    return this.loadAll();
  }

  async getBookmark(id: string): Promise<Bookmark | undefined> {
    return this.repos.bookmarks.get(id);
  }

  async getReading(id: string): Promise<ReadingItem | undefined> {
    return this.repos.reading.get(id);
  }

  async listTrash(): Promise<Bookmark[]> {
    const rows = await this.repos.bookmarks.listDeleted();
    return rows.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  /**
   * 本地检索。索引按数据指纹缓存：内容或分类标签名变化时自动重建，
   * 避免每次输入都重新分词整库（500 条时差异明显）。
   */
  async search(query: string, options?: { categoryId?: string | null }): Promise<SearchHit[]> {
    const { index, bookmarks } = await this.ensureSearchIndex();
    const hits = index.search(query);
    const scope = options?.categoryId;
    if (!scope) return hits;
    const allowed = new Set(
      bookmarks.filter((bookmark) => bookmark.categoryId === scope).map((bookmark) => bookmark.id)
    );
    return hits.filter((hit) => allowed.has(hit.bookmarkId));
  }

  /** 显式重建索引：设置页与故障恢复用；正常情况下指纹变化会自动重建。 */
  async rebuildSearchIndex(): Promise<{ documents: number; builtAt: string }> {
    this.searchCache = null;
    const { index, bookmarks } = await this.ensureSearchIndex();
    return { documents: bookmarks.length, builtAt: index.builtAt || new Date().toISOString() };
  }

  async createBookmark(raw: unknown): Promise<Bookmark> {
    const parsed = BookmarkCreateSchema.parse(raw);
    const params: Parameters<Repositories['bookmarks']['create']>[0] = {
      originalUrl: parsed.originalUrl,
      sourceType: parsed.sourceType ?? 'manual',
    };
    if (parsed.id) params.id = parsed.id;
    if (parsed.title !== undefined) params.title = parsed.title;
    if (parsed.sourceDescription !== undefined) params.sourceDescription = parsed.sourceDescription;
    if (parsed.note !== undefined) params.note = parsed.note;
    if (parsed.selectedText !== undefined) params.selectedText = parsed.selectedText;
    if (parsed.categoryId !== undefined) params.categoryId = parsed.categoryId;
    if (parsed.tagIds !== undefined) params.tagIds = parsed.tagIds;
    if (parsed.inboxUnread !== undefined) params.inboxUnread = parsed.inboxUnread;
    if (parsed.privacy !== undefined) {
      params.privacy = {
        localOnly: parsed.privacy.localOnly === true,
        aiBlocked: parsed.privacy.aiBlocked === true,
      };
    }
    if (parsed.sourceFolder !== undefined) params.sourceFolder = parsed.sourceFolder;
    if (parsed.importBatchId !== undefined) params.importBatchId = parsed.importBatchId;
    if (parsed.pinned !== undefined) params.pinned = parsed.pinned;
    return this.repos.bookmarks.create(params);
  }

  async updateBookmark(
    id: string,
    expectedLocalRevision: number,
    rawPatch: BookmarkPatch,
    source: 'human' | 'ai' = 'human'
  ): Promise<Bookmark> {
    const patch = BookmarkPatchSchema.parse(rawPatch);
    return this.repos.bookmarks.update(id, expectedLocalRevision, patch, source);
  }

  async deleteBookmark(id: string): Promise<Bookmark> {
    return this.repos.bookmarks.softDelete(id);
  }

  async restoreBookmark(id: string): Promise<Bookmark> {
    return this.repos.bookmarks.restore(id);
  }

  async markRead(ids: string[]): Promise<number> {
    return this.repos.bookmarks.markRead(ids);
  }

  async markUnread(ids: string[]): Promise<number> {
    return this.repos.bookmarks.markUnread(ids);
  }

  async markAllInboxRead(): Promise<number> {
    const bookmarks = await this.repos.bookmarks.listActive();
    return this.repos.bookmarks.markRead(
      bookmarks.filter((bookmark) => bookmark.inboxUnread).map((bookmark) => bookmark.id)
    );
  }

  async setPinned(id: string, pinned: boolean): Promise<Bookmark> {
    return this.repos.bookmarks.setPinned(id, pinned);
  }

  async touchOpened(id: string): Promise<void> {
    await this.repos.bookmarks.touchOpened(id);
  }

  async addReading(raw: unknown): Promise<ReadingItem> {
    const parsed = ReadingCreateSchema.parse(raw);
    const params: Parameters<Repositories['reading']['add']>[0] = { originalUrl: parsed.originalUrl };
    if (parsed.id) params.id = parsed.id;
    if (parsed.title !== undefined) params.title = parsed.title;
    if (parsed.note !== undefined) params.note = parsed.note;
    if (parsed.relatedBookmarkId !== undefined) params.relatedBookmarkId = parsed.relatedBookmarkId;
    if (parsed.sourceType !== undefined) params.sourceType = parsed.sourceType;
    const result = await this.repos.reading.add(params);
    return result.item;
  }

  async completeReading(id: string): Promise<ReadingItem> {
    return this.repos.reading.complete(id);
  }

  async reopenReading(id: string): Promise<ReadingItem> {
    return this.repos.reading.reopen(id);
  }

  async purgeCompletedReading(): Promise<number> {
    return this.repos.reading.purgeCompleted();
  }

  async convertReading(
    queueId: string,
    expectedLocalRevision: number,
    params: { categoryId?: string | null; title?: string; note?: string }
  ): Promise<{ bookmark: Bookmark; item: ReadingItem }> {
    const cleaned: { categoryId?: string | null; title?: string; note?: string } = {};
    if (params.categoryId !== undefined) cleaned.categoryId = params.categoryId;
    if (params.title !== undefined) cleaned.title = params.title;
    if (params.note !== undefined) cleaned.note = params.note;
    return this.repos.reading.convertToBookmark(queueId, expectedLocalRevision, cleaned);
  }

  async findBookmarkByUrl(url: string): Promise<Bookmark | undefined> {
    const checked = canonicalizeUrl(url);
    return this.repos.bookmarks.findByCanonical(checked.canonicalUrl);
  }

  /**
   * 查同 URL 的墓碑（已软删除的收藏）。
   *
   * 转收藏前必须能识别这种情况：仓库层会拒绝直接新建，界面要让用户
   * 明确选择「恢复原收藏」还是「保持待看不动」，而不是只弹一条错误提示。
   */
  async findDeletedByUrl(url: string): Promise<Bookmark | undefined> {
    const checked = canonicalizeUrl(url);
    const deleted = await this.repos.bookmarks.listDeleted();
    return deleted.find((row) => row.canonicalUrl === checked.canonicalUrl);
  }

  async createCategory(name: string, description?: string): Promise<Category> {
    return this.repos.categories.create(name, description ?? '');
  }

  async renameCategory(id: string, patch: { name?: string; description?: string }): Promise<Category> {
    const renamed = await this.repos.categories.rename(id, patch);
    // 分类名进入搜索索引，改名后旧关键词不应再命中。
    await this.rebuildSearchIndex();
    return renamed;
  }

  async removeCategory(id: string, migrateTo: string | null): Promise<{ movedBookmarks: number }> {
    return this.repos.categories.remove(id, migrateTo);
  }

  async setPinnedCategories(ids: string[]): Promise<AppSettings> {
    const unique = [...new Set(ids)];
    if (unique.length > LIMITS.pinnedCategories) {
      throw new AppError('INVALID_INPUT', `最多置顶 ${LIMITS.pinnedCategories} 个分类。`);
    }
    const categories = await this.repos.categories.list();
    const known = new Set(categories.map((category) => category.id));
    return this.repos.settings.updateApp({ pinnedCategoryIds: unique.filter((id) => known.has(id)) });
  }

  async createTag(name: string): Promise<Tag> {
    return this.repos.tags.create(name);
  }

  async updatePolicy(instruction: string): Promise<Policy> {
    return this.repos.settings.updatePolicy(instruction);
  }

  /** 解析粘贴或书签 HTML，生成逐行预览；解析阶段不写数据库。 */
  async previewImport(input: {
    mode: ImportSource;
    text: string;
    fileName?: string;
    destination: ImportDestination;
  }): Promise<ImportPreview> {
    if (input.mode === 'bookmarkHtml' && input.text.length > LIMITS.importFileBytes) {
      throw new AppError('FILE_TOO_LARGE', '文件超过 3 MB，请拆分后导入。');
    }
    const parsed =
      input.mode === 'paste' ? parsePasteInput(input.text) : parseBookmarkHtml(input.text);
    if (parsed.entries.length > LIMITS.importRows) {
      throw new AppError('TOO_MANY_ROWS', `单批最多 ${LIMITS.importRows} 条，请拆分后导入。`);
    }
    const fileName = input.fileName ?? (input.mode === 'paste' ? '粘贴链接' : '书签文件');
    const fileHash = await sha256Hex(input.text);
    const plan = await this.buildImportPlan(parsed.entries, input.destination, new Map());
    return {
      plan,
      warnings: parsed.warnings,
      fileName,
      fileHash,
      source: input.mode,
      entries: parsed.entries,
    };
  }

  async buildImportPlan(
    entries: ImportParseResult['entries'],
    destination: ImportDestination,
    folderMapping: ReadonlyMap<string, string | null>
  ): Promise<ImportPlan> {
    const [bookmarks, readings, tombstones] = await Promise.all([
      this.repos.bookmarks.listActive(),
      this.repos.reading.listPending(),
      this.repos.backup.listTombstones(),
    ]);
    const existingBookmarks = new Map(
      bookmarks.map((bookmark) => [bookmark.canonicalUrl, { id: bookmark.id, title: bookmark.title }])
    );
    const pendingReadings = new Map(
      readings.map((item) => [item.canonicalUrl, { id: item.id }])
    );
    const tombstonedBookmarks = new Map(
      tombstones
        .filter((tombstone) => tombstone.entityType === 'bookmark' && tombstone.canonicalUrl)
        .map((tombstone) => [tombstone.canonicalUrl as string, { id: tombstone.id }])
    );
    return planImport(entries, {
      destination,
      existingBookmarks,
      pendingReadings,
      tombstonedBookmarks,
      folderMapping,
    });
  }

  async commitImport(input: {
    batchId: string;
    source: ImportSource;
    fileName: string;
    fileHash: string | null;
    destination: ImportDestination;
    rows: ImportRow[];
  }): Promise<CommitImportResult> {
    return this.repos.imports.commit({
      batchId: input.batchId,
      source: input.source,
      fileName: input.fileName,
      fileHash: input.fileHash,
      destination: input.destination,
      rows: input.rows,
    });
  }

  async exportBackup(includeLocalOnly: boolean): Promise<BackupBundle> {
    const document = await this.repos.backup.exportDocument({ includeLocalOnly });
    return {
      fileName: backupFileName(document.exportedAt),
      text: JSON.stringify(document, null, 2),
      document,
    };
  }

  async restoreBackup(
    text: string,
    mode: 'merge' | 'replace'
  ): Promise<{ result: RestoreResult; safety: BackupBundle | null }> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError('INVALID_INPUT', '文件不是有效的 JSON。');
    }
    const document = parseBackup(raw) as unknown as BackupDocument;
    if (document.schemaVersion > SCHEMA_VERSION) {
      throw new AppError('UNSUPPORTED_VERSION', '备份来自更新版本，请先升级扩展。');
    }
    const safety = mode === 'replace' ? await this.exportBackup(true) : null;
    const result = await this.repos.backup.restore(document, mode);
    return { result, safety };
  }

  async exportSnapshot(options: {
    includeNote: boolean;
    includeText: boolean;
  }): Promise<{ fileName: string; html: string }> {
    const [bookmarks, categories] = await Promise.all([
      this.repos.bookmarks.listActive(),
      this.repos.categories.list(),
    ]);
    const exportedAt = nowIso();
    return {
      fileName: snapshotFileName(exportedAt),
      html: buildSnapshotHtml(bookmarks, {
        exportedAt,
        includeNote: options.includeNote,
        includeText: options.includeText,
        categories,
      }),
    };
  }

  /** 逐条应用 AI 建议：每条一个事务，版本、隐私、锁定在事务内复核。 */
  async applySuggestions(
    batchId: string,
    items: {
      n: number;
      bookmark: Bookmark;
      patch: NonNullable<AIReply['results'][number]['patch']>;
    }[]
  ): Promise<{
    applied: { n: number; bookmark: Bookmark }[];
    skipped: { n: number; reason: string }[];
  }> {
    const applied: { n: number; bookmark: Bookmark }[] = [];
    const skipped: { n: number; reason: string }[] = [];
    const taskId = newId();
    for (const item of items) {
      const patch = item.patch;
      const cleaned: {
        categoryId?: string | null;
        tagIds?: string[];
        aiPurpose?: string;
      } = {};
      if (patch.categoryId !== undefined) cleaned.categoryId = patch.categoryId;
      if (patch.tagIds !== undefined) cleaned.tagIds = patch.tagIds;
      if (patch.aiPurpose !== undefined) cleaned.aiPurpose = patch.aiPurpose;
      try {
        const result = await this.repos.bookmarks.applySuggestion(
          item.bookmark.id,
          item.bookmark.localRevision,
          cleaned,
          { taskId, batchId }
        );
        if (result.status === 'applied') applied.push({ n: item.n, bookmark: result.bookmark });
        else skipped.push({ n: item.n, reason: '内容没有变化' });
      } catch (error) {
        skipped.push({ n: item.n, reason: toUserMessage(error) });
      }
    }
    return { applied, skipped };
  }

  /** 手动整理材料包：隐私过滤、白名单字段、编号映射与指纹在本地生成。 */
  async buildOrganizePack(input: {
    scope: 'all' | 'uncategorized' | 'selected';
    selectedIds: string[];
    maxItems?: number;
  }): Promise<{
    batchId: string;
    materialText: string;
    items: { n: number; bookmark: Bookmark; inputHash: string }[];
    policyVersion: number;
    notice: string | null;
  }> {
    const [bookmarks, categories, tags, policy] = await Promise.all([
      this.repos.bookmarks.listActive(),
      this.repos.categories.list(),
      this.repos.tags.list(),
      this.repos.settings.getPolicy(),
    ]);
    const eligible = bookmarks.filter(
      (bookmark) => !bookmark.privacy.localOnly && !bookmark.privacy.aiBlocked && !bookmark.deletedAt
    );
    let scoped = eligible;
    if (input.scope === 'uncategorized') scoped = eligible.filter((b) => !b.categoryId);
    if (input.scope === 'selected') {
      const set = new Set(input.selectedIds);
      scoped = eligible.filter((b) => set.has(b.id));
    }
    const max = input.maxItems ?? LIMITS.aiItemsPerPart;
    let warning: string | null = null;
    if (scoped.length > max) {
      warning = `范围内有 ${scoped.length} 条，本次仅取前 ${max} 条；其余请分批整理。`;
      scoped = scoped.slice(0, max);
    }
    if (scoped.length === 0) {
      throw new AppError('INVALID_INPUT', '该范围没有可发送给 AI 的收藏。');
    }
    const items: AiInputItem[] = [];
    const hashes: { n: number; bookmark: Bookmark; inputHash: string }[] = [];
    for (let index = 0; index < scoped.length; index += 1) {
      const bookmark = scoped[index] as Bookmark;
      const n = index + 1;
      items.push(buildAiItem(bookmark, n));
      hashes.push({ n, bookmark, inputHash: await computeInputHash(bookmark) });
    }
    const batchId = newId();
    const material = buildOrganizeMaterial({
      batchId,
      part: 1,
      policyVersion: policy.policyVersion,
      instruction: policy.instruction || AI_INSTRUCTION,
      categories,
      tags,
      items,
    });
    const materialText = JSON.stringify(material, null, 2);
    return {
      batchId,
      materialText,
      items: hashes,
      policyVersion: policy.policyVersion,
      notice: warning,
    };
  }

  async buildAskPack(input: {
    question: string;
    bookmarkIds: string[];
  }): Promise<{ text: string; chars: number; items: Bookmark[] }> {
    const question = input.question.trim();
    if (!question) throw new AppError('INVALID_INPUT', '请先填写问题。');
    if ([...question].length > LIMITS.questionChars) {
      throw new AppError('INVALID_INPUT', `问题最多 ${LIMITS.questionChars} 个字符。`);
    }
    const bookmarks = await this.repos.bookmarks.listActive();
    const chosen = input.bookmarkIds
      .map((id) => bookmarks.find((bookmark) => bookmark.id === id))
      .filter((bookmark): bookmark is Bookmark => Boolean(bookmark))
      .filter((bookmark) => !bookmark.privacy.localOnly && !bookmark.privacy.aiBlocked);
    if (chosen.length === 0) {
      throw new AppError('INVALID_INPUT', '所选资料为空或全部被隐私规则排除。');
    }
    const material = buildAskMaterial({
      question,
      items: chosen.map((bookmark, index) => buildAiItem(bookmark, index + 1)),
    });
    if (material.chars > LIMITS.aiReplyChars) {
      throw new AppError('INVALID_INPUT', '所选资料超出提问包上限，请减少资料后重试。');
    }
    return { text: material.text, chars: material.chars, items: chosen };
  }

  /** 严格校验 AI 回复：字段白名单、编号、重复、隐私与指纹。 */
  async validateAiReply(input: {
    text: string;
    batchId: string;
    items: { n: number; bookmark: Bookmark; inputHash: string }[];
    policyVersion: number;
  }): Promise<{
    applied: { n: number; bookmark: Bookmark; patch: NonNullable<AIReply['results'][number]['patch']>; reason: string }[];
    rejected: { n: number; title: string; reason: string }[];
    warnings: string[];
  }> {
    const raw = extractJsonObject(input.text) as Record<string, unknown>;
    const envelope = z
      .object({
        protocolVersion: z.literal(AI_PROTOCOL_VERSION),
        batchId: z.string().min(1).max(64),
        part: z.number().int().min(1).max(99),
        results: z.array(z.unknown()).max(LIMITS.importRows),
      })
      .strict()
      .safeParse(raw);
    if (!envelope.success) {
      throw new AppError(
        'INVALID_AI_REPLY',
        `回复结构不合法：${envelope.error.issues[0]?.message ?? ''}`
      );
    }
    if (envelope.data.batchId !== input.batchId) {
      throw new AppError('INVALID_AI_REPLY', '批次编号不匹配，请使用本次导出的材料包。');
    }
    const policy = await this.repos.settings.getPolicy();
    if (policy.policyVersion !== input.policyVersion) {
      throw new AppError('STALE_SUGGESTION', '整理策略已更新，请重新导出材料包。');
    }
    const seen = new Set<number>();
    const knownCategories = await this.repos.categories.list();
    const knownTags = await this.repos.tags.list();
    const applied: {
      n: number;
      bookmark: Bookmark;
      patch: NonNullable<AIReply['results'][number]['patch']>;
      reason: string;
    }[] = [];
    const rejected: { n: number; title: string; reason: string }[] = [];
    const warnings: string[] = [];

    for (const entry of envelope.data.results) {
      // 先按条校验，未知字段、非法类型只拒绝该条，不牵连整批。
      const itemResult = AISuggestionSchema.safeParse(entry);
      if (!itemResult.success) {
        const rawEntry = entry as Record<string, unknown>;
        const n = typeof rawEntry['n'] === 'number' ? rawEntry['n'] : 0;
        const echo = typeof rawEntry['titleEcho'] === 'string' ? rawEntry['titleEcho'] : '';
        const firstIssue = itemResult.error.issues[0];
        const field = firstIssue?.path.join('.') || '结构';
        rejected.push({
          n,
          title: echo,
          reason: `字段不合法（${field}）：${firstIssue?.message ?? '未知字段或类型错误'}`,
        });
        continue;
      }
      const result = itemResult.data;
      if (seen.has(result.n)) {
        rejected.push({ n: result.n, title: result.titleEcho, reason: '编号重复' });
        continue;
      }
      seen.add(result.n);
      const mapping = input.items.find((item) => item.n === result.n);
      if (!mapping) {
        rejected.push({ n: result.n, title: result.titleEcho, reason: '未知编号' });
        continue;
      }
      const current = await this.repos.bookmarks.get(mapping.bookmark.id);
      if (!current || current.deletedAt) {
        rejected.push({ n: result.n, title: mapping.bookmark.title, reason: '条目已删除' });
        continue;
      }
      if (current.privacy.localOnly || current.privacy.aiBlocked) {
        rejected.push({ n: result.n, title: current.title, reason: '隐私设置已禁止发送' });
        continue;
      }
      if (current.localRevision !== mapping.bookmark.localRevision) {
        rejected.push({ n: result.n, title: current.title, reason: '预览后内容已变化，请重新导出' });
        continue;
      }
      if ((await computeInputHash(current)) !== mapping.inputHash) {
        rejected.push({ n: result.n, title: current.title, reason: '输入指纹不匹配' });
        continue;
      }
      if (result.status !== 'ok' || !result.patch) {
        rejected.push({ n: result.n, title: current.title, reason: '模型标记为需要人工判断' });
        continue;
      }
      const patch = result.patch;
      if (patch.categoryId !== undefined && patch.categoryId !== null) {
        if (!knownCategories.some((entry) => entry.id === patch.categoryId)) {
          rejected.push({ n: result.n, title: current.title, reason: '建议的分类不存在，需要先创建分类' });
          continue;
        }
      }
      if (patch.tagIds !== undefined && patch.tagIds.some((id) => !knownTags.some((tag) => tag.id === id))) {
        rejected.push({ n: result.n, title: current.title, reason: '建议包含不存在的标签' });
        continue;
      }
      if (current.lockedFields.includes('categoryId') && patch.categoryId !== undefined) {
        rejected.push({ n: result.n, title: current.title, reason: '分类已被人工锁定' });
        continue;
      }
      applied.push({ n: result.n, bookmark: current, patch, reason: result.reason });
    }
    const missing = input.items.filter((item) => !seen.has(item.n));
    if (missing.length) warnings.push(`有 ${missing.length} 条未返回结果，保持原样。`);
    return { applied, rejected, warnings };
  }
}

export function createWorkspaceService(repos: Repositories): WorkspaceService {
  return new WorkspaceService(repos);
}
