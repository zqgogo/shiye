import { GenerationStatusSchema } from './protocol.js';
import { validateMirrorPlan, type MirrorPlan } from './publication.js';
export type { MirrorPlan } from './publication.js';
import { CreateGenerationSchema, MIRROR_LIMITS, MirrorInfoSchema, byteLength, digest, sameIdentity, validateMirror,
  type CreateGeneration, type MirrorInfo, type MirrorRecord } from './protocol.js';

export function mirrorBase(address: string): URL {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('后端地址需为 HTTPS，不能带凭据、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/'; return url;
}
export class MirrorClient {
  constructor(private readonly base: string, private readonly token: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(path: string, signal: AbortSignal, body?: unknown, method?: string): Promise<unknown> {
    const response = await this.fetcher(new URL(path, mirrorBase(this.base)).href, {
      method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`记录后端请求失败（HTTP ${response.status}）。${response.status === 409 ? '库身份、发布版本或内容已变化，请重新连接核对。' : '请检查地址、应用凭据或服务状态。'}没有自动重试。`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('后端返回空响应。');
    const decoder = new TextDecoder(); let bytes = 0, text = '';
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length;
      if (bytes > 1000000) throw new Error('后端响应超过上限。'); text += decoder.decode(chunk.value, { stream: true }); }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); }
    try { return JSON.parse(text); } catch { throw new Error('后端没有返回可识别的数据。'); }
  }
  async info(signal: AbortSignal): Promise<MirrorInfo> { return MirrorInfoSchema.parse(await this.request('v1/info', signal)); }
  async publish(plan: MirrorPlan, signal: AbortSignal, progress: (done: number, total: number) => void | Promise<void>,
    checks: { beforeChunk?: (index: number, records: readonly MirrorRecord[]) => Promise<void>; beforeCommit?: () => Promise<void> } = {}): Promise<MirrorInfo> {
    plan = await validateMirrorPlan(plan);
    const before = await this.info(signal);
    if (!sameIdentity(before, plan.declaration.identity)) throw new Error('服务身份或纪元已变化，请重新连接。');
    if (before.activeGeneration === plan.declaration.generationId) return before;
    if (before.revision !== plan.declaration.baseRevision) throw new Error('云端已有新版本，请重新连接并预览；旧计划未覆盖云端。');
    await this.request('v1/generations', signal, plan.declaration);
    const status = GenerationStatusSchema.parse(await this.request(`v1/generations/${plan.declaration.generationId}`, signal));
    if (JSON.stringify(status.declaration) !== JSON.stringify(plan.declaration)) throw new Error('服务器上传计划与本机快照不一致，已停止。');
    const received = new Set<number>();
    for (const part of status.received) {
      if (received.has(part.index) || plan.parts[part.index]?.hash !== part.hash) throw new Error('服务器分片摘要不一致，未覆盖任何分片。');
      received.add(part.index);
    }
    let done = received.size; await progress(done, plan.parts.length);
    for (let index = 0; index < plan.parts.length; index++) {
      if (received.has(index)) continue;
      const part = plan.parts[index]!;
      await checks.beforeChunk?.(index, part.records);
      await this.request(`v1/generations/${plan.declaration.generationId}/chunks/${index}`, signal, { identity: plan.declaration.identity, ...part });
      done++; await progress(done, plan.parts.length);
    }
    await checks.beforeCommit?.();
    await this.request(`v1/generations/${plan.declaration.generationId}/publish`, signal, { identity: plan.declaration.identity });
    const after = await this.info(signal);
    if (!sameIdentity(after, before) || after.activeGeneration !== plan.declaration.generationId) throw new Error('发布确认期间云端已变化，请重新连接核对结果。');
    return after;
  }
  async cancel(plan: MirrorPlan, signal: AbortSignal): Promise<void> {
    await this.request(`v1/generations/${plan.declaration.generationId}`, signal, { identity: plan.declaration.identity }, 'DELETE');
  }
  async clear(info: MirrorInfo, signal: AbortSignal): Promise<MirrorInfo> {
    await this.request('v1/mirror', signal, { identity: { serverId: info.serverId, libraryId: info.libraryId, epoch: info.epoch }, baseRevision: info.revision }, 'DELETE');
    return this.info(signal);
  }
}

export async function planMirror(records: MirrorRecord[], info: MirrorInfo): Promise<MirrorPlan> {
  validateMirror(records);
  const parts: MirrorPlan['parts'] = []; let current: MirrorRecord[] = []; let currentBytes = 2;
  for (const row of records) {
    const size = byteLength(JSON.stringify(row)) + 1;
    if (size + 2 > MIRROR_LIMITS.chunkBytes) throw new Error('单条记录超过镜像分片容量。');
    if (current.length && (current.length >= MIRROR_LIMITS.chunkRecords || currentBytes + size > MIRROR_LIMITS.chunkBytes)) {
      parts.push({ records: current, hash: await digest(JSON.stringify(current)) }); current = []; currentBytes = 2;
    }
    current.push(row); currentBytes += size;
  }
  if (current.length || !parts.length) parts.push({ records: current, hash: await digest(JSON.stringify(current)) });
  const bytes = parts.reduce((sum, part) => sum + byteLength(JSON.stringify(part.records)), 0);
  if (bytes > MIRROR_LIMITS.totalBytes) throw new Error('镜像超过 24 MB，请减少共享记录。');
  const declaration = CreateGenerationSchema.parse({ identity: { serverId: info.serverId, libraryId: info.libraryId, epoch: info.epoch },
    generationId: crypto.randomUUID(), baseRevision: info.revision, chunkCount: parts.length, recordCount: records.length,
    contentHash: await digest(parts.map((part) => part.hash).join('\n')) });
  return { declaration, parts, bytes };
}
