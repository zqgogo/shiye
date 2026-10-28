/** 设计参考类型，不是已完成的业务实现。以实施任务书与P0结果为准。 */
export type Id = string;
export type Privacy = { localOnly: boolean; aiBlocked: boolean };
export type AIField = 'categoryId' | 'tagIds' | 'aiPurpose';
export type LockableField = AIField;
export interface SourceInfo { sourceType: 'extension'|'manual'|'html'|'json'; capturedAt: string; importBatchId?: Id; originalFolder?: string; }
export interface Bookmark {
  id: Id; originalUrl: string; canonicalUrl: string; title: string;
  sourceDescription: string; aiPurpose: string; note: string; selectedText: string;
  categoryId: Id | null; tagIds: Id[]; inboxUnread: boolean;
  pinned: boolean; lastOpenedAt: string | null; privacy: Privacy;
  lockedFields: LockableField[]; sources: SourceInfo[];
  revision: number; // v1a本地持久版本，v1b切换云端确认版本
  localRevision: number; // 本地并发/草稿保护，不由远端覆盖
  changeVersion: number | null;
  createdAt: string; updatedAt: string; deletedAt: string | null;
  acceptedAnalysis?: { inputHash: string; policyVersion: number; acceptedAt: string };
}
export interface Category { id: Id; name: string; description: string; revision: number; }
export interface Tag { id: Id; name: string; revision: number; }
export interface Policy { id: 'default'; policyVersion: number; revision: number; instruction: string; examples: { bookmarkId: Id; reason: string }[]; }
export type EntityType = 'bookmark'|'readingItem'|'category'|'tag'|'policy';
export interface Tombstone { entityType: EntityType; id: Id; revision: number; changeVersion: number|null; deletedAt: string; privacyScope: 'main'|'local'; }
export interface HandoffBatch { id: Id; protocolVersion: 2; createdAt: string; policyVersion: number; dbEpoch: string|null; status: 'exported'|'partial'|'applied'|'invalidated'; parts: number; }
export interface HandoffItem { batchId: Id; n: number; part: number; bookmarkId: Id; baseRevision: number; baseLocalRevision: number; inputHash: string; baseValues: Record<AIField, unknown>; status: 'pending'|'invalid'|'applied'|'skipped'; }
export interface Suggestion { n: number; domain: string; titleEcho: string; patch: Partial<Pick<Bookmark, AIField>>; reason: string; status: 'ok'|'needsReview'; }
export interface AIReply { protocolVersion: 2; batchId: Id; part: number; results: Suggestion[]; }
export interface AppliedChange { id: Id; taskId: Id; batchId: Id; bookmarkId: Id; appliedAt: string; changedFields: AIField[]; before: Partial<Record<AIField,unknown>>; after: Partial<Record<AIField,unknown>>; appliedLocalRevision: number; undoneAt: string|null; }
export type LocalWriteResult<T> = {status:'applied'|'unchanged';value:T}|{status:'conflict';current:T;fields:string[]}|{status:'rejected';code:string};
export interface BookmarkRepository {
  get(id:Id): Promise<Bookmark|undefined>;
  listActive(): Promise<Bookmark[]>;
  create(input:Bookmark): Promise<LocalWriteResult<Bookmark>>;
  update(id:Id,expectedLocalRevision:number,patch:Partial<Bookmark>,source:'human'|'ai'): Promise<LocalWriteResult<Bookmark>>;
  // 实现必须把允许字段、锁定、隐私、版本检查放在内部；Partial不是授权。
}
// 以下仅v1b需要；不得为v1a启用网络或创建云服务。
export type OutboxState = 'queued'|'sending'|'uncertain'|'reconciling'|'conflict'|'authRequired'|'epochBlocked';
export interface OutboxItem { queueId: Id; entityType:EntityType; entityId:Id; dbEpoch:string; action:'create'|'update'|'delete'|'restore'; baseRevision:number|null; baseValues:Record<string,unknown>; frozenPatch:Record<string,unknown>; state:OutboxState; createdAt:string; }
export interface PullPage { dbEpoch:string; items:unknown[]; nextCursor:number; hasMore:boolean; }

export interface ReadingItem {
  id: Id; originalUrl: string; canonicalUrl: string; title: string; note: string;
  status: 'pending'|'completed'; addedAt: string; completedAt: string|null;
  relatedBookmarkId: Id|null; sources: SourceInfo[];
  revision: number; localRevision: number;
}
export interface ImportRow {
  sourceKey: string; line: number; originalUrl: string; canonicalUrl: string|null;
  title: string; sourceFolder: string; targetCategoryId: Id|null;
  status: 'new'|'duplicate'|'invalid'|'suspected'; reason: string; selected: boolean;
}
export interface AiConfig {
  id: Id; adapter: 'openai_compatible'; baseUrl: string; model: string;
  credentialRef: string|null; credentialVersion: number; enabled: boolean;
  tested: {configFingerprint: string; testedAt: string}|null;
}
export interface AiTask {
  id: Id; kind: 'ask'|'organize'; providerId: Id; configFingerprint: string;
  state: 'idle'|'preparing'|'waiting'|'completed'|'failed'|'cancelled'|'outcome_unknown';
  createdAt: string; snapshots: {itemId: Id; localRevision: number; inputHash: string}[];
}
// Key is never a member of the export/sync or task types. No arbitrary AI field paths.
