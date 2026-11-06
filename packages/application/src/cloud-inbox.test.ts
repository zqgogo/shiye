import { afterEach, beforeEach, expect, it } from 'vitest';
import { ShiyeDB, createRepositories } from '@shiye/storage';
import { newId } from '@shiye/core';
import { createWorkspaceService } from './workspace.js';
import type { InboxEntry } from '../../sync/src/inbox.js';
let db: ShiyeDB, service: ReturnType<typeof createWorkspaceService>, libraryId: string;
const entry = (overrides: Partial<InboxEntry['payload']> = {}): InboxEntry => ({ seq: 1, id: newId(), identity: { serverId: 'server', libraryId: 'remote', epoch: 'epoch' }, createdAt: new Date().toISOString(), payload: {
  destination: 'bookmark', url: 'https://example.com/mobile', title: '手机收藏', categoryId: null, categoryPath: '', tagIds: [], tagNames: [], note: '手机备注', sourceDescription: '来源说明', pinned: true, unread: false, aiBlocked: true, ...overrides,
} });
beforeEach(async () => { db = new ShiyeDB(`inbox-${newId()}`); service = createWorkspaceService(createRepositories(db)); libraryId = (await service.snapshot()).settings.libraryId; });
afterEach(() => db.delete());
it('接收普通收藏格式，保留分类、标签、备注及标志；确认重试与并发不重复创建', async () => {
  const category = await service.createCategory('技术'); const tag = await service.createTag('参考');
  const input = entry({ categoryId: category.id, categoryPath: '技术', tagIds: [tag.id], tagNames: ['参考'] });
  const [a, b] = await Promise.all([service.receiveCloudInbox(input, libraryId), service.receiveCloudInbox(input, libraryId)]);
  expect(a).toEqual(b); const snap = await service.snapshot(); expect(snap.bookmarks).toHaveLength(1);
  expect(snap.bookmarks[0]).toMatchObject({ title: '手机收藏', categoryId: category.id, tagIds: [tag.id], note: '手机备注', sourceDescription: '来源说明', pinned: true, inboxUnread: false, privacy: { localOnly: false, aiBlocked: true } });
  await service.deleteBookmark(a.recordId!); expect(await service.receiveCloudInbox(input, libraryId)).toEqual(a); expect((await service.snapshot()).bookmarks).toHaveLength(0);
});
it('重复网址保留总机内容与本地专用隐私，不用手机字段覆盖', async () => {
  const old = await service.createBookmark({ originalUrl: 'https://example.com/mobile', title: '总机标题', note: '原备注', privacy: { localOnly: true } });
  const receipt = await service.receiveCloudInbox(entry(), libraryId); expect(receipt.recordId).toBe(old.id);
  expect((await service.snapshot()).bookmarks[0]).toEqual(old);
});
it('分类或标签被删除时明确回退，不创建同名分类', async () => {
  const receipt = await service.receiveCloudInbox(entry({ categoryId: 'removed', categoryPath: '旧分类', tagIds: ['removed-tag'], tagNames: ['旧标签'] }), libraryId);
  const snap = await service.snapshot(); expect(snap.bookmarks[0]).toMatchObject({ categoryId: null, tagIds: [] }); expect(snap.categories).toHaveLength(0); expect(receipt.message).toContain('失效');
});
it('可直接加入待看，重复提交不同编号也不覆盖待看笔记', async () => {
  const first = entry({ destination: 'reading' }); await service.receiveCloudInbox(first, libraryId);
  await service.receiveCloudInbox(entry({ destination: 'reading', note: '另一份' }), libraryId);
  const snap = await service.snapshot(); expect(snap.pendingReading).toHaveLength(1); expect(snap.pendingReading[0]?.note).toBe('手机备注');
});
it('旧主库、被回收网址和不合法提交不会留下收件回执或部分写入', async () => {
  await expect(service.receiveCloudInbox(entry(), 'old-library')).rejects.toThrow('主库已变化');
  const old = await service.createBookmark({ originalUrl: 'https://example.com/mobile' }); await service.deleteBookmark(old.id);
  await expect(service.receiveCloudInbox(entry(), libraryId)).rejects.toThrow('回收站');
  await expect(service.receiveCloudInbox(entry({ url: 'javascript:alert(1)' }), libraryId)).rejects.toThrow();
  expect((await db.meta.toArray()).filter((row) => row.key.startsWith('cloud-inbox:'))).toHaveLength(0);
});
it('相同提交编号不能换内容重放', async () => {
  const input = entry(); await service.receiveCloudInbox(input, libraryId);
  await expect(service.receiveCloudInbox({ ...input, payload: { ...input.payload, title: '被替换' } }, libraryId)).rejects.toThrow('内容变化');
  expect((await service.snapshot()).bookmarks).toHaveLength(1);
});
it('接收前的本机调整可覆盖分类标签标题备注，回执丢失重试仍返回首次结果', async () => {
  const category=await service.createCategory('电脑整理'),tag=await service.createTag('电脑标签');
  const input=entry({categoryId:'remote-category',categoryPath:'手机路径',tagIds:['remote-tag'],tagNames:['手机标签']});
  const first=await service.receiveCloudInbox(input,libraryId,{categoryId:category.id,tagIds:[tag.id],title:'电脑标题',note:'重新整理',pinned:false,unread:true});
  expect((await service.snapshot()).bookmarks[0]).toMatchObject({categoryId:category.id,tagIds:[tag.id],title:'电脑标题',note:'重新整理',pinned:false,inboxUnread:true});
  expect(await service.receiveCloudInbox(input,libraryId,{destination:'reading',title:'不应再变更'})).toEqual(first);
  expect((await service.snapshot()).pendingReading).toHaveLength(0);
});
it('接收时可改为待看，或明确清空分类和标签；失效的手动选择不静默回退', async () => {
  const input=entry(); await service.receiveCloudInbox(input,libraryId,{destination:'reading',note:'电脑决定稍后看'});
  expect((await service.snapshot()).pendingReading[0]).toMatchObject({note:'电脑决定稍后看'});
  const category=await service.createCategory('原分类');const tag=await service.createTag('原标签');
  await service.receiveCloudInbox(entry({url:'https://example.com/clear',categoryId:category.id,tagIds:[tag.id]}),libraryId,{categoryId:null,tagIds:[]});
  expect((await service.snapshot()).bookmarks[0]).toMatchObject({categoryId:null,tagIds:[]});
  await expect(service.receiveCloudInbox(entry({url:'https://example.com/missing'}),libraryId,{categoryId:'deleted'})).rejects.toThrow('所选分类');
  await expect(service.receiveCloudInbox(entry({url:'https://example.com/missing-tag'}),libraryId,{tagIds:['deleted']})).rejects.toThrow('所选标签');
  expect((await service.snapshot()).bookmarks).toHaveLength(1);
});
