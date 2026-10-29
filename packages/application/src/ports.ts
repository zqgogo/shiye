import type {
  AISuggestionPatch,
  AppSettings,
  AppliedChange,
  BackupDocument,
  Bookmark,
  BookmarkPatch,
  Category,
  HandoffBatch,
  HandoffItem,
  HandoffBatchStatus,
  ImportBatch,
  ImportDestination,
  ImportRow,
  ImportSource,
  Policy,
  ReadingItem,
  Tag,
  Tombstone,
} from '@shiye/core';

export type FieldSource = 'human' | 'ai';

export interface CreateBookmarkParams {
  id?: string;
  originalUrl: string;
  title?: string;
  sourceDescription?: string;
  note?: string;
  selectedText?: string;
  categoryId?: string | null;
  tagIds?: string[];
  inboxUnread?: boolean;
  privacy?: { localOnly?: boolean; aiBlocked?: boolean };
  sourceType?: 'extension' | 'manual' | 'html' | 'json';
  sourceFolder?: string;
  importBatchId?: string;
  pinned?: boolean;
  createdAt?: string;
}

export interface CreateReadingParams {
  id?: string;
  originalUrl: string;
  title?: string;
  note?: string;
  relatedBookmarkId?: string | null;
  sourceType?: 'extension' | 'manual' | 'html' | 'json';
  sourceFolder?: string;
  importBatchId?: string;
}

export interface ConvertReadingParams {
  categoryId?: string | null;
  title?: string;
  note?: string;
  tagIds?: string[];
}

export interface BookmarkRepository {
  get(id: string): Promise<Bookmark | undefined>;
  listActive(): Promise<Bookmark[]>;
  listDeleted(): Promise<Bookmark[]>;
  findByCanonical(canonicalUrl: string): Promise<Bookmark | undefined>;
  findAnyByCanonical(canonicalUrl: string): Promise<Bookmark | undefined>;
  create(params: CreateBookmarkParams): Promise<Bookmark>;
  update(
    id: string,
    expectedLocalRevision: number,
    patch: BookmarkPatch,
    source: FieldSource
  ): Promise<Bookmark>;
  softDelete(id: string): Promise<Bookmark>;
  restore(id: string): Promise<Bookmark>;
  markRead(ids: string[]): Promise<number>;
  markUnread(ids: string[]): Promise<number>;
  setPinned(id: string, pinned: boolean): Promise<Bookmark>;
  touchOpened(id: string): Promise<void>;
  /** AI 建议应用：事务内复核版本、隐私、锁定与分类引用，并写入应用日志。 */
  applySuggestion(
    id: string,
    expectedLocalRevision: number,
    patch: AISuggestionPatch,
    context: { taskId: string; batchId: string }
  ): Promise<{ status: 'applied' | 'unchanged'; bookmark: Bookmark }>;
  /**
   * 撤销一条应用记录：把 before 值写回去。
   * 只有在这条收藏应用后没再被修改时才允许，否则返回冲突，不能覆盖后续人工修改。
   */
  revertChange(changeId: string): Promise<{
    status: 'reverted' | 'conflict' | 'skipped';
    reason?: string;
  }>;
}

export interface ReadingRepository {
  get(id: string): Promise<ReadingItem | undefined>;
  listPending(): Promise<ReadingItem[]>;
  listCompleted(): Promise<ReadingItem[]>;
  findByCanonical(canonicalUrl: string): Promise<ReadingItem | undefined>;
  add(params: CreateReadingParams): Promise<{ item: ReadingItem; reactivated: boolean }>;
  complete(id: string): Promise<ReadingItem>;
  reopen(id: string): Promise<ReadingItem>;
  purgeCompleted(): Promise<number>;
  convertToBookmark(
    queueId: string,
    expectedLocalRevision: number,
    params: ConvertReadingParams
  ): Promise<{ bookmark: Bookmark; item: ReadingItem }>;
}

export interface CategoryRepository {
  list(): Promise<Category[]>;
  create(name: string, description?: string): Promise<Category>;
  rename(id: string, patch: { name?: string; description?: string }): Promise<Category>;
  remove(id: string, migrateTo: string | null): Promise<{ movedBookmarks: number }>;
}

export interface TagRepository {
  list(): Promise<Tag[]>;
  create(name: string): Promise<Tag>;
}

export interface SettingsRepository {
  getApp(): Promise<AppSettings>;
  updateApp(patch: Partial<Pick<AppSettings,
    'pinnedCategoryIds' | 'includeNoteInSnapshot' | 'includeTextInSnapshot'
  >>): Promise<AppSettings>;
  getPolicy(): Promise<Policy>;
  updatePolicy(instruction: string): Promise<Policy>;
  bumpPolicyVersion(): Promise<Policy>;
}

export interface CommitImportParams {
  batchId: string;
  source: ImportSource;
  fileName: string;
  fileHash: string | null;
  destination: ImportDestination;
  rows: ImportRow[];
}

export interface CommitImportResult {
  batch: ImportBatch;
  inserted: number;
  skipped: number;
  skippedReasons: { line: number; reason: string }[];
  createdIds: string[];
}

export interface ImportRepository {
  commit(params: CommitImportParams): Promise<CommitImportResult>;
  getBatch(id: string): Promise<ImportBatch | undefined>;
  listBatches(): Promise<ImportBatch[]>;
}

export interface CreateHandoffParams {
  id: string;
  protocolVersion: 2;
  policyVersion: number;
  libraryId: string;
  materialText: string;
  items: {
    n: number;
    part: number;
    bookmarkId: string;
    baseRevision: number;
    baseLocalRevision: number;
    inputHash: string;
  }[];
}

export interface HandoffRepository {
  /** 批次与编号映射必须落库：刷新、重开浏览器后仍要能续接同一批。 */
  createBatch(params: CreateHandoffParams): Promise<HandoffBatch>;
  getBatch(id: string): Promise<HandoffBatch | undefined>;
  listBatches(limit?: number): Promise<HandoffBatch[]>;
  listItems(batchId: string): Promise<HandoffItem[]>;
  /** 校验回复后回写每条的状态、建议与原因。 */
  saveItemResults(
    batchId: string,
    results: {
      n: number;
      status: HandoffItem['status'];
      patch: AISuggestionPatch | null;
      reason: string;
    }[]
  ): Promise<void>;
  setStatus(batchId: string, status: HandoffBatchStatus): Promise<void>;
  listAppliedChanges(batchId: string): Promise<AppliedChange[]>;
}

export interface RestoreResult {
  mode: 'merge' | 'replace';
  bookmarksAdded: number;
  bookmarksSkipped: number;
  readingAdded: number;
  categoriesAdded: number;
  tagsAdded: number;
  tombstonesAdded: number;
  /** 备份引用了本次未恢复的分类或标签：引用已清空，逐处计数。 */
  danglingReferences: number;
  /** 替换时被作废的在途 AI 交接批次数量（旧主库的编号映射不再可用）。 */
  handoffInvalidated: number;
  /** 替换让主库身份发生变化时给出前后值；合并或身份未变时为 null。 */
  librarySwitch: { from: string; to: string } | null;
  warnings: string[];
}

export interface BackupRepository {
  exportDocument(options: { includeLocalOnly: boolean }): Promise<BackupDocument>;
  restore(
    document: BackupDocument,
    mode: 'merge' | 'replace'
  ): Promise<RestoreResult>;
  listTombstones(): Promise<Tombstone[]>;
}

export interface Repositories {
  bookmarks: BookmarkRepository;
  reading: ReadingRepository;
  categories: CategoryRepository;
  tags: TagRepository;
  settings: SettingsRepository;
  imports: ImportRepository;
  handoff: HandoffRepository;
  backup: BackupRepository;
}
