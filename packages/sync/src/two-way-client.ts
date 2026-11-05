import { newId } from '@shiye/core';
import { mirrorBase } from './client.js';
import { sameIdentity } from './protocol.js';
import { SharedInfoSchema, SharedPageSchema, splitChanges, sameData, type SharedRow, type SharedInfo } from './two-way.js';
import { orderedChanges, resolveShared, type SharedPlan, type SharedState } from './two-way-local.js';
export class TwoWayClient {
  constructor(private base: string, private token: string, private transport: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(path: string, signal: AbortSignal, value?: unknown): Promise<unknown> {
    const response = await this.transport(new URL(path, mirrorBase(this.base)), { signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', method: value ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(value ? { body: JSON.stringify(value) } : {}) });
    if (!response.ok) throw new Error(response.status === 409 ? '另一台电脑或云端内容已变化，请重新检查同步；没有覆盖对方。' : `同步请求失败（HTTP ${response.status}），请核对地址、发布凭据和后端版本。`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('同步服务未返回数据。'); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 1000000) throw new Error('同步响应超过容量。'); chunks.push(item.value); } } finally { await reader.cancel().catch(() => undefined); }
    const all = new Uint8Array(size); let offset = 0; for (const part of chunks) { all.set(part, offset); offset += part.length; } return JSON.parse(new TextDecoder().decode(all));
  }
  async info(signal: AbortSignal) { return SharedInfoSchema.parse(await this.request('v2/info', signal)); }
  async read(signal: AbortSignal, state: SharedState | null): Promise<{ info: SharedInfo; rows: SharedRow[] }> {
    const info = await this.info(signal); if (state && (!sameIdentity(state.identity, info) || state.revision > info.revision)) throw new Error('此地址的云库身份或历史变化，请先解除本机连接记录再重新合并。');
    const rows = new Map(state?.baseline.map((row) => [row.key, row]) ?? []), since = state?.revision ?? 0; let cursor: string | null = null;
    do {
      const page = SharedPageSchema.parse(await this.request(`v2/changes?since=${since}&revision=${info.revision}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal));
      if (!sameIdentity(page.info, info) || page.info.revision !== info.revision) throw new Error('同步分页身份变化。');
      for (const row of page.rows) { if (row.version > info.revision || row.version <= since || (cursor && row.key <= cursor)) throw new Error('同步游标或记录版本异常。'); rows.set(row.key, row); }
      if (page.next && (page.next === cursor || !page.rows.length || page.next !== page.rows.at(-1)?.key)) throw new Error('同步分页没有前进。');
      cursor = page.next; if (rows.size > 100000) throw new Error('同步记录超过容量。');
    } while (cursor);
    const after = await this.info(signal); if (after.revision !== info.revision || !sameIdentity(after, info)) throw new Error('读取期间另一台电脑完成同步，请重新检查。');
    return { info, rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  }
  async upload(plan: SharedPlan, signal: AbortSignal, guard: (keys?: string[]) => Promise<void>, progress: (done: number, total: number) => void) {
    const merge = resolveShared(plan); if (merge.conflicts.some((conflict) => !plan.choices[conflict.key])) throw new Error('请先选择冲突记录保留哪一份。');
    const before = await this.info(signal); if (!sameIdentity(before, plan.info) || before.revision !== plan.info.revision) throw new Error('云端已有新同步，请重新检查。');
    let revision = before.revision; const deviceId = plan.deviceId, parts = splitChanges(orderedChanges(plan));
    for (let index = 0; index < parts.length; index++) {
      await guard(parts[index]!.map((row) => row.key)); if (signal.aborted) throw new Error('已取消同步。');
      const response = await this.request('v2/changes', signal, { identity: { serverId: before.serverId, libraryId: before.libraryId, epoch: before.epoch }, baseRevision: revision, operationId: newId(), deviceId, changes: parts[index] }) as { revision?: number };
      if (response.revision !== revision + 1) throw new Error('同步确认版本不一致，请重新检查。'); revision++; progress(index + 1, parts.length);
    }
    const result = await this.read(signal, null);
    if (result.info.revision !== revision) throw new Error('同步期间另一台电脑更新了云端，请重新检查；本机未覆盖。');
    const actual = new Map(result.rows.map((row) => [row.key, row.data]));
    for (const [key, data] of merge.merged) if (!sameData(actual.get(key) ?? null, data)) throw new Error('同步结果与预览不一致，请重新检查。');
    return result;
  }
}
