import { z } from 'zod';
import { MirrorIdentitySchema, MirrorRecordSchema, byteLength } from './protocol.js';
const key = z.string().regex(/^[bctr]:[A-Za-z0-9_-]{1,80}$/);
const order = z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const SharedDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bookmark'), publicId: z.string().min(1).max(64), url: MirrorRecordSchema.options[0].shape.url, title: z.string().min(1).max(300), sourceDescription: z.string().max(4000), note: z.string().max(20000), selectedText: z.string().max(4000), aiPurpose: z.string().max(4000), category: key.nullable(), tags: z.array(key).max(30), pinned: z.boolean(), unread: z.boolean(), aiBlocked: z.boolean(), lockedFields: z.array(z.enum(['categoryId', 'tagIds', 'aiPurpose'])).max(3), order }).strict(),
  z.object({ kind: z.literal('category'), name: z.string().min(1).max(60), description: z.string().max(200), parent: key.nullable(), order }).strict(),
  z.object({ kind:z.literal('reading'), publicId:z.string().min(1).max(64), url:MirrorRecordSchema.options[0].shape.url, title:z.string().min(1).max(300), note:z.string().max(20000), status:z.enum(['pending','completed']), addedAt:z.string().datetime(), completedAt:z.string().datetime().nullable(), related:key.nullable() }).strict(),
  z.object({ kind: z.literal('tag'), name: z.string().min(1).max(40) }).strict(),
]);
export type SharedData = z.infer<typeof SharedDataSchema>;
export const SharedRowSchema = z.object({ key, version: z.number().int().positive(), data: SharedDataSchema.nullable() }).strict();
export type SharedRow = z.infer<typeof SharedRowSchema>;
export const SharedInfoSchema = MirrorIdentitySchema.extend({ protocol: z.literal(3), readingEnabled:z.boolean(), revision: z.number().int().nonnegative(), enabled: z.boolean() }).strict();
export type SharedInfo = z.infer<typeof SharedInfoSchema>;
export const SharedPageSchema = z.object({ info: SharedInfoSchema, rows: z.array(SharedRowSchema).max(50), next: key.nullable() }).strict();
export const SharedWriteSchema = z.object({ protocol:z.literal(3), readingComplete:z.boolean().default(false), identity: MirrorIdentitySchema, deviceId: z.string().uuid(), operationId: z.string().uuid(), baseRevision: z.number().int().nonnegative(), changes: z.array(z.object({ key, expected: z.number().int().nonnegative(), data: SharedDataSchema.nullable() }).strict()).max(50) }).strict();
export type SharedChange = z.infer<typeof SharedWriteSchema>['changes'][number];
export const sameData = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function publicRecord(key: string, data: SharedData) {
  if (data.kind === 'reading') return {kind:'reading' as const,id:data.publicId,title:data.title,url:data.url,status:data.status};
  if (data.kind === 'category') return { kind: 'category' as const, id: key, name: data.name, parentId: data.parent };
  if (data.kind === 'tag') return { kind: 'tag' as const, id: key, name: data.name };
  return { kind: 'bookmark' as const, id: data.publicId, title: data.title, url: data.url, categoryId: data.category, tagIds: data.tags, pinned: data.pinned, unread: data.unread };
}
export function splitChanges(changes: SharedChange[]): SharedChange[][] {
  const parts: SharedChange[][] = []; let part: SharedChange[] = [], bytes = 0;
  for (const change of changes) { const size = byteLength(JSON.stringify(change)); if (size > 180000) throw new Error('单条收藏超过同步容量。');
    if (part.length && (part.length >= 50 || bytes + size > 180000)) { parts.push(part); part = []; bytes = 0; } part.push(change); bytes += size;
  } if (part.length) parts.push(part); return parts;
}
export interface SharedConflict { key: string; base: SharedData | null; local: SharedData | null; remote: SharedData | null; }
export function mergeShared(base: SharedRow[], local: Map<string, SharedData | null>, remote: SharedRow[], choices: Record<string, 'local' | 'remote'> = {}) {
  const before = new Map(base.map((row) => [row.key, row])), cloud = new Map(remote.map((row) => [row.key, row]));
  const merged = new Map<string, SharedData | null>(), conflicts: SharedConflict[] = [], pushes: SharedChange[] = [];
  for (const id of [...new Set([...before.keys(), ...local.keys(), ...cloud.keys()])].sort()) {
    const b = before.get(id), r = cloud.get(id), l = local.get(id), bd = b?.data ?? null, rd = r?.data ?? null;
    let value: SharedData | null;
    if (!b && !local.has(id)) value = rd;
    else if (sameData(l ?? null, rd)) value = rd;
    else if (b && sameData(l ?? null, bd)) value = rd;
    else if ((b && sameData(rd, bd)) || (!b && !r)) value = l ?? null;
    else {
      const conflict = { key: id, base: bd, local: l ?? null, remote: rd }; conflicts.push(conflict);
      if (!choices[id]) continue; value = choices[id] === 'local' ? l ?? null : rd;
    }
    merged.set(id, value); if (!sameData(value, rd)) pushes.push({ key: id, expected: r?.version ?? 0, data: value });
  }
  return { merged, conflicts, pushes };
}
