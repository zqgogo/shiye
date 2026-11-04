import { z } from 'zod';

export const MIRROR_PROTOCOL = 1;
export const MIRROR_LIMITS = { records: 50000, chunks: 2000, chunkRecords: 50, chunkBytes: 180000, totalBytes: 24 * 1024 * 1024 } as const;
const id = z.string().min(1).max(80);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const address = z.string().max(8192).refine((value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } });
export const MirrorRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bookmark'), id, title: z.string().max(300), url: address,
    categoryId: id.nullable(), tagIds: z.array(id).max(30), pinned: z.boolean(), unread: z.boolean() }).strict(),
  z.object({ kind: z.literal('reading'), id, title: z.string().max(300), url: address }).strict(),
  z.object({ kind: z.literal('category'), id, name: z.string().min(1).max(60), parentId: id.nullable() }).strict(),
  z.object({ kind: z.literal('tag'), id, name: z.string().min(1).max(40) }).strict(),
]);
export type MirrorRecord = z.infer<typeof MirrorRecordSchema>;
export const MirrorIdentitySchema = z.object({ serverId: id, libraryId: id, epoch: id }).strict();
export type MirrorIdentity = z.infer<typeof MirrorIdentitySchema>;
export const MirrorInfoSchema = MirrorIdentitySchema.extend({ protocol: z.literal(MIRROR_PROTOCOL), revision: z.number().int().nonnegative(), activeGeneration: z.string().uuid().nullable(), publishedAt: z.string().nullable() }).strict();
export type MirrorInfo = z.infer<typeof MirrorInfoSchema>;
export const CreateGenerationSchema = z.object({ identity: MirrorIdentitySchema, generationId: z.string().uuid(), baseRevision: z.number().int().nonnegative(),
  chunkCount: z.number().int().min(1).max(MIRROR_LIMITS.chunks), recordCount: z.number().int().nonnegative().max(MIRROR_LIMITS.records), contentHash: hash }).strict();
export type CreateGeneration = z.infer<typeof CreateGenerationSchema>;
export const ChunkSchema = z.object({ identity: MirrorIdentitySchema, records: z.array(MirrorRecordSchema).max(MIRROR_LIMITS.chunkRecords), hash }).strict();
export const PublishSchema = z.object({ identity: MirrorIdentitySchema }).strict();
export const ClearMirrorSchema = PublishSchema.extend({ baseRevision: z.number().int().nonnegative() }).strict();
export const ReadChunkSchema = z.object({ generationId: z.string().uuid(), index: z.number().int().nonnegative(), chunkCount: z.number().int().positive(), records: z.array(MirrorRecordSchema).max(MIRROR_LIMITS.chunkRecords) }).strict();

export async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
export function sameIdentity(a: MirrorIdentity, b: MirrorIdentity): boolean { return a.serverId === b.serverId && a.libraryId === b.libraryId && a.epoch === b.epoch; }

/** Validate a whole generation before its pointer becomes visible. */
export function validateMirror(records: MirrorRecord[]): void {
  if (records.length > MIRROR_LIMITS.records) throw new Error('镜像条数超过上限。');
  const keys = new Set<string>();
  const categories = new Map(records.filter((row) => row.kind === 'category').map((row) => [row.id, row]));
  const tags = new Set(records.filter((row) => row.kind === 'tag').map((row) => row.id));
  const names = new Set<string>();
  for (const row of records) {
    const key = `${row.kind}:${row.id}`;
    if (keys.has(key)) throw new Error('镜像中出现重复编号。'); keys.add(key);
    if (row.kind === 'category') {
      const sibling = JSON.stringify([row.parentId, row.name]);
      if (names.has(sibling)) throw new Error('镜像目录存在同级重名。'); names.add(sibling);
      const visited = new Set([row.id]); let parent = row.parentId;
      while (parent) {
        if (visited.has(parent) || visited.size >= 32) throw new Error('镜像目录循环或超过 32 层。'); visited.add(parent);
        const ancestor = categories.get(parent); if (!ancestor) throw new Error('镜像缺少父目录。'); parent = ancestor.parentId;
      }
    }
    if (row.kind === 'bookmark' && ((row.categoryId && !categories.has(row.categoryId)) || row.tagIds.some((id) => !tags.has(id)))) throw new Error('镜像包含失效分类或标签引用。');
  }
}

export const GenerationStatusSchema = z.object({ declaration: CreateGenerationSchema,
  state: z.enum(['staging', 'published']), received: z.array(z.object({ index: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(MIRROR_LIMITS.chunks),
  expiresAt: z.number() }).strict();
