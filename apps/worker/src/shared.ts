import { canonicalizeUrl } from '../../../packages/core/src/url.js';
import { SharedWriteSchema, publicRecord, type SharedInfo, type SharedData } from '../../../packages/sync/src/two-way.js';
import { byteLength, digest, validateMirror, type MirrorIdentity, type MirrorRecord } from '../../../packages/sync/src/protocol.js';
import type { Env } from './index.js';
interface Helpers { auth(request: Request, env: Env, write?: boolean): Promise<void>; body(request: Request): Promise<unknown>; json(value: unknown, status?: number): Response; fail(status: number, message: string): never; identity(): Promise<MirrorIdentity>; }
interface Entity { key: string; version: number; body: string | null; public_body: string | null; bytes: number; }
export async function sharedRequest(request: Request, env: Env, h: Helpers): Promise<Response> {
  const url = new URL(request.url), db = env.DB, publicRead = url.pathname === '/v2/public' && request.method === 'GET';
  await h.auth(request, env, !publicRead);
  const state = async () => { const row = await db.prepare('SELECT * FROM shared_state WHERE singleton=1').first<{ revision: number; enabled: number; reading_enabled:number }>(); if (!row) h.fail(503, '请升级后端数据库。'); return row; };
  const info = async (): Promise<SharedInfo> => { const value = await state(); return { ...await h.identity(), protocol: 3, readingEnabled:Boolean(value.reading_enabled), revision: value.revision, enabled: Boolean(value.enabled) }; };
  if (url.pathname === '/v2/info' && request.method === 'GET') return h.json(await info());
  if ((url.pathname === '/v2/changes' || publicRead) && request.method === 'GET') {
    const before = await info();
    const revision = Number(url.searchParams.get('revision') ?? before.revision), since = publicRead ? 0 : Number(url.searchParams.get('since') ?? '0'), cursor = url.searchParams.get('cursor') ?? '';
    if (!Number.isSafeInteger(since) || since < 0 || since > before.revision || cursor.length > 84) h.fail(400, '同步游标不合法。');
    if (revision !== before.revision) h.fail(409, '云端正在变化，请重新检查同步。');
    const rows = (await db.prepare(`SELECT key,version,${publicRead ? 'public_body AS body' : 'body'} FROM shared_entities WHERE version>? AND key>? ORDER BY key LIMIT 51`).bind(since, cursor).all<Entity>()).results;
    const result = []; let bytes = 0;
    for (const row of rows.slice(0, 50)) { const value = { key: row.key, version: row.version, data: publicRead && row.key.startsWith('r:') && !before.readingEnabled ? null : row.body ? JSON.parse(row.body) : null }; const size = byteLength(JSON.stringify(value)); if (bytes + size > 800000 && result.length) break; bytes += size; result.push(value); }
    const after = await info(); if (after.revision !== before.revision) h.fail(409, '读取期间同步版本变化，请重试。');
    return h.json({ info: before, rows: result, next: rows.length > result.length ? result.at(-1)?.key ?? null : null });
  }
  if (url.pathname === '/v2/changes' && request.method === 'POST') {
    const input = SharedWriteSchema.parse(await h.body(request)), identity = await h.identity();
    if (JSON.stringify(identity) !== JSON.stringify(input.identity)) h.fail(409, '云端库身份变化，未同步。');
    const inputHash = await digest(JSON.stringify(input));
    const receipt = await db.prepare('SELECT input_hash,revision FROM shared_operations WHERE id=?').bind(input.operationId).first<{ input_hash: string; revision: number }>();
    if (receipt) { if (receipt.input_hash !== inputHash) h.fail(409, '同步编号不能换内容。'); return h.json({ revision: receipt.revision }); }
    const before = await state(); if (before.revision !== input.baseRevision) h.fail(409, '另一台电脑已同步，请重新检查，未覆盖对方改动。');
    const ids = new Set<string>(); let delta = 0, added = 0;
    const publicRows = (await db.prepare('SELECT key,public_body FROM shared_entities WHERE public_body IS NOT NULL').all<Entity>()).results;
    const graph = new Map<string, MirrorRecord>(publicRows.map((row) => [row.key, JSON.parse(row.public_body!)]));
    for (const change of input.changes) {
      if (ids.has(change.key)) h.fail(400, '同步包含重复编号。'); ids.add(change.key);
      const old = await db.prepare('SELECT version,bytes FROM shared_entities WHERE key=?').bind(change.key).first<Entity>();
      if ((old?.version ?? 0) !== change.expected) h.fail(409, '收藏版本已变化，请重新检查。');
      if (!old) added++;
      if (change.data) {
        if(change.data.kind==='reading' && (change.data.related && !change.data.related.startsWith('b:') || (change.data.status==='pending') !== (change.data.completedAt===null)))h.fail(400,'待看状态或关联编号无效。');
        const prefix = { bookmark: 'b:', category: 'c:', tag: 't:', reading:'r:' }[change.data.kind];
        if (!change.key.startsWith(prefix)) h.fail(400, '收藏编号类型不符。');
        if ((change.data.kind === 'bookmark' || change.data.kind === 'reading') && change.key !== `${change.data.kind==='reading'?'r':'b'}:${await digest(canonicalizeUrl(change.data.url).canonicalUrl)}`) h.fail(400, '网址与同步编号不符。');
        if (change.data.kind === 'tag' && change.key !== `t:${await digest(change.data.name.normalize('NFC'))}`) h.fail(400, '标签与同步编号不符。');
        const projected=publicRecord(change.key, change.data); if(projected)graph.set(change.key,projected);else graph.delete(change.key);
      } else graph.delete(change.key);
      delta += (change.data ? byteLength(JSON.stringify(change.data)) : 0) - (old?.bytes ?? 0);
    }
    try { validateMirror([...graph].map(([key, value]) => value.kind === 'bookmark' ? { ...value, id: key } : value)); } catch { h.fail(409, '分类或标签引用冲突，请先解决目录差异再同步。'); }
    const totals = await db.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM shared_entities').first<{ n: number; bytes: number }>();
    if ((totals?.n ?? 0) + added > 100000 || (totals?.bytes ?? 0) + delta > 24 * 1024 * 1024) h.fail(413, '共享收藏超过同步容量（含删除标记 10 万项、正文 24 MB）。');
    const revision = before.revision + 1, nonce = crypto.randomUUID();
    const statements = [db.prepare('UPDATE shared_state SET revision=?,enabled=1,reading_enabled=CASE WHEN ? THEN 1 ELSE reading_enabled END,operation_id=? WHERE singleton=1 AND revision=?').bind(revision, input.readingComplete ? 1 : 0, nonce, before.revision)];
    for (const change of input.changes) statements.push(db.prepare(`INSERT INTO shared_entities(key,version,body,public_body,bytes)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM shared_state WHERE singleton=1 AND revision=? AND operation_id=?)
      ON CONFLICT(key) DO UPDATE SET version=excluded.version,body=excluded.body,public_body=excluded.public_body,bytes=excluded.bytes`).bind(change.key, revision, change.data ? JSON.stringify(change.data) : null, change.data && publicRecord(change.key,change.data) ? JSON.stringify(publicRecord(change.key, change.data)) : null, change.data ? byteLength(JSON.stringify(change.data)) : 0, revision, nonce));
    statements.push(db.prepare(`INSERT INTO shared_operations(id,input_hash,revision,device_id,created_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM shared_state WHERE singleton=1 AND revision=? AND operation_id=?) ON CONFLICT(id) DO NOTHING`).bind(input.operationId, inputHash, revision, input.deviceId, new Date().toISOString(), revision, nonce));
    const applied = await db.batch(statements); if (applied[0]?.meta.changes !== 1) h.fail(409, '另一台电脑先完成同步，请重新检查。');
    return h.json({ revision });
  }
  return h.json({ error: '未找到同步接口。' }, 404);
}
