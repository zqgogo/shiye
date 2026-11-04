import { AppError, ORGANIZE_PLAN_LIMITS, OrganizePlanSchema, newId, type OrganizePlan } from '@shiye/core';
import type { HandoffRepository, OrganizePlanRepository } from '@shiye/application';
import type { ShiyeDB } from './db.js';
const key = (id: string) => `ai-organize-plan:${id}`;
const conflict = (message: string): never => { throw new AppError('REVISION_CONFLICT', message); };

export function createOrganizePlans(db: ShiyeDB, handoff: HandoffRepository): OrganizePlanRepository {
  async function read(id: string): Promise<OrganizePlan> {
    const row = await db.meta.get(key(id)); if (!row) throw new AppError('NOT_FOUND', '找不到整理计划。');
    return OrganizePlanSchema.parse(row.value);
  }
  async function update(id: string, action: (plan: OrganizePlan) => void): Promise<void> {
    await db.transaction('rw', db.meta, async () => { const plan = await read(id); action(plan); await db.meta.put({ key: key(id), value: OrganizePlanSchema.parse(plan) }); });
  }
  const normalize = (plan: OrganizePlan) => {
    if (plan.lease && plan.lease.until > Date.now()) return;
    plan.lease = null;
    for (const part of plan.parts) if (part.state === 'inflight') { part.state = 'unknown'; part.error = 'interrupted'; part.attemptId = null; }
  };
  const own = (plan: OrganizePlan, owner: string) => {
    if (plan.closed || !plan.lease || plan.lease.owner !== owner || plan.lease.until <= Date.now()) conflict('执行权已到期、被另一页面占用或计划已结束，请重新打开核对。');
  };
  return {
    async create(raw, batches) {
      const plan = OrganizePlanSchema.parse(raw);
      if (batches.length !== plan.parts.length || batches.some((batch, index) => batch.id !== plan.parts[index]?.batchId || batch.planId !== plan.id || batch.items.length !== plan.parts[index]?.itemCount || batch.libraryId !== plan.libraryId || batch.policyVersion !== plan.policyVersion)) throw new AppError('INVALID_INPUT', '计划和分片不一致。');
      await db.transaction('rw', [db.meta, db.handoffBatches, db.handoffItems], async () => {
        if (await db.meta.get(key(plan.id))) conflict('此计划已经存在。');
        const sourceIds = batches.flatMap((batch) => batch.items.map((row) => row.bookmarkId));
        if (new Set(sourceIds).size !== plan.itemCount) throw new AppError('INVALID_INPUT', '同一资料不能重复进入多个分片。');
        for (const batch of batches) { if (await db.handoffBatches.get(batch.id)) conflict('分片编号已被使用。'); await handoff.createBatch(batch); }
        await db.meta.put({ key: key(plan.id), value: plan });
      });
    },
    async get(id) { if (!await db.meta.get(key(id))) return null; await update(id, normalize); return read(id); },
    async recent() {
      const rows = await db.meta.where('key').startsWith('ai-organize-plan:').toArray();
      const plans = rows.map((row) => OrganizePlanSchema.parse(row.value)).filter((plan) => !plan.closed).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const result: OrganizePlan[] = [];
      for (const plan of plans.slice(0, 20)) { await update(plan.id, normalize); result.push(await read(plan.id)); }
      return result;
    },
    acquire(id, owner) { return update(id, (plan) => { normalize(plan); if (plan.closed) conflict('计划已结束。');
      if (plan.lease && plan.lease.owner !== owner) conflict('另一页面正在执行这份计划，请等待或稍后刷新。');
      plan.lease = { owner, until: Date.now() + ORGANIZE_PLAN_LIMITS.leaseMs }; }); },
    claim(id, index, owner) { let attempt = ''; return update(id, (plan) => { own(plan, owner); const part = plan.parts[index];
      if (!part || part.state === 'completed' || part.state === 'inflight') conflict('这份分片已完成或正在请求，不能重复发送。');
      attempt = newId(); Object.assign(part!, { state: 'inflight', error: null, attemptId: attempt });
      plan.lease!.until = Date.now() + ORGANIZE_PLAN_LIMITS.leaseMs;
    }).then(() => attempt); },
    async settle(id, index, owner, attempt, result) {
      await db.transaction('rw', [db.meta, db.handoffBatches], async () => {
        const plan = await read(id); own(plan, owner); const part = plan.parts[index];
        if (!part || part.attemptId !== attempt || part.state !== 'inflight') conflict('此请求已过期，迟到回复没有覆盖当前结果。');
        const { reply, ...status } = result;
        if (result.state === 'completed') {
          if (!reply) throw new AppError('INVALID_INPUT', '完成分片必须保留回复。');
          const bytes = new TextEncoder().encode(reply!).length;
          if (bytes > 1200000 || plan.replyBytes + bytes > ORGANIZE_PLAN_LIMITS.bytes) throw new AppError('INVALID_INPUT', '计划回复超过容量，请停止并缩小范围。');
          plan.replyBytes += bytes;
          if (!await db.handoffBatches.update(part!.batchId, { directReply: reply! })) conflict('分片已被清除。');
        }
        Object.assign(part!, status, { attemptId: null });
        await db.meta.put({ key: key(id), value: OrganizePlanSchema.parse(plan) });
      });
    },
    release(id, owner) { return update(id, (plan) => { if (plan.lease?.owner !== owner) return;
      plan.lease = null; for (const part of plan.parts) if (part.state === 'inflight') { part.state = 'unknown'; part.error = 'interrupted'; part.attemptId = null; }
    }); },
    async close(id) {
      await db.transaction('rw', [db.meta, db.handoffBatches], async () => { const plan = await read(id); plan.closed = true; plan.lease = null;
        for (const part of plan.parts) await db.handoffBatches.update(part.batchId, { status: 'invalidated' });
        await db.meta.put({ key: key(id), value: plan }); });
    },
  };
}
