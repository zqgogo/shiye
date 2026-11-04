import { z } from 'zod';
import { CreateGenerationSchema, MIRROR_LIMITS, MirrorRecordSchema, MirrorInfoSchema, MirrorIdentitySchema, byteLength, digest, validateMirror } from './protocol.js';
export const MirrorPlanSchema = z.object({ declaration: CreateGenerationSchema,
  parts: z.array(z.object({ records: z.array(MirrorRecordSchema).max(MIRROR_LIMITS.chunkRecords), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(MIRROR_LIMITS.chunks),
  bytes: z.number().int().nonnegative().max(MIRROR_LIMITS.totalBytes) }).strict();
export type MirrorPlan = z.infer<typeof MirrorPlanSchema>;
export const PublicationSnapshotSchema = z.object({ id: z.string().uuid(), localLibraryId: z.string().min(1), baseUrl: z.string().url().max(2048), createdAt: z.string(), plan: MirrorPlanSchema }).strict();
export type PublicationSnapshot = z.infer<typeof PublicationSnapshotSchema>;
export const PublicationStateSchema = z.object({ id: z.string().uuid(), localLibraryId: z.string().min(1), baseUrl: z.string().url().max(2048),
  identity: MirrorIdentitySchema, state: z.enum(['prepared', 'uploading', 'paused', 'published']), confirmedChunks: z.number().int().nonnegative(), totalChunks: z.number().int().positive().max(MIRROR_LIMITS.chunks),
  lease: z.object({ owner: z.string().uuid(), until: z.number() }).strict().nullable(), receipt: MirrorInfoSchema.nullable() }).strict();
export type PublicationState = z.infer<typeof PublicationStateSchema>;
export interface SavedPublication { snapshot: PublicationSnapshot; status: PublicationState; }
export const PUBLICATION_LEASE_MS = 120000;
export async function validateMirrorPlan(raw: unknown): Promise<MirrorPlan> {
  const plan = MirrorPlanSchema.parse(raw), records = plan.parts.flatMap((part) => part.records);
  validateMirror(records);
  if (plan.parts.length !== plan.declaration.chunkCount || records.length !== plan.declaration.recordCount) throw new Error('发布计划条数或分片数不一致，请重新预览。');
  let bytes = 0;
  for (const part of plan.parts) { const text = JSON.stringify(part.records); const size = byteLength(text); bytes += size;
    if (size > MIRROR_LIMITS.chunkBytes || await digest(text) !== part.hash) throw new Error('发布分片内容与摘要不一致，请重新预览。'); }
  if (bytes !== plan.bytes || await digest(plan.parts.map((part) => part.hash).join('\n')) !== plan.declaration.contentHash) throw new Error('发布计划完整性校验失败，请重新预览。');
  return plan;
}
