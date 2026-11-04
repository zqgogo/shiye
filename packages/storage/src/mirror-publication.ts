import { AppError } from '@shiye/core';
import type { MirrorPublicationRepository } from '@shiye/application';
import { PublicationSnapshotSchema, PublicationStateSchema, PUBLICATION_LEASE_MS, validateMirrorPlan, type PublicationState } from '../../sync/src/publication.js';
import { sameIdentity } from '../../sync/src/protocol.js';
import { mirrorBase } from '../../sync/src/client.js';
import type { ShiyeDB } from './db.js';
const dataKey = 'cloud-publication:data', stateKey = 'cloud-publication:state';
function conflict(message: string): never { throw new AppError('REVISION_CONFLICT', message); }
export function createMirrorPublications(db: ShiyeDB): MirrorPublicationRepository {
  async function libraryId(): Promise<string> { return ((await db.settings.get('app'))?.value as { libraryId?: string } | undefined)?.libraryId ?? ''; }
  async function state(id?: string): Promise<PublicationState> {
    const row = await db.meta.get(stateKey); if (!row) conflict('本机发布计划已清除，请重新预览。');
    const result = PublicationStateSchema.parse(row.value);
    if ((id && result.id !== id) || result.localLibraryId !== await libraryId()) conflict('本机计划或主库已变化，请重新预览。');
    if (result.lease && result.lease.until <= Date.now()) { result.lease = null; if (result.state === 'uploading') result.state = 'paused'; }
    return result;
  }
  const putState = (value: PublicationState) => db.meta.put({ key: stateKey, value: PublicationStateSchema.parse(value) });
  const owns = (value: PublicationState, owner: string) => { if (!value.lease || value.lease.owner !== owner || value.lease.until <= Date.now()) conflict('另一页面正在上传，或执行权已到期，请重新核对。'); };
  return {
    async save(raw, expectedId) {
      const snapshot = PublicationSnapshotSchema.parse(raw);
      snapshot.baseUrl = mirrorBase(snapshot.baseUrl).href;
      snapshot.plan = await validateMirrorPlan(snapshot.plan);
      if (snapshot.id !== snapshot.plan.declaration.generationId) throw new AppError('INVALID_INPUT', '快照与发布编号不一致。');
      return db.transaction('rw', [db.meta, db.settings], async () => {
        const previous = await db.meta.get(stateKey);
        const before = previous ? PublicationStateSchema.parse(previous.value) : null;
        if ((before?.id ?? null) !== expectedId || snapshot.localLibraryId !== await libraryId()) conflict('另一页面已准备新计划或主库已变化，请重新载入。');
        if (before?.lease && before.lease.until > Date.now()) conflict('当前有未完成上传，请先停止后再准备新计划。');
        const status: PublicationState = { id: snapshot.id, localLibraryId: snapshot.localLibraryId, baseUrl: snapshot.baseUrl, identity: snapshot.plan.declaration.identity,
          state: 'prepared', confirmedChunks: 0, totalChunks: snapshot.plan.parts.length, lease: null, receipt: null };
        await db.meta.put({ key: dataKey, value: snapshot }); await putState(status);
        return { snapshot, status };
      });
    },
    async get() {
      return db.transaction('rw', [db.meta, db.settings], async () => {
        if (!await db.meta.get(stateKey)) return null;
        const status = await state(), raw = await db.meta.get(dataKey);
        if (!raw) conflict('发布快照缺失，请重新预览。');
        const snapshot = PublicationSnapshotSchema.parse(raw.value);
        if (snapshot.id !== status.id || snapshot.localLibraryId !== status.localLibraryId || snapshot.baseUrl !== status.baseUrl || snapshot.plan.parts.length !== status.totalChunks) conflict('本机发布状态与快照不一致。');
        await putState(status); return { snapshot, status };
      });
    },
    async acquire(id, owner) { await db.transaction('rw', [db.meta, db.settings], async () => {
      const status = await state(id); if (status.lease && status.lease.owner !== owner) conflict('另一页面正在上传，请等待或稍后刷新。');
      status.lease = { owner, until: Date.now() + PUBLICATION_LEASE_MS }; status.state = 'uploading'; await putState(status);
    }); },
    async progress(id, owner, confirmed) { await db.transaction('rw', [db.meta, db.settings], async () => {
      const status = await state(id); owns(status, owner);
      if (!Number.isInteger(confirmed) || confirmed < 0 || confirmed > status.totalChunks) throw new AppError('INVALID_INPUT', '确认分片数不正确。');
      status.confirmedChunks = confirmed; status.lease!.until = Date.now() + PUBLICATION_LEASE_MS; await putState(status);
    }); },
    async complete(id, owner, receipt) { await db.transaction('rw', [db.meta, db.settings], async () => {
      const status = await state(id); owns(status, owner);
      if (receipt.activeGeneration !== id || !sameIdentity(status.identity, receipt)) conflict('服务身份或发布编号不一致，未标记成功。');
      status.receipt = receipt; status.state = 'published'; status.confirmedChunks = status.totalChunks; status.lease = null; await putState(status);
    }); },
    async release(id, owner) { await db.transaction('rw', [db.meta, db.settings], async () => {
      if (!await db.meta.get(stateKey)) return;
      const status = await state(id); if (status.lease?.owner !== owner) return;
      status.lease = null; if (status.state === 'uploading') status.state = 'paused'; await putState(status);
    }); },
    async remove(id, force = false) { await db.transaction('rw', [db.meta, db.settings], async () => {
      if (!await db.meta.get(stateKey)) return;
      const status = await state(id);
      if (!force && status.lease) conflict('有页面仍在上传，请先停止或等待执行权到期。');
      await db.meta.bulkDelete([stateKey, dataKey]);
    }); },
  };
}
