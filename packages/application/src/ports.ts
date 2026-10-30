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

/**
 * 应用一条 AI 建议时随写事务一起核对的身份信息。
 *
 * 批次编号、主库身份与策略版本必须和写入在同一个事务里读：先在事务外查一遍、
 * 再开事务写，中间那段时间正是另一个标签页能改策略的窗口。
 */
export interface ApplySuggestionContext {
  taskId: string;
  batchId: string;
  /** 生成材料包时的主库编号；应用时当前主库必须仍是它。 */
  libraryId: string;
  /** 生成材料包时的策略版本；应用时当前策略必须仍是它。 */
  policyVersion: number;
}

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
  /**
   * 彻底清空：删除记录**连同墓碑**，之后同一网址可以重新导入。
   *
   * 只软删除是不够的：墓碑会让重新导入的同一批书签全部被判成「存在已删除收藏」而跳过，
   * 用户看到的仍是「清空了却导不进来」。所以清空必须把删除标记一起带走，
   * 这也意味着它不可恢复——界面上要按这个语义提示。
   */
  purgeAll(): Promise<number>;
  /** 彻底清空某个分类（传 null 表示未分类）下的收藏与对应墓碑；分类本身保留。 */
  purgeCategory(categoryId: string | null): Promise<number>;
  markRead(ids: string[]): Promise<number>;
  markUnread(ids: string[]): Promise<number>;
  setPinned(id: string, pinned: boolean): Promise<Bookmark>;
  touchOpened(id: string): Promise<void>;
/** AI 建议应用：事务内复核版本、隐私、锁定与分类引用，并写入应用日志。 */
  applySuggestion(
    id: string,
    expectedLocalRevision: number,
    patch: AISuggestionPatch,
    context: ApplySuggestionContext
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
  /** 清空整个待看队列（只处理 pending）；不涉及收藏。 */
  purgePending(): Promise<number>;
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

export interface ImportUndoResult {
  batch: ImportBatch;
  /** 真正被移除的条目数。 */
  removed: number;
  /** 导入后被改过（编辑、应用 AI、完成待看…），因此保留不动的条目数。 */
  kept: number;
  /** 已经不在库里的条目数：用户自己删了、转了收藏，或已被别的操作清掉。 */
  missing: number;
}

export interface ImportRepository {
  commit(params: CommitImportParams): Promise<CommitImportResult>;
  getBatch(id: string): Promise<ImportBatch | undefined>;
  listBatches(): Promise<ImportBatch[]>;
  /**
   * 撤销一批导入：把这一批新建的收藏或待看删掉，回到「导入之前」。
   *
   * 只删「原样留着」的条目——导入后被人工改过、应用过 AI 建议、转换过形态的记录一律保留，
   * 撤销是回滚一次误操作，不是覆盖用户之后的决定。已经删掉的条目按墓碑一起清，
   * 否则同一网址重新导入会被自己留下的删除标记挡住。
   */
  undoBatch(batchId: string): Promise<ImportUndoResult>;
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
  /** 合并时按网址判定为重复而跳过的待看数（同一条链接只会留一条 pending）。 */
  readingSkipped: number;
  categoriesAdded: number;
  tagsAdded: number;
  tombstonesAdded: number;
  /** 备份引用了本次未恢复的分类或标签：引用已清空，逐处计数。 */
  danglingReferences: number;
  /** 替换时被作废的在途 AI 交接批次数量（旧主库的编号映射不再可用）。 */
  handoffInvalidated: number;
  /** 替换让主库身份发生变化时给出前后值；合并或身份未变时为 null。 */
  librarySwitch: { from: string; to: string } | null;
  /** 合并时本机已删除、备份里仍为活跃而保留删除的条数（不静默复活）。 */
  keptLocalDeletes: number;
  /** 合并时本机为空，已按「首次迁移」把设置与整理策略一起恢复。 */
  adoptedSettings: boolean;
  /** 备份引用了本地专用收藏的待看，按隐私规则未导出，此数只用于提示。 */
  excludedReading: number;
  warnings: string[];
}

/**
 * 安全备份的持久化副本：替换前先落库，下载失败或页面崩溃后仍能取回。
 *
 * 每份副本带独立编号：下一次替换不得覆盖还没确认保存的副本，清理也要按编号核对，
 * 否则一个停在旧状态的标签页会把别人刚存的新副本删掉。
 */
export interface SafetyCopy {
  id: string;
  text: string;
  savedAt: string;
}

/** 替换前拍下的当前主库快照：既是一份可恢复的文档，也是界面提示要展示的统计来源。 */
export interface SafetySnapshot {
  document: BackupDocument;
  text: string;
  copy: SafetyCopy;
}

export interface BackupRepository {
  exportDocument(options: { includeLocalOnly: boolean }): Promise<BackupDocument>;
  restore(
    document: BackupDocument,
    mode: 'merge' | 'replace'
  ): Promise<RestoreResult>;
  /**
   * 替换专用：快照当前主库、保存安全副本、清库与写入在**同一个事务**里完成。
   *
   * 分开做会留下一个窗口——快照拍完之后、替换提交之前，别的标签页写进来的收藏会被
   * 清库抹掉，而快照里也不含它们：刚显示「已保存」的内容在主库和副本里同时消失。
   */
  restoreWithSafety(
    document: BackupDocument,
    mode: 'merge' | 'replace'
  ): Promise<{ result: RestoreResult; safety: SafetySnapshot | null }>;
  listTombstones(): Promise<Tombstone[]>;
  /**
   * 只校验不写入：替换前先确认整份文件可恢复。
   * 一份注定失败的替换不该先把上一份尚未确认的安全副本覆盖掉。
   */
  validateRestore(document: BackupDocument, mode: 'merge' | 'replace'): Promise<void>;
  /**
   * 替换前把当前主库的完整备份写进 meta：它不参与替换清空，下载失败也能重取。
   * 已有一份未确认的副本时拒绝覆盖（抛 SAFETY_COPY_PENDING）。
   */
  saveSafetyCopy(text: string): Promise<SafetyCopy>;
  readSafetyCopy(): Promise<SafetyCopy | null>;
  /** 只清掉编号一致的那份：旧标签页按旧编号清理不会误删新副本。 */
  clearSafetyCopy(id: string): Promise<void>;
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
