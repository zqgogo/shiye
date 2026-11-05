import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ShiyeDB, createRepositories } from '@shiye/storage';
import { newId } from '@shiye/core';
import { createWorkspaceService } from './workspace.js';
import { handleRequest, type Statement, type Env } from '../../../apps/worker/src/index.js';
import { digest } from '../../sync/src/protocol.js';
import { prepareSharedPlan, resolveShared, type SharedPlan } from '../../sync/src/two-way-local.js';
import { TwoWayClient } from '../../sync/src/two-way-client.js';
let sql: import('node:sqlite').DatabaseSync, env: Env, fetcher: typeof fetch, client: TwoWayClient;
let a: ReturnType<typeof createWorkspaceService>, b: typeof a, dbA: ShiyeDB, dbB: ShiyeDB;
const publisher = 'publisher_0123456789_abcdefghijklmnopqrstuvwxyz', reader = 'reader_0123456789_abcdefghijklmnopqrstuvwxyz', submitter = 'submitter_0123456789_abcdefghijklmnopqrstuvwxyz';
const address = 'https://mirror.test'; const signal = () => new AbortController().signal;
class Query implements Statement {
  constructor(private text: string, private values: (string | number | null)[] = []) {}
  bind(...values: (string | number | null)[]) { return new Query(this.text, values); }
  async first<T>() { return (sql.prepare(this.text).get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: sql.prepare(this.text).all(...this.values) as T[] }; }
  runNow() { return { meta: { changes: Number(sql.prepare(this.text).run(...this.values).changes) } }; }
  async run() { return this.runNow(); }
}
beforeEach(async () => {
  sql = new DatabaseSync(':memory:'); for (const name of ['0001_mirror.sql', '0002_inbox.sql', '0003_two_way.sql']) sql.exec(readFileSync(new URL(`../../../apps/worker/migrations/${name}`, import.meta.url), 'utf8'));
  env = { WRITE_TOKEN_SHA256: await digest(publisher), READ_TOKEN_SHA256: await digest(reader), SUBMIT_TOKEN_SHA256: await digest(submitter), DB: { prepare: (text) => new Query(text), async batch(statements) { sql.exec('BEGIN IMMEDIATE'); try { const results = statements.map((statement) => (statement as Query).runNow()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } } } };
  fetcher = async (input, init) => handleRequest(new Request(input, init), env); client = new TwoWayClient(address, publisher, fetcher);
  dbA = new ShiyeDB(`home-${newId()}`); dbB = new ShiyeDB(`work-${newId()}`); a = createWorkspaceService(createRepositories(dbA)); b = createWorkspaceService(createRepositories(dbB)); await a.snapshot(); await b.snapshot();
});
afterEach(async () => { sql.close(); await dbA.delete(); await dbB.delete(); });
async function plan(service: typeof a) { const local = await service.readTwoWay(address), remote = await client.read(signal(), local.state); return prepareSharedPlan(address, local, remote.rows, remote.info); }
async function apply(service: typeof a, p: SharedPlan) { const result = await client.upload(p, signal(), () => service.assertTwoWay(p), () => undefined); await service.applyTwoWay(p, result.rows, result.info.revision); return result; }
async function sync(service: typeof a) { const p = await plan(service); expect(resolveShared(p).conflicts).toHaveLength(0); return apply(service, p); }
it('家里工作轮流使用：分类标签备注首次合并、新增、修改、删除和回收站恢复往返', async () => {
  const category = await a.createCategory('技术'), tag = await a.createTag('参考');
  const book = await a.createBookmark({ originalUrl: 'https://example.com/home', title: '家里资料', categoryId: category.id, tagIds: [tag.id], note: '我的笔记' });
  await sync(a); await sync(b);
  let work = (await b.snapshot()).bookmarks[0]!; expect(work).toMatchObject({ title: '家里资料', note: '我的笔记' }); expect((await b.snapshot()).categories[0]?.name).toBe('技术');
  await b.updateBookmark(work.id, work.localRevision, { note: '工作补充', pinned: true }); await b.createBookmark({ originalUrl: 'https://example.com/work', title: '工作新增' }); await sync(b); await sync(a);
  expect((await a.snapshot()).bookmarks).toHaveLength(2); expect((await a.snapshot()).bookmarks.find((row) => row.id === book.id)?.note).toBe('工作补充');
  await a.deleteBookmark(book.id); await sync(a); await sync(b); expect((await b.snapshot()).bookmarks).toHaveLength(1); expect((await b.listTrash()).some((row) => row.id === work.id)).toBe(true);
  await b.restoreBookmark(work.id); await sync(b); await sync(a); expect((await a.snapshot()).bookmarks).toHaveLength(2);
});
it('另一台已有不同收藏时首次合并，不按本机缺失删除远端；同路径分类不会重复', async () => {
  const ca = await a.createCategory('同分类'), cb = await b.createCategory('同分类');
  await a.createBookmark({ originalUrl: 'https://example.com/a', categoryId: ca.id }); await b.createBookmark({ originalUrl: 'https://example.com/b', categoryId: cb.id }); await sync(a); await sync(b); await sync(a);
  expect((await a.snapshot()).bookmarks).toHaveLength(2); expect((await b.snapshot()).bookmarks).toHaveLength(2); expect((await b.snapshot()).categories).toHaveLength(1);
});
it('同网址已有不同内容时必须选择，不静默覆盖；不同本机编号归并为同条', async () => {
  await a.createBookmark({ originalUrl: 'https://example.com/same', note: '家里' }); await b.createBookmark({ originalUrl: 'https://example.com/same', note: '工作' }); await sync(a);
  const p = await plan(b); expect(resolveShared(p).conflicts).toHaveLength(1); await expect(apply(b, p)).rejects.toThrow('冲突'); p.choices[resolveShared(p).conflicts[0]!.key] = 'local'; await apply(b, p); await sync(a);
  expect((await a.snapshot()).bookmarks).toHaveLength(1); expect((await a.snapshot()).bookmarks[0]?.note).toBe('工作');
});
it('并发修改以及删除与编辑冲突，保留双方供选择，过期预览不覆盖云端', async () => {
  const book = await a.createBookmark({ originalUrl: 'https://example.com/race' }); await sync(a); await sync(b);
  const work = (await b.snapshot()).bookmarks[0]!; await b.updateBookmark(work.id, work.localRevision, { note: '工作修改' }); const stale = await plan(b);
  await a.deleteBookmark(book.id); await sync(a); await expect(apply(b, stale)).rejects.toThrow('重新检查');
  const fresh = await plan(b); expect(resolveShared(fresh).conflicts).toHaveLength(1); fresh.choices[resolveShared(fresh).conflicts[0]!.key] = 'remote'; await apply(b, fresh); expect((await b.snapshot()).bookmarks).toHaveLength(0);
});
it('本地专用不发送，已共享转本地专用会撤回远端但保留当前电脑内容', async () => {
  await a.createBookmark({ originalUrl: 'https://example.com/private', note: '私密', privacy: { localOnly: true } }); const publicBook = await a.createBookmark({ originalUrl: 'https://example.com/public' }); await sync(a); await sync(b);
  expect((await b.snapshot()).bookmarks).toHaveLength(1); const current = (await a.snapshot()).bookmarks.find((row) => row.id === publicBook.id)!;
  await a.updateBookmark(current.id, current.localRevision, { privacy: { localOnly: true, aiBlocked: false } }); await sync(a); await sync(b);
  expect((await a.snapshot()).bookmarks).toHaveLength(2); expect((await b.snapshot()).bookmarks).toHaveLength(0); expect(JSON.stringify(sql.prepare('SELECT body FROM shared_entities').all())).not.toContain('私密');
  await sync(a); expect((await a.snapshot()).bookmarks).toHaveLength(2);
});
it('新电脑同网址已有本地专用时隔离远端，不覆盖隐私或误删别人的共享', async () => {
  await a.createBookmark({ originalUrl: 'https://example.com/same', title: '共享' }); await b.createBookmark({ originalUrl: 'https://example.com/same', title: '本地', privacy: { localOnly: true } }); await sync(a); await sync(b); await sync(b); await sync(a);
  expect((await b.snapshot()).bookmarks[0]?.title).toBe('本地'); expect((await a.snapshot()).bookmarks[0]?.title).toBe('共享');
});
it('上传已成功但响应丢失，重新检查能继续且不重复创建', async () => {
  await a.createBookmark({ originalUrl: 'https://example.com/lost' }); const p = await plan(a); let lost = false;
  const flaky = new TwoWayClient(address, publisher, async (input, init) => { const response = await fetcher(input, init); if (!lost && init?.method === 'POST' && response.ok) { lost = true; throw new Error('lost response'); } return response; });
  await expect(flaky.upload(p, signal(), () => a.assertTwoWay(p), () => undefined)).rejects.toThrow('lost'); await sync(a); await sync(b); expect((await b.snapshot()).bookmarks).toHaveLength(1);
});
it('同步期间本机编辑或主库切换，事务拒绝迟到写入，不覆盖新编辑', async () => {
  await a.createBookmark({ originalUrl: 'https://example.com/late' }); await sync(a); const p = await plan(b), remote = await client.upload(p, signal(), () => b.assertTwoWay(p), () => undefined);
  await b.createBookmark({ originalUrl: 'https://example.com/local' }); await expect(b.applyTwoWay(p, remote.rows, remote.info.revision)).rejects.toThrow('本机被修改'); expect((await b.snapshot()).bookmarks[0]?.canonicalUrl).toContain('/local');
});
it('共享分页和增量游标，读/提交凭据看不到备注同步库，手机仅能看到白名单', async () => {
  for (let index = 0; index < 120; index++) await a.createBookmark({ originalUrl: `https://example.com/${index}`, note: '不公开备注' }); await sync(a); await sync(b);
  expect((await b.snapshot()).bookmarks).toHaveLength(120); const old = await b.readTwoWay(address); const update = (await a.snapshot()).bookmarks[0]!; await a.updateBookmark(update.id, update.localRevision, { title: '一条改动' }); await sync(a);
  const page = await fetcher(`${address}/v2/changes?since=${old.state!.revision}`, { headers: { Authorization: `Bearer ${publisher}` } }); expect((await page.json() as { rows: unknown[] }).rows).toHaveLength(1);
  for (const token of [reader, submitter]) expect((await fetcher(`${address}/v2/changes`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  const publicView = await fetcher(`${address}/v2/public`, { headers: { Authorization: `Bearer ${reader}` } }); expect(publicView.status).toBe(200); expect(await publicView.text()).not.toContain('不公开备注');
});
it('分类改名、层级移动、标签和拖动顺序能往返；删除空目录不会再复活', async () => {
  const root = await a.createCategory('技术'), child = await a.createCategory('网页');
  await dbA.categories.update(child.id, { parentId: root.id, sortOrder: 2048 });
  const book = await a.createBookmark({ originalUrl: 'https://example.com/tree', categoryId: child.id }); await sync(a); await sync(b);
  await dbA.categories.update(child.id, { name: '前端', sortOrder: -4096, revision: 2 }); const current = (await a.snapshot()).bookmarks[0]!; await dbA.bookmarks.update(book.id, { sortOrder: -8192, localRevision: current.localRevision + 1 }); await sync(a); await sync(b);
  expect((await b.snapshot()).categories.find((row) => row.name === '前端')?.sortOrder).toBe(-4096); expect((await b.snapshot()).bookmarks[0]?.sortOrder).toBe(-8192);
  await a.deleteBookmark(book.id); await dbA.categories.delete(child.id); await dbA.categories.delete(root.id); await sync(a); await sync(b); expect((await b.snapshot()).categories).toHaveLength(0); await sync(b); await sync(a); expect((await a.snapshot()).categories).toHaveLength(0);
});
it('旧共享目录仅剩本地专用时保留本机分类，不把云端删除目录重新上传', async () => {
  const category = await a.createCategory('分类'); const publicBook = await a.createBookmark({ originalUrl: 'https://example.com/public-cat', categoryId: category.id }); await sync(a); await sync(b);
  await a.createBookmark({ originalUrl: 'https://example.com/private-cat', categoryId: category.id, privacy: { localOnly: true } });
  const work = (await b.snapshot()).bookmarks[0]!; await b.deleteBookmark(work.id); await dbB.categories.clear(); await sync(b); await sync(a); await sync(a);
  expect((await a.snapshot()).categories).toHaveLength(1); expect((await a.snapshot()).bookmarks.map((row) => row.id)).not.toContain(publicBook.id); expect((await client.read(signal(), null)).rows.filter((row) => row.data?.kind === 'category')).toHaveLength(0);
});
it('分批发送前复核隐私，旧编辑版本在拉取后失效，替换备份会清同步基线', async () => {
  const book = await a.createBookmark({ originalUrl: 'https://example.com/guard' }); const pending = await plan(a);
  await a.updateBookmark(book.id, book.localRevision, { privacy: { localOnly: true, aiBlocked: false } }); await expect(a.assertTwoWay(pending, [...pending.projection.map(([key]) => key)])).rejects.toThrow('本地专用');
  const shared = await a.createBookmark({ originalUrl: 'https://example.com/shared' }); await sync(a); await sync(b); const work = (await b.snapshot()).bookmarks[0]!;
  const current = (await a.snapshot()).bookmarks.find((row) => row.id === shared.id)!; await a.updateBookmark(current.id, current.localRevision, { note: '新版本' }); await sync(a); await sync(b); await expect(b.updateBookmark(work.id, work.localRevision, { note: '旧草稿' })).rejects.toThrow();
  const backup = await a.exportBackup(true); expect(backup.text).not.toContain('cloud-sync:'); await createRepositories(dbA).backup.restore(backup.document, 'replace'); expect((await a.readTwoWay(address)).state).toBeNull();
});
it('手机提交使用共享分类/标签编号，任意一台电脑接收后同步，回执关联正式公开编号', async () => {
  const category = await a.createCategory('手机分类'), tag = await a.createTag('参考'); await a.createBookmark({ originalUrl: 'https://example.com/existing', categoryId: category.id, tagIds: [tag.id] }); await sync(a); await sync(b);
  const shared = await client.read(signal(), null), categoryKey = shared.rows.find((row) => row.data?.kind === 'category')!.key, tagKey = shared.rows.find((row) => row.data?.kind === 'tag')!.key;
  const input = { seq: 1, id: newId(), identity: { serverId: shared.info.serverId, libraryId: shared.info.libraryId, epoch: shared.info.epoch }, createdAt: new Date().toISOString(), payload: { destination: 'bookmark', url: 'https://example.com/from-mobile', title: '手机新收藏', sourceDescription: '', note: '手机备注', categoryId: categoryKey, categoryPath: '手机分类', tagIds: [tagKey], tagNames: ['参考'], pinned: false, unread: true, aiBlocked: false } };
  const receipt = await b.receiveCloudInbox(input, (await b.snapshot()).settings.libraryId); await sync(b); await sync(a);
  const item = (await a.snapshot()).bookmarks.find((row) => row.title === '手机新收藏')!; expect((await a.snapshot()).categories.find((row) => row.id === item.categoryId)?.name).toBe('手机分类'); expect(item.tagIds).toHaveLength(1);
  const rows = (await client.read(signal(), null)).rows; expect(rows.some((row) => row.data?.kind === 'bookmark' && row.data.publicId === receipt.recordId)).toBe(true);
});
it('空分类和未使用标签也同步，本地专用独占的目录与标签不会首次共享', async () => {
  await a.createCategory('空目录'); await a.createTag('未使用标签'); const secret = await a.createCategory('私密目录'), tag = await a.createTag('私密标签');
  await a.createBookmark({ originalUrl: 'https://example.com/secret', categoryId: secret.id, tagIds: [tag.id], privacy: { localOnly: true } }); await sync(a); await sync(b);
  expect((await b.snapshot()).categories.map((row) => row.name)).toEqual(['空目录']); expect((await b.snapshot()).tags.map((row) => row.name)).toEqual(['未使用标签']);
});
it('并发误复用同一操作编号但正文不同，失败事务不能借胜出者条件覆盖内容', async () => {
  const info = await client.info(signal()), key = `b:${await digest('https://example.com/nonce')}`;
  const data = { kind: 'bookmark', publicId: newId(), url: 'https://example.com/nonce', title: 'A', sourceDescription: '', note: '', selectedText: '', aiPurpose: '', category: null, tags: [], pinned: false, unread: true, aiBlocked: false, lockedFields: [], order: 0 };
  const value = { identity: { serverId: info.serverId, libraryId: info.libraryId, epoch: info.epoch }, deviceId: newId(), operationId: newId(), baseRevision: 0, changes: [{ key, expected: 0, data }] };
  const send = (input: unknown) => fetcher(`${address}/v2/changes`, { method: 'POST', headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const responses = await Promise.all([send(value), send({ ...value, changes: [{ key, expected: 0, data: { ...data, title: 'B' } }] })]);
  expect(responses.filter((response) => response.ok)).toHaveLength(1);
  const stored = (await client.read(signal(), null)).rows[0]!.data; expect(stored?.kind === 'bookmark' && stored.title).toBe(responses[0]!.ok ? 'A' : 'B');
});
it('启用双机同步后，旧镜像接口不再泄露过时收藏，保留独立待看', async () => {
  const { MirrorClient, planMirror } = await import('../../sync/src/client.js'); const legacy = new MirrorClient(address, publisher, fetcher);
  const info = await legacy.info(signal()); const old = await planMirror([{ kind: 'bookmark', id: 'old-id', title: '旧私密标题', url: 'https://example.com/old', categoryId: null, tagIds: [], pinned: false, unread: true }, { kind: 'reading', id: 'reading', title: '待看', url: 'https://example.com/reading' }], info); await legacy.publish(old, signal(), () => undefined);
  await a.createBookmark({ originalUrl: 'https://example.com/current' }); await sync(a);
  const response = await fetcher(`${address}/v1/mirror?generation=${old.declaration.generationId}&part=0`, { headers: { Authorization: `Bearer ${reader}` } });
  const result = await response.json() as { records: { kind: string }[] }; expect(result.records.map((row) => row.kind)).toEqual(['reading']); expect(JSON.stringify(result)).not.toContain('旧私密标题');
});
