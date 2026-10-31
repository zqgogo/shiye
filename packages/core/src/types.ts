/** 正式领域类型。命名统一 originalUrl / canonicalUrl；不包含任何价值等级字段。 */

export type Id = string;
export type ISODateTime = string;

export interface Privacy {
  localOnly: boolean;
  aiBlocked: boolean;
}

/** AI 允许写入的字段白名单，不允许任意字段路径。 */
export const AI_WRITABLE_FIELDS = ['categoryId', 'tagIds', 'aiPurpose'] as const;
export type AIField = (typeof AI_WRITABLE_FIELDS)[number];
export type LockableField = AIField;

export type SourceType = 'extension' | 'manual' | 'html' | 'json';

export interface SourceInfo {
  sourceType: SourceType;
  capturedAt: ISODateTime;
  importBatchId?: Id;
  originalFolder?: string;
}

export type LifeState = 'active' | 'deleted';
export type UnreadFlag = 0 | 1;

export interface AcceptedAnalysis {
  inputHash: string;
  policyVersion: number;
  acceptedAt: ISODateTime;
}

/**
 * 收藏。lifeState / unreadFlag / categoryKey 是由业务字段派生的索引键，
 * 只为 IndexedDB 查询服务，写入时统一由仓库生成，界面不直接读写。
 */
export interface Bookmark {
  id: Id;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  sourceDescription: string;
  aiPurpose: string;
  note: string;
  selectedText: string;
  categoryId: Id | null;
  tagIds: Id[];
  inboxUnread: boolean;
  pinned: boolean;
  lastOpenedAt: ISODateTime | null;
  privacy: Privacy;
  lockedFields: LockableField[];
  sources: SourceInfo[];
  /** v1a 本地持久版本；v1b 切换成云端确认版本。 */
  revision: number;
  /** 本地并发 / 草稿保护序号，不由远端覆盖。 */
  localRevision: number;
  changeVersion: number | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;
  acceptedAnalysis?: AcceptedAnalysis;
  // 派生索引键（写库时生成）
  lifeState: LifeState;
  unreadFlag: UnreadFlag;
  categoryKey: string;
}

export interface ReadingItem {
  id: Id;
  originalUrl: string;
  canonicalUrl: string;
  title: string;
  note: string;
  status: 'pending' | 'completed';
  addedAt: ISODateTime;
  completedAt: ISODateTime | null;
  relatedBookmarkId: Id | null;
  sources: SourceInfo[];
  revision: number;
  localRevision: number;
  changeVersion: number | null;
}

export interface Category {
  id: Id;
  name: string;
  description: string;
  revision: number;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Tag {
  id: Id;
  name: string;
  revision: number;
  createdAt: ISODateTime;
}

export interface Policy {
  id: 'default';
  policyVersion: number;
  revision: number;
  instruction: string;
  examples: { bookmarkId: Id; reason: string }[];
  updatedAt: ISODateTime;
}

export interface AppSettings {
  libraryId: Id;
  pinnedCategoryIds: Id[];
  includeNoteInSnapshot: boolean;
  includeTextInSnapshot: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type EntityType = 'bookmark' | 'readingItem' | 'category' | 'tag' | 'policy';

export interface Tombstone {
  entityType: EntityType;
  id: Id;
  revision: number;
  changeVersion: number | null;
  deletedAt: ISODateTime;
  privacyScope: 'main' | 'local';
  /** 收藏墓碑保留规范化 URL，防止旧备份普通导入复活。 */
  canonicalUrl?: string;
  title?: string;
}

export type ImportDestination = 'reading' | 'library';
export type ImportSource = 'paste' | 'bookmarkHtml';

/**
 * 撤回一批导入时，某个条目为什么被留下。
 *
 * 顺序即判定优先级：先看它还在不在，再看它变成了什么，最后才是「有没有被改过」——
 * 否则一条已经完成又被编辑过的待看，会被笼统报成「改过」，用户看不出真实的处理结果。
 */
export type ImportUndoReason =
  /** 导入后被编辑、改分类 / 标签 / 隐私、应用过 AI 建议或标记过已读，版本号已递增。 */
  | 'modified'
  /** 已经移入回收站。软删除本身也递增版本，撤回不替用户撤销这个决定。 */
  | 'trashed'
  /** 待看已完成。之后的处理不是一次错误导入能盲目回滚的内容。 */
  | 'completed'
  /** 待看已经转成收藏，实体仍在本批名下，但形态变了。 */
  | 'converted'
  /** 实体已经不在了：用户自己删了、被别的清理带走，或从未真正写入。 */
  | 'missing';

export interface ImportUndoItem {
  entityId: Id;
  title: string;
  originalUrl: string;
  reason: ImportUndoReason;
}

/** 撤回后要长期留档的三类计数，刷新或关页之后仍然可查。 */
export interface ImportUndoCounts {
  removed: number;
  kept: number;
  missing: number;
}

export interface ImportBatch {
  id: Id;
  source: ImportSource;
  fileName: string;
  fileHash: string | null;
  destination: ImportDestination;
  /** reverted = 这批写入已被撤销；批次本身留着，撤销与重导都有据可查。 */
  status: 'planned' | 'applied' | 'failed' | 'reverted';
  total: number;
  inserted: number;
  skipped: number;
  invalid: number;
  createdAt: ISODateTime;
  appliedAt: ISODateTime | null;
  error: string | null;
  /** 撤回时间；未撤回为 null。 */
  revertedAt: ISODateTime | null;
  /** 撤回时的三类计数；未撤回为 null。之后 importItems 会被清掉，只能靠它回看。 */
  undoCounts: ImportUndoCounts | null;
  /** 撤回时被留下的条目及原因，供事后查看；未撤回为空数组。 */
  undoKept: ImportUndoItem[];
}

export interface ImportItem {
  batchId: Id;
  sourceKey: string;
  entityId: Id;
}

export type ImportRowStatus = 'new' | 'duplicate' | 'invalid' | 'suspected';

export interface ImportRow {
  sourceKey: string;
  line: number;
  originalUrl: string;
  canonicalUrl: string | null;
  title: string;
  sourceFolder: string;
  targetCategoryId: Id | null;
  status: ImportRowStatus;
  reason: string;
  selected: boolean;
  /** 行内去重时，指向保留行的 sourceKey。 */
  duplicateOf: string | null;
}

/**
 * 彻底清空前的作用范围统计。
 *
 * 记录必须拆成「在库」与「回收站」两项：清空是按整张表过滤的，回收站里的记录
 * 也在删除范围内，只报当前列表条数会让确认框的数字小于实际删除量。
 * `tombstones` 是被连带清掉的删除标记条数（它们不是记录，但同样不可恢复）。
 */
export interface PurgeCounts {
  active: number;
  trashed: number;
  tombstones: number;
}

/** 触发清理快照的硬删除入口。软删除与移除单条待看不在此列。 */
export type PurgeEntry =
  | 'all'
  | 'category'
  | 'uncategorized'
  | 'readingPending'
  | 'readingCompleted'
  | 'importBatch';

export interface PurgeSnapshotCounts {
  bookmarks: number;
  readingItems: number;
  tombstones: number;
}

export interface PurgeRestoreCounts {
  restored: number;
  skipped: number;
  conflicted: number;
}

/**
 * 一次硬删除前的本机快照。
 *
 * 只存本机、不上传、不随备份导出；恢复只认这里的条目，绝不覆盖当前数据。
 */
export interface PurgeSnapshot {
  id: string;
  createdAt: string;
  entry: PurgeEntry;
  scopeLabel: string;
  dbFingerprint: string;
  bookmarks: Bookmark[];
  readingItems: ReadingItem[];
  tombstones: Tombstone[];
  counts: PurgeSnapshotCounts;
  /** 快照 JSON 字节数，用于总量上限与列表展示。 */
  bytes: number;
  restoredAt: string | null;
  restoredCounts: PurgeRestoreCounts | null;
}

/** 单条恢复判定：`restore` 才写库，`skip` 与 `conflict` 都保持现状。 */
export type PurgeRestoreAction = 'restore' | 'skip' | 'conflict';

export interface PurgeRestoreDecision {
  id: string;
  title: string;
  action: PurgeRestoreAction;
  reason: string;
}

export interface PurgeRestorePreview {
  snapshotId: string;
  entry: PurgeEntry;
  scopeLabel: string;
  createdAt: string;
  candidates: number;
  restorable: number;
  skipped: number;
  conflicted: number;
  decisions: PurgeRestoreDecision[];
}

export interface ImportParseWarning {
  code:
    | 'DEPTH_LIMIT'
    | 'NODE_LIMIT'
    | 'TITLE_TRUNCATED'
    | 'EMPTY'
    | 'NO_LINKS'
    | 'ENCODING'
    | 'BROKEN_STRUCTURE';
  message: string;
  line?: number;
}

export interface ParsedImportEntry {
  sourceKey: string;
  line: number;
  originalUrl: string;
  title: string;
  sourceFolder: string;
}

export interface ImportParseResult {
  entries: ParsedImportEntry[];
  warnings: ImportParseWarning[];
  nodes: number;
}

export type HandoffBatchStatus = 'exported' | 'partial' | 'applied' | 'invalidated';

export interface HandoffBatch {
  id: Id;
  protocolVersion: 2;
  createdAt: ISODateTime;
  policyVersion: number;
  libraryId: Id;
  status: HandoffBatchStatus;
  parts: number;
  itemCount: number;
  /**
   * 实际交给外部 AI 的材料原文。
   * 刷新后要能原样续接同一批次，不能靠当前数据重新拼——内容一变，
   * 回复里的编号就对不上当时的输入了。
   */
  materialText?: string | undefined;
}

export interface HandoffItem {
  batchId: Id;
  n: number;
  part: number;
  bookmarkId: Id;
  baseRevision: number;
  baseLocalRevision: number;
  inputHash: string;
  status: 'pending' | 'invalid' | 'applied' | 'skipped';
  patch: AISuggestionPatch | null;
  reason: string;
}

export interface AISuggestionPatch {
  categoryId?: Id | null | undefined;
  tagIds?: Id[] | undefined;
  aiPurpose?: string | undefined;
}

export interface AISuggestion {
  n: number;
  domain: string;
  titleEcho: string;
  patch: AISuggestionPatch;
  reason: string;
  status: 'ok' | 'needsReview';
}

export interface AIReply {
  protocolVersion: 2;
  batchId: Id;
  part: number;
  results: AISuggestion[];
}

export interface AppliedChange {
  id: Id;
  taskId: Id;
  batchId: Id;
  bookmarkId: Id;
  appliedAt: ISODateTime;
  changedFields: AIField[];
  before: Partial<Record<AIField, unknown>>;
  after: Partial<Record<AIField, unknown>>;
  appliedLocalRevision: number;
  undoneAt: ISODateTime | null;
}

export interface AiConfig {
  adapter: 'openai_compatible';
  baseUrl: string;
  model: string;
  credentialVersion: number;
  enabled: boolean;
  tested: { configFingerprint: string; testedAt: ISODateTime } | null;
}

export type AiTaskKind = 'ask' | 'organize';
export type AiTaskState =
  | 'idle'
  | 'preparing'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';

export interface AiTask {
  id: Id;
  kind: AiTaskKind;
  configFingerprint: string;
  state: AiTaskState;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  snapshots: { itemId: Id; localRevision: number; inputHash: string }[];
  errorCode: string | null;
}

/**
 * 备份里被有意排除的条目。恢复端据此解释「为什么条数比主库少」，
 * 而不是让用户自己发现少了东西。
 */
export interface BackupExclusions {
  /** 关联到本地专用收藏的待看：收藏不进默认备份，它的衍生待看也不该进。 */
  readingForLocalOnly: number;
}

export interface BackupDocument {
  schemaVersion: number;
  libraryId: Id;
  exportedAt: ISODateTime;
  dataCutoffAt: ISODateTime;
  scope: 'device';
  includesLocalOnly: boolean;
  categories: Category[];
  tags: Tag[];
  policy: Policy | null;
  settings: AppSettings | null;
  bookmarks: Bookmark[];
  readingItems: ReadingItem[];
  tombstones: Tombstone[];
  exclusions?: BackupExclusions;
}

export type LocalWriteStatus = 'applied' | 'unchanged' | 'conflict' | 'rejected';

export interface LocalWriteResult<T> {
  status: LocalWriteStatus;
  value?: T;
  current?: T;
  code?: string;
  message?: string;
}
