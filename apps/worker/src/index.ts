import { z } from 'zod';
import { ChunkSchema, ClearMirrorSchema, CreateGenerationSchema, MIRROR_LIMITS, MIRROR_PROTOCOL, PublishSchema,
  byteLength, digest, sameIdentity, validateMirror, type MirrorIdentity, type MirrorInfo, type MirrorRecord } from '../../../packages/sync/src/protocol.js';

export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>; }
export interface Env { DB: Database; WRITE_TOKEN_SHA256: string; READ_TOKEN_SHA256: string; ASSETS?: { fetch(request: Request): Promise<Response> }; }
interface Library { server_id: string; library_id: string; epoch: string; revision: number; active_generation: string | null; published_at: string | null; }
interface Generation { id: string; epoch: string; base_revision: number; chunk_count: number; record_count: number; content_hash: string; created_at: number; }
interface Chunk { part: number; hash: string; body: string; bytes: number; }
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new HttpError(status, message); }
const headers = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const tokenHash = (value: string) => digest(value);
function constantEqual(a: string, b: string): boolean { let diff = a.length ^ b.length; for (let i = 0; i < 64; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
async function authenticate(request: Request, env: Env, write = false): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(env.WRITE_TOKEN_SHA256 ?? '') || !/^[a-f0-9]{64}$/.test(env.READ_TOKEN_SHA256 ?? '') || constantEqual(env.WRITE_TOKEN_SHA256, env.READ_TOKEN_SHA256)) fail(503, '服务尚未配置独立的发布和只读凭据。');
  const bearer = /^Bearer ([^\s]{24,256})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  const cookie = /(?:^|;\s*)__Host-shiye_reader=([^;]+)/.exec(request.headers.get('Cookie') ?? '')?.[1];
  const token = bearer ?? (!write ? cookie : undefined);
  const hash = await tokenHash(token ?? '');
  if (write ? !bearer || !constantEqual(hash, env.WRITE_TOKEN_SHA256) :
    !(constantEqual(hash, env.READ_TOKEN_SHA256) || (Boolean(bearer) && constantEqual(hash, env.WRITE_TOKEN_SHA256)))) fail(401, '凭据无效或无此操作权限。');
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, '仅接受 JSON。');
  const reader = request.body?.getReader(); if (!reader) fail(400, '缺少请求内容。');
  const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; total += chunk.value.length;
    if (total > 220000) fail(413, '请求超过容量上限。'); chunks.push(chunk.value); }
  } finally { await reader.cancel().catch(() => undefined); }
  const buffer = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); } catch { return fail(400, '请求不是有效 JSON。'); }
}
async function library(db: Database): Promise<Library> { const row = await db.prepare('SELECT * FROM mirror_library WHERE singleton=1').first<Library>(); if (!row) return fail(503, '数据库尚未初始化。'); return row; }
const identityOf = (row: Library): MirrorIdentity => ({ serverId: row.server_id, libraryId: row.library_id, epoch: row.epoch });
const infoOf = (row: Library): MirrorInfo => ({ ...identityOf(row), protocol: MIRROR_PROTOCOL, revision: row.revision, activeGeneration: row.active_generation, publishedAt: row.published_at });
const guard = (row: Library, identity: MirrorIdentity) => { if (!sameIdentity(identityOf(row), identity)) fail(409, '服务、库或纪元已变化。'); };
async function generation(db: Database, id: string): Promise<Generation> { const row = await db.prepare('SELECT * FROM mirror_generations WHERE id=?').bind(id).first<Generation>(); if (!row) return fail(404, '未找到上传计划。'); return row; }
function sameOrigin(request: Request) { if (request.headers.get('Origin') !== new URL(request.url).origin) fail(403, '请从同域的私有页面登录。'); }
const cookie = (value: string, age: number) => `__Host-shiye_reader=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url); const path = url.pathname; const db = env.DB;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (path === '/v1/session' && request.method === 'DELETE') { sameOrigin(request); return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) }); }
    if (path === '/v1/session' && request.method === 'POST') {
      sameOrigin(request);
      const input = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{24,256}$/) }).strict().parse(await body(request));
      const authRequest = new Request(request.url, { headers: { Authorization: `Bearer ${input.token}` } });
      await authenticate(authRequest, env);
      if (!constantEqual(await tokenHash(input.token), env.READ_TOKEN_SHA256)) fail(403, '手机页面请使用独立只读凭据。');
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(input.token, 8 * 3600) });
    }
    if (!path.startsWith('/v1/')) {
      if (!env.ASSETS) return new Response('拾页私有记录镜像', { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
      const response = await env.ASSETS.fetch(request);
      const wrapped = new Response(response.body, response); for (const [key, value] of Object.entries(headers)) wrapped.headers.set(key, value); return wrapped;
    }
    const write = request.method !== 'GET';
    await authenticate(request, env, write);
    if (path === '/v1/info' && request.method === 'GET') return json(infoOf(await library(db)));
    if (path === '/v1/generations' && request.method === 'POST') {
      const input = CreateGenerationSchema.parse(await body(request)); const lib = await library(db); guard(lib, input.identity);
      const previous = await db.prepare('SELECT * FROM mirror_generations WHERE id=?').bind(input.generationId).first<Generation>();
      if (previous) {
        if (previous.epoch !== lib.epoch || previous.base_revision !== input.baseRevision || previous.content_hash !== input.contentHash || previous.chunk_count !== input.chunkCount || previous.record_count !== input.recordCount) fail(409, '上传计划编号已被其他内容使用。');
        return json({ generationId: previous.id });
      }
      if (lib.revision !== input.baseRevision) fail(409, '发布基线已过期。');
      const count = await db.prepare('SELECT COUNT(*) AS count FROM mirror_generations WHERE id <> COALESCE(?, \'\') AND created_at > ?').bind(lib.active_generation, Date.now() - 86400000).first<{ count: number }>();
      if ((count?.count ?? 0) >= 5) fail(429, '尚有多份未完成上传，请清空镜像或等待过期后重试。');
      await db.batch([
        db.prepare('DELETE FROM mirror_generations WHERE id <> COALESCE((SELECT active_generation FROM mirror_library WHERE singleton=1), \'\') AND created_at < ?').bind(Date.now() - 86400000),
        db.prepare(`INSERT INTO mirror_generations(id,epoch,base_revision,chunk_count,record_count,content_hash,created_at)
          SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mirror_library WHERE singleton=1 AND server_id=? AND library_id=? AND epoch=? AND revision=?)
          ON CONFLICT(id) DO NOTHING`).bind(input.generationId, input.identity.epoch, input.baseRevision, input.chunkCount, input.recordCount, input.contentHash, Date.now(), input.identity.serverId, input.identity.libraryId, input.identity.epoch, input.baseRevision),
      ]);
      await generation(db, input.generationId);
      return json({ generationId: input.generationId });
    }
    const match = /^\/v1\/generations\/([a-f0-9-]{36})\/(?:chunks\/(\d+)|(publish))$/.exec(path);
    if (match && request.method === 'POST') {
      const id = z.string().uuid().parse(match[1]); const lib = await library(db); const gen = await generation(db, id);
      if (match[2] !== undefined) {
        const input = ChunkSchema.parse(await body(request)); guard(lib, input.identity);
        const part = Number(match[2]); if (!Number.isInteger(part) || part >= gen.chunk_count) fail(400, '分片编号不合法。');
        const text = JSON.stringify(input.records); const bytes = byteLength(text);
        if (bytes > MIRROR_LIMITS.chunkBytes || await digest(text) !== input.hash) fail(400, '分片容量或摘要校验失败。');
        const existing = await db.prepare('SELECT hash FROM mirror_chunks WHERE generation_id=? AND part=?').bind(id, part).first<{ hash: string }>();
        if (existing) { if (existing.hash !== input.hash) fail(409, '分片不可覆盖，请创建新上传计划。'); return json({ ok: true }); }
        const used = await db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM mirror_chunks WHERE generation_id=?').bind(id).first<{ bytes: number }>();
        if ((used?.bytes ?? 0) + bytes > MIRROR_LIMITS.totalBytes) fail(413, '镜像体积超过 24 MB。');
        const result = await db.prepare(`INSERT INTO mirror_chunks(generation_id,part,hash,body,bytes)
          SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mirror_library WHERE singleton=1 AND epoch=? AND revision=? AND active_generation IS NOT ?)
          AND (SELECT COALESCE(SUM(bytes),0) FROM mirror_chunks WHERE generation_id=?) + ? <= ?
          ON CONFLICT(generation_id,part) DO NOTHING`).bind(id, part, input.hash, text, bytes, gen.epoch, gen.base_revision, id, id, bytes, MIRROR_LIMITS.totalBytes).run();
        if (result.meta.changes !== 1) {
          const saved = await db.prepare('SELECT hash FROM mirror_chunks WHERE generation_id=? AND part=?').bind(id, part).first<{ hash: string }>();
          if (saved?.hash !== input.hash) fail(409, '上传期间发布状态变化或容量不足。');
        }
        return json({ ok: true });
      }
      const input = PublishSchema.parse(await body(request)); guard(lib, input.identity);
      if (lib.active_generation === id) return json(infoOf(lib));
      if (gen.epoch !== lib.epoch || gen.base_revision !== lib.revision) fail(409, '上传计划已过期。');
      const chunks = (await db.prepare('SELECT part,hash,body,bytes FROM mirror_chunks WHERE generation_id=? ORDER BY part').bind(id).all<Chunk>()).results;
      if (chunks.length !== gen.chunk_count || chunks.some((chunk, index) => chunk.part !== index)) fail(409, '分片尚未完整上传。');
      const records: MirrorRecord[] = []; let totalBytes = 0;
      for (const chunk of chunks) {
        totalBytes += byteLength(chunk.body);
        if (await digest(chunk.body) !== chunk.hash) fail(400, '存储分片校验失败。');
        records.push(...z.array(ChunkSchema.shape.records.element).max(MIRROR_LIMITS.chunkRecords).parse(JSON.parse(chunk.body)));
      }
      if (totalBytes > MIRROR_LIMITS.totalBytes || records.length !== gen.record_count || await digest(chunks.map((chunk) => chunk.hash).join('\n')) !== gen.content_hash) fail(400, '镜像完整性校验失败。');
      try { validateMirror(records); } catch { fail(400, '镜像目录、引用或编号校验失败。'); }
      const results = await db.batch([
        db.prepare(`UPDATE mirror_library SET active_generation=?, revision=revision+1, published_at=?
          WHERE singleton=1 AND server_id=? AND library_id=? AND epoch=? AND revision=?
          AND EXISTS(SELECT 1 FROM mirror_generations WHERE id=? AND epoch=?)`).bind(id, new Date().toISOString(), lib.server_id, lib.library_id, gen.epoch, gen.base_revision, id, gen.epoch),
        // All retired and abandoned uploads are removed only if this generation won the CAS.
        db.prepare('DELETE FROM mirror_generations WHERE changes()=1 AND id<>? AND (SELECT active_generation FROM mirror_library WHERE singleton=1)=?').bind(id, id),
      ]);
      if (results[0]?.meta.changes !== 1) fail(409, '另一个发布已先完成，请重新核对云端。');
      return json(infoOf(await library(db)));
    }
    if (path === '/v1/mirror' && request.method === 'GET') {
      const lib = await library(db); const id = url.searchParams.get('generation');
      if (!lib.active_generation) return json({ generationId: null, records: [], chunkCount: 0, index: 0 });
      if (id !== lib.active_generation) fail(409, '镜像版本变化，请重新载入。');
      const index = Number(url.searchParams.get('part') ?? '0'); if (!Number.isInteger(index) || index < 0) fail(400, '分页参数不合法。');
      const gen = await generation(db, id); const chunk = await db.prepare(`SELECT body FROM mirror_chunks WHERE generation_id=? AND part=?
        AND generation_id=(SELECT active_generation FROM mirror_library WHERE singleton=1)`).bind(id, index).first<{ body: string }>();
      if (!chunk) fail(409, '镜像分片不存在或版本已变化。');
      return json({ generationId: id, index, chunkCount: gen.chunk_count, records: JSON.parse(chunk.body) });
    }
    if (path === '/v1/mirror' && request.method === 'DELETE') {
      const input = ClearMirrorSchema.parse(await body(request)); const lib = await library(db); guard(lib, input.identity);
      const result = await db.batch([
        db.prepare('UPDATE mirror_library SET active_generation=NULL, revision=revision+1, published_at=NULL WHERE singleton=1 AND epoch=? AND revision=?').bind(input.identity.epoch, input.baseRevision),
        db.prepare('DELETE FROM mirror_generations WHERE changes()=1 AND (SELECT revision FROM mirror_library WHERE singleton=1)=? AND (SELECT active_generation FROM mirror_library WHERE singleton=1) IS NULL').bind(input.baseRevision + 1),
      ]);
      if (result[0]?.meta.changes !== 1) fail(409, '云端已经变化，请重新连接。');
      return json({ ok: true });
    }
    return json({ error: '未找到接口。' }, 404);
  } catch (cause) {
    if (cause instanceof HttpError) return json({ error: cause.message }, cause.status);
    if (cause instanceof z.ZodError) return json({ error: '请求字段、格式或容量不合法。' }, 400);
    // Do not echo exceptions, SQL, credentials or personal records into responses/logs.
    return json({ error: '请求未完成，未自动重试；请重新连接核对当前发布状态。' }, 500);
  }
}
export default { fetch: handleRequest };
