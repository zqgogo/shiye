import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ShiyeDB, createRepositories } from '@shiye/storage';
import { newId } from '@shiye/core';
import { createWorkspaceService } from './workspace.js';
let db: ShiyeDB; let repos: ReturnType<typeof createRepositories>; let service: ReturnType<typeof createWorkspaceService>;
beforeEach(() => { db = new ShiyeDB(`plan-${newId()}`); repos = createRepositories(db); service = createWorkspaceService(repos); });
afterEach(async () => { await db.delete(); });
async function seed(count: number) {
  const first = await repos.bookmarks.create({ originalUrl: 'https://example.com/0', title: '资料0' });
  const rows = Array.from({ length: count }, (_, index) => ({ ...first, id: index ? newId() : first.id,
    title: `资料${index}`, originalUrl: `https://example.com/${index}`, canonicalUrl: `https://example.com/${index}`, sortOrder: index * 1024 }));
  await db.bookmarks.bulkPut(rows); return rows;
}
const prepare = () => service.buildOrganizePlan({ scope: 'all', selectedIds: [], inputChars: 60000, outputTokens: 4096 });
async function reply(id: string, index: number) {
  const pack = await service.openOrganizePart(id, index); const material = JSON.parse(pack.materialText);
  return { protocolVersion: 2, batchId: pack.batchId, part: 1, results: material.items.map((row: { n: number; title: string; url: string }) => ({
    n: row.n, titleEcho: row.title, domain: new URL(row.url).hostname, patch: { aiPurpose: '整理后的用途' }, status: 'ok', reason: '依据材料' })) };
}

it('300 条完整规划 15 片，映射无丢失/重叠，刷新重读且不混入单批续接', async () => {
  const source = await seed(300); const plan = await prepare();
  expect(plan.itemCount).toBe(300); expect(plan.parts).toHaveLength(15);
  const ids: string[] = [];
  for (let index = 0; index < plan.parts.length; index++) {
    const pack = await service.openOrganizePart(plan.id, index); expect(pack.items).toHaveLength(20);
    ids.push(...pack.items.map((row) => row.bookmark.id));
  }
  expect(new Set(ids)).toEqual(new Set(source.map((row) => row.id)));
  const reopened = createWorkspaceService(createRepositories(db));
  expect((await reopened.listOrganizePlans())[0]?.parts).toHaveLength(15);
  expect(await reopened.findResumableHandoff()).toEqual({ status: 'none' });
  const backup = await service.exportBackup(false); expect(backup.text).not.toContain(plan.id); expect(backup.text).not.toContain('directReply');
});

it('计划和全部子批次同事务，后半段失败不会留下半份计划', async () => {
  await seed(45); const original = repos.handoff.createBatch.bind(repos.handoff); let count = 0;
  const mock = vi.spyOn(repos.handoff, 'createBatch').mockImplementation(async (input) => { if (++count === 2) throw new Error('storage failure'); return original(input); });
  await expect(prepare()).rejects.toThrow('storage failure'); mock.mockRestore();
  expect(await repos.organizePlans.recent()).toHaveLength(0); expect(await db.handoffBatches.count()).toBe(0); expect(await db.handoffItems.count()).toBe(0);
});

it('多页面不能重复执行，租约过期后标未知并拒绝旧请求的迟到回复', async () => {
  await seed(25); const plan = await prepare(); const a = newId(), b = newId();
  await service.startOrganizeRun(plan.id, a); const first = await service.claimOrganizePart(plan.id, 0, a);
  await expect(service.startOrganizeRun(plan.id, b)).rejects.toThrow('另一页面');
  const stored = (await db.meta.get(`ai-organize-plan:${plan.id}`))!.value as typeof plan;
  await db.meta.put({ key: `ai-organize-plan:${plan.id}`, value: { ...stored, lease: { owner: a, until: Date.now() - 1 } } });
  expect((await service.getOrganizePlan(plan.id))?.parts[0]?.state).toBe('unknown');
  await service.startOrganizeRun(plan.id, b); const second = await service.claimOrganizePart(plan.id, 0, b);
  await expect(service.completeOrganizePart(plan.id, 0, a, first, JSON.stringify(await reply(plan.id, 0)))).rejects.toThrow();
  await service.completeOrganizePart(plan.id, 0, b, second, JSON.stringify(await reply(plan.id, 0)));
  expect((await service.getOrganizePlan(plan.id))?.parts[0]?.state).toBe('completed');
  await expect(service.claimOrganizePart(plan.id, 0, b)).rejects.toThrow();
});

it('已保存回复跨刷新保留，中断/失败片可以独立认领，已完成片不能再计费发送', async () => {
  await seed(45); const plan = await prepare(); const owner = newId(); await service.startOrganizeRun(plan.id, owner);
  const a = await service.claimOrganizePart(plan.id, 0, owner); await service.completeOrganizePart(plan.id, 0, owner, a, JSON.stringify(await reply(plan.id, 0)));
  const b = await service.claimOrganizePart(plan.id, 1, owner); await service.failOrganizePart(plan.id, 1, owner, b, true);
  await service.releaseOrganizeRun(plan.id, owner);
  expect((await service.openOrganizePart(plan.id, 0)).reply).toContain('整理后的用途');
  expect((await service.getOrganizePlan(plan.id))?.parts.map((row) => row.state)).toEqual(['completed', 'unknown', 'ready']);
  await service.startOrganizeRun(plan.id, owner);
  await expect(service.claimOrganizePart(plan.id, 0, owner)).rejects.toThrow();
  const retry = await service.claimOrganizePart(plan.id, 1, owner); await service.completeOrganizePart(plan.id, 1, owner, retry, JSON.stringify(await reply(plan.id, 1)));
  expect((await service.getOrganizePlan(plan.id))?.parts.map((row) => row.state)).toEqual(['completed', 'completed', 'ready']);
});

it('跨片、缺项、重复、额外凭据字段的回复不标完成，不污染已保存材料', async () => {
  await seed(21); const plan = await prepare(), owner = newId(); await service.startOrganizeRun(plan.id, owner);
  const attempt = await service.claimOrganizePart(plan.id, 0, owner); const valid = await reply(plan.id, 0);
  for (const text of [ { ...valid, batchId: plan.parts[1]!.batchId }, { ...valid, part: 2 },
    { ...valid, results: valid.results.slice(1) }, { ...valid, results: [...valid.results.slice(1), valid.results[1]] }, { ...valid, apiKey: 'must-not-persist' } ]) {
    await expect(service.completeOrganizePart(plan.id, 0, owner, attempt, JSON.stringify(text))).rejects.toThrow();
  }
  expect((await service.openOrganizePart(plan.id, 0)).reply).toBe('');
  expect((await service.getOrganizePlan(plan.id))?.parts[0]?.state).toBe('inflight');
  expect(JSON.stringify(await db.handoffBatches.toArray())).not.toContain('must-not-persist');
});

it('部分勾选应用后，其余建议仍可继续，原版本和已应用状态不被重校验覆盖', async () => {
  await seed(20); const plan = await prepare(), owner = newId(); await service.startOrganizeRun(plan.id, owner);
  const attempt = await service.claimOrganizePart(plan.id, 0, owner); await service.completeOrganizePart(plan.id, 0, owner, attempt, JSON.stringify(await reply(plan.id, 0)));
  const pack = await service.openOrganizePart(plan.id, 0);
  const checked = await service.validateAiReply({ text: pack.reply, ...pack });
  await service.applySuggestions(pack.batchId, checked.applied.slice(0, 1));
  expect((await repos.handoff.getBatch(pack.batchId))?.status).toBe('partial');
  const remaining = await service.validateAiReply({ text: pack.reply, ...await service.openOrganizePart(plan.id, 0) });
  expect(remaining.applied).toHaveLength(19);
  expect((await repos.handoff.listItems(pack.batchId)).filter((row) => row.status === 'applied')).toHaveLength(1);
  await service.applySuggestions(pack.batchId, remaining.applied);
  expect((await repos.handoff.getBatch(pack.batchId))?.status).toBe('applied');
  expect((await db.bookmarks.toArray()).filter((row) => row.aiPurpose)).toHaveLength(20);
});

it('隐私、策略或主库变化后旧材料不发出，替换恢复清理计划及回复', async () => {
  await seed(21); const plan = await prepare(); const pack = await service.openOrganizePart(plan.id, 0);
  const row = pack.items[0]!.bookmark;
  await repos.bookmarks.update(row.id, row.localRevision, { privacy: { localOnly: true, aiBlocked: false } }, 'human');
  await expect(service.assertHandoffSendable(pack.batchId, pack.materialText)).rejects.toThrow();
  await service.updatePolicy('策略已修改'); await expect(service.startOrganizeRun(plan.id, newId())).rejects.toThrow();
  const document = (await service.exportBackup(true)).document;
  await repos.backup.restore(document, 'replace');
  expect(await service.getOrganizePlan(plan.id)).toBeNull(); expect(await db.handoffBatches.count()).toBe(0);
});

it('整计划撤销只处理有应用日志的分片，未发送片保留；修改策略后仍可撤销', async () => {
  await seed(25); const plan = await prepare(), owner = newId(); await service.startOrganizeRun(plan.id, owner);
  const attempt = await service.claimOrganizePart(plan.id, 0, owner); await service.completeOrganizePart(plan.id, 0, owner, attempt, JSON.stringify(await reply(plan.id, 0)));
  const pack = await service.openOrganizePart(plan.id, 0), checked = await service.validateAiReply({ text: pack.reply, ...pack });
  await service.applySuggestions(pack.batchId, checked.applied); await service.releaseOrganizeRun(plan.id, owner);
  await service.updatePolicy('新的策略不应该阻止撤销已有建议');
  expect((await service.undoOrganizePlan(plan.id)).reverted).toBe(20);
  expect((await repos.handoff.getBatch(plan.parts[1]!.batchId))?.status).toBe('exported');
  expect((await service.getOrganizePlan(plan.id))?.parts[1]?.state).toBe('ready');
});

it('应用记录与编号状态同事务落库，后续汇总失败不丢失已应用事实', async () => {
  await seed(20); const plan = await prepare(), owner = newId(); await service.startOrganizeRun(plan.id, owner);
  const attempt = await service.claimOrganizePart(plan.id, 0, owner); await service.completeOrganizePart(plan.id, 0, owner, attempt, JSON.stringify(await reply(plan.id, 0)));
  const pack = await service.openOrganizePart(plan.id, 0), checked = await service.validateAiReply({ text: pack.reply, ...pack });
  const mock = vi.spyOn(repos.handoff, 'saveItemResults').mockRejectedValueOnce(new Error('page interrupted'));
  await expect(service.applySuggestions(pack.batchId, checked.applied.slice(0, 1))).rejects.toThrow('page interrupted'); mock.mockRestore();
  expect((await service.openOrganizePart(plan.id, 0)).appliedNumbers).toHaveLength(1);
  expect((await db.bookmarks.toArray()).filter((row) => row.aiPurpose)).toHaveLength(1);
  const remaining = await service.validateAiReply({ text: pack.reply, ...await service.openOrganizePart(plan.id, 0) });
  expect(remaining.applied).toHaveLength(19);
});
