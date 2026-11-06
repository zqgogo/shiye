import { z } from 'zod';
import { MirrorIdentitySchema, MirrorRecordSchema } from './protocol.js';
const id = z.string().min(1).max(80);
export const InboxPayloadSchema = z.object({
  destination: z.enum(['bookmark', 'reading']), url: MirrorRecordSchema.options[0].shape.url,
  title: z.string().trim().max(300), sourceDescription: z.string().max(2000), note: z.string().max(10000),
  categoryId: id.nullable(), categoryPath: z.string().max(2000), tagIds: z.array(id).max(30), tagNames: z.array(z.string().max(40)).max(30),
  pinned: z.boolean(), unread: z.boolean(), aiBlocked: z.boolean(),
}).strict();
export type InboxPayload = z.infer<typeof InboxPayloadSchema>;
// Local receipt decisions never alter the original inbox identity used for retries.
export const InboxReceiveEditsSchema = InboxPayloadSchema.omit({ url: true, categoryPath: true, tagNames: true }).partial().strict();
export type InboxReceiveEdits = z.infer<typeof InboxReceiveEditsSchema>;

export const InboxDeviceSchema = z.object({ deviceId: z.string().uuid(), deviceKey: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) }).strict();
export const InboxSubmitSchema = InboxDeviceSchema.extend({ identity: MirrorIdentitySchema, id: z.string().uuid(), payload: InboxPayloadSchema }).strict();
export const InboxReceiptSchema = z.object({ status: z.enum(['received', 'rejected']), recordKind: z.enum(['bookmark', 'reading']).nullable(), recordId: id.nullable(), message: z.string().max(500) }).strict();
export type InboxReceipt = z.infer<typeof InboxReceiptSchema>;
export const InboxEntrySchema = z.object({ seq: z.number().int().positive(), id: z.string().uuid(), identity: MirrorIdentitySchema,
  payload: InboxPayloadSchema, createdAt: z.string() }).strict();
export type InboxEntry = z.infer<typeof InboxEntrySchema>;
export const InboxPageSchema = z.object({ entries: z.array(InboxEntrySchema).max(50), hasMore: z.boolean() }).strict();
