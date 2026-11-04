import { afterEach, beforeEach, expect, it } from 'vitest';
import { ShiyeDB, createRepositories } from '@shiye/storage';
import { newId } from '@shiye/core';
import { createWorkspaceService } from './workspace.js';
import type { MirrorInfo } from '../../sync/src/protocol.js';
let db: ShiyeDB, repos: ReturnType<typeof createRepositories>, service: ReturnType<typeof createWorkspaceService>;
const info: MirrorInfo = { protocol: 1, serverId: 'server', libraryId: 'remote', epoch: 'epoch', revision: 0, activeGeneration: null, publishedAt: null };
beforeEach(() => { db = new ShiyeDB(`publication-${newId()}`); repos = createRepositories(db); service = createWorkspaceService(repos); });
afterEach(() => db.delete());
const prepare = () => service.prepareCloudPublication('https://mirror.example.com', info, null);

it('发布快照与状态跨页面保留，备份排除快照和凭据字段', async () => {
  await service.createBookmark({ originalUrl: 'https://example.com', title: '共享' });
  const saved = await prepare();
  const reopened = createWorkspaceService(createRepositories(db));
  expect((await reopened.savedCloudPublication())?.snapshot).toEqual(saved.snapshot);
  expect((await service.exportBackup(false)).text).not.toContain(saved.snapshot.id);
  const value = JSON.stringify((await db.meta.toArray()).filter((row) => row.key.startsWith('cloud-publication:')));
  expect(value).not.toMatch(/apiKey|Authorization|publisher|reader|token/);
});
it('两个页面准备预览时使用编号保护，不能覆盖对方新快照', async () => {
  await service.createBookmark({ originalUrl: 'https://example.com', title: '共享' });
  const [a, b] = await Promise.allSettled([prepare(), prepare()]);
  expect([a, b].filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const current = (await service.savedCloudPublication())!; const owner = newId(); await service.acquireCloudPublication(current.snapshot.id, owner);
  await expect(service.prepareCloudPublication('https://mirror.example.com', info, current.snapshot.id)).rejects.toThrow();
});
it('进度更新不重写大快照；执行权过期后允许续传，拒绝旧确认', async () => {
  await service.createBookmark({ originalUrl: 'https://example.com', title: '共享' });
  const saved = await prepare(), a = newId(), b = newId();
  await service.acquireCloudPublication(saved.snapshot.id, a);
  await expect(service.acquireCloudPublication(saved.snapshot.id, b)).rejects.toThrow('另一页面');
  const hook = (_modifications: unknown, key: unknown) => { if (key === 'cloud-publication:data') throw new Error('rewrote snapshot'); };
  db.meta.hook('updating', hook);
  await service.progressCloudPublication(saved.snapshot.id, a, 1);
  db.meta.hook('updating').unsubscribe(hook);
  const state = (await db.meta.get('cloud-publication:state'))!.value as NonNullable<Awaited<ReturnType<typeof service.savedCloudPublication>>>['status'];
  await db.meta.put({ key: 'cloud-publication:state', value: { ...state, lease: { owner: a, until: Date.now() - 1 } } });
  expect((await service.savedCloudPublication())?.status.state).toBe('paused');
  await service.acquireCloudPublication(saved.snapshot.id, b);
  await expect(service.completeCloudPublication(saved.snapshot.id, a, { ...info, activeGeneration: saved.snapshot.id, revision: 1 })).rejects.toThrow();
  await service.completeCloudPublication(saved.snapshot.id, b, { ...info, activeGeneration: saved.snapshot.id, revision: 1 });
  expect((await service.savedCloudPublication())?.status.state).toBe('published');
});
it('逐片上传和最终发布复核隐私，备注修改不影响只同步记录的白名单', async () => {
  const row = await service.createBookmark({ originalUrl: 'https://example.com', title: '共享', note: '本机备注' });
  const saved = await prepare();
  await repos.bookmarks.update(row.id, row.localRevision, { note: '仍仅本机的备注' }, 'human');
  await service.validateCloudChunk(saved.snapshot.plan.parts[0]!.records); await service.validateCloudPublication(saved.snapshot.id);
  const current = (await repos.bookmarks.get(row.id))!;
  await repos.bookmarks.update(row.id, current.localRevision, { privacy: { localOnly: true, aiBlocked: false } }, 'human');
  await expect(service.validateCloudChunk(saved.snapshot.plan.parts[0]!.records)).rejects.toThrow('本地专用');
  await expect(service.validateCloudPublication(saved.snapshot.id)).rejects.toThrow('隐私');
});
it('取消本机任务尊重执行权，明确清空时可以作废队列，旧页面不再推进', async () => {
  await service.createBookmark({ originalUrl: 'https://example.com', title: '共享' }); const saved = await prepare(), owner = newId();
  await service.acquireCloudPublication(saved.snapshot.id, owner); await expect(service.removeCloudPublication(saved.snapshot.id)).rejects.toThrow();
  await service.removeCloudPublication(saved.snapshot.id, true);
  await expect(service.progressCloudPublication(saved.snapshot.id, owner, 1)).rejects.toThrow();
  expect(await service.savedCloudPublication()).toBeNull(); expect(await db.bookmarks.count()).toBe(1);
});
it('替换恢复清理本机发布队列，不能让旧快照在新库继续上传', async () => {
  await service.createBookmark({ originalUrl: 'https://example.com', title: '共享' }); await prepare();
  const document = (await service.exportBackup(false)).document; await repos.backup.restore(document, 'replace');
  expect(await service.savedCloudPublication()).toBeNull();
});
it('空库合并导致身份切换时也清理旧发布队列，允许在新身份下重新预览', async () => {
  await service.snapshot(); await prepare();
  const document = (await service.exportBackup(false)).document; document.libraryId = newId();
  const result = await repos.backup.restore(document, 'merge');
  expect(result.librarySwitch).not.toBeNull(); expect(await service.savedCloudPublication()).toBeNull();
  expect((await prepare()).snapshot.localLibraryId).toBe(document.libraryId);
});
