import { z } from 'zod';
import { AI_PROTOCOL_VERSION, LIMITS, SCHEMA_VERSION } from './constants.js';
import { AppError } from './errors.js';

const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON.parse 之后仍需检查原型键，strict schema 只保证键集合。 */
export function assertNoPrototypeKeys(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrototypeKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (dangerousKeys.has(key)) {
      throw new AppError('INVALID_INPUT', `输入包含不允许的字段名（${path}.${key}）。`);
    }
    assertNoPrototypeKeys(child, `${path}.${key}`);
  }
}

const isoString = z.string().min(4).max(40);
const idString = z.string().min(1).max(64);

export const PrivacySchema = z
  .object({ localOnly: z.boolean(), aiBlocked: z.boolean() })
  .strict();

export const SourceInfoSchema = z
  .object({
    sourceType: z.enum(['extension', 'manual', 'html', 'json']),
    capturedAt: isoString,
    importBatchId: idString.optional(),
    originalFolder: z.string().max(1000).optional(),
  })
  .strict();

export const BookmarkCreateSchema = z
  .object({
    id: idString.optional(),
    originalUrl: z.string().min(1).max(LIMITS.url),
    title: z.string().max(LIMITS.title).optional(),
    sourceDescription: z.string().max(LIMITS.sourceDescription).optional(),
    note: z.string().max(LIMITS.note).optional(),
    selectedText: z.string().max(LIMITS.selectedText).optional(),
    categoryId: idString.nullable().optional(),
    tagIds: z.array(idString).max(LIMITS.tagsPerBookmark).optional(),
    inboxUnread: z.boolean().optional(),
    privacy: PrivacySchema.partial().optional(),
    sourceType: z.enum(['extension', 'manual', 'html', 'json']).optional(),
    sourceFolder: z.string().max(1000).optional(),
    importBatchId: idString.optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

export type BookmarkCreateInput = z.infer<typeof BookmarkCreateSchema>;

const aiFieldPatch = {
  categoryId: idString.nullable().optional(),
  tagIds: z.array(idString).max(LIMITS.tagsPerBookmark).optional(),
  aiPurpose: z.string().max(LIMITS.aiPurpose).optional(),
};

export const BookmarkPatchSchema = z
  .object({
    title: z.string().max(LIMITS.title).optional(),
    sourceDescription: z.string().max(LIMITS.sourceDescription).optional(),
    aiPurpose: aiFieldPatch.aiPurpose,
    note: z.string().max(LIMITS.note).optional(),
    selectedText: z.string().max(LIMITS.selectedText).optional(),
    categoryId: aiFieldPatch.categoryId,
    tagIds: aiFieldPatch.tagIds,
    pinned: z.boolean().optional(),
    inboxUnread: z.boolean().optional(),
    privacy: PrivacySchema.optional(),
    lockedFields: z.array(z.enum(['categoryId', 'tagIds', 'aiPurpose'])).max(3).optional(),
  })
  .strict();

export type BookmarkPatch = z.infer<typeof BookmarkPatchSchema>;

export const ReadingCreateSchema = z
  .object({
    id: idString.optional(),
    originalUrl: z.string().min(1).max(LIMITS.url),
    title: z.string().max(LIMITS.title).optional(),
    note: z.string().max(LIMITS.note).optional(),
    relatedBookmarkId: idString.nullable().optional(),
    sourceType: z.enum(['extension', 'manual', 'html', 'json']).optional(),
    sourceFolder: z.string().max(1000).optional(),
    importBatchId: idString.optional(),
  })
  .strict();

export type ReadingCreateInput = z.infer<typeof ReadingCreateSchema>;

export const CategoryCreateSchema = z
  .object({
    name: z.string().min(1).max(LIMITS.categoryName),
    description: z.string().max(LIMITS.categoryDescription).optional(),
  })
  .strict();

export const CategoryPatchSchema = z
  .object({
    name: z.string().min(1).max(LIMITS.categoryName).optional(),
    description: z.string().max(LIMITS.categoryDescription).optional(),
  })
  .strict();

export const TagCreateSchema = z.object({ name: z.string().min(1).max(LIMITS.tagName) }).strict();

/** AI 回复：单一 JSON 对象，严格白名单，禁止未知字段与任意嵌套。 */
export const AISuggestionSchema = z
  .object({
    n: z.number().int().positive().max(LIMITS.importRows),
    domain: z.string().max(300),
    titleEcho: z.string().max(LIMITS.title),
    patch: z
      .object({
        categoryId: idString.nullable().optional(),
        tagIds: z.array(idString).max(LIMITS.tagsPerBookmark).optional(),
        aiPurpose: z.string().max(LIMITS.aiPurposeSuggestion).optional(),
      })
      .strict()
      .optional(),
    reason: z.string().max(1000),
    status: z.enum(['ok', 'needsReview']),
  })
  .strict();

export const AIReplySchema = z
  .object({
    protocolVersion: z.literal(AI_PROTOCOL_VERSION),
    batchId: idString,
    part: z.number().int().min(1).max(99),
    results: z.array(AISuggestionSchema).max(LIMITS.importRows),
  })
  .strict();

export type AIReplyInput = z.infer<typeof AIReplySchema>;

const looseRecord = z.record(z.unknown());

/** 备份文件只做结构校验；逐字段清洗在 storage 的恢复用例中执行。 */
export const BackupEnvelopeSchema = z
  .object({
    schemaVersion: z.number().int().min(1).max(99),
    libraryId: idString,
    exportedAt: isoString,
    dataCutoffAt: isoString.optional(),
    scope: z.literal('device').optional(),
    includesLocalOnly: z.boolean().optional(),
    categories: z.array(looseRecord).max(2000),
    tags: z.array(looseRecord).max(5000),
    policy: looseRecord.nullable().optional(),
    settings: looseRecord.nullable().optional(),
    bookmarks: z.array(looseRecord).max(200_000),
    readingItems: z.array(looseRecord).max(200_000),
    tombstones: z.array(looseRecord).max(200_000).optional(),
  })
  .passthrough();

export type BackupEnvelope = z.infer<typeof BackupEnvelopeSchema>;

export function parseBackup(input: unknown): BackupEnvelope {
  assertNoPrototypeKeys(input);
  const parsed = BackupEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('INVALID_INPUT', `备份文件结构不正确：${parsed.error.issues[0]?.message ?? '未知错误'}`);
  }
  if (parsed.data.schemaVersion > SCHEMA_VERSION) {
    throw new AppError(
      'UNSUPPORTED_VERSION',
      `备份格式版本 ${parsed.data.schemaVersion} 高于当前主库版本 ${SCHEMA_VERSION}，请升级扩展后再恢复。`
    );
  }
  return parsed.data;
}

/** 扩展内部消息协议。只接受明确类型，且由 service worker 校验来源。 */
export const ExtensionMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING') }).strict(),
  z.object({ type: z.literal('OPEN_WORKSPACE'), route: z.string().max(64).optional() }).strict(),
  z
    .object({
      type: z.literal('CAPTURE_LINK'),
      url: z.string().min(1).max(LIMITS.url),
      title: z.string().max(LIMITS.title).optional(),
      destination: z.enum(['reading', 'library']),
      selectedText: z.string().max(LIMITS.selectedText).optional(),
    })
    .strict(),
]);

export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;

export function parseExtensionMessage(input: unknown): ExtensionMessage {
  assertNoPrototypeKeys(input);
  const parsed = ExtensionMessageSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('INVALID_INPUT', '不支持的消息格式。');
  }
  return parsed.data;
}

/** AI 回复文本：允许去掉一层完整代码围栏，不接受多段拼接。 */
export function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  if (!text) throw new AppError('INVALID_AI_REPLY', '回复为空。');
  if (text.length > LIMITS.aiReplyChars) {
    throw new AppError('INVALID_AI_REPLY', '回复过长，请分批返回。');
  }
  let body = text;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fenced && fenced[1]) body = fenced[1].trim();
  if (!body.startsWith('{') || !body.endsWith('}')) {
    throw new AppError('INVALID_AI_REPLY', '只接受单一 JSON 对象，请勿附加解释文字。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AppError('INVALID_AI_REPLY', 'JSON 解析失败，请检查引号与逗号。');
  }
  assertNoPrototypeKeys(parsed);
  return parsed;
}
