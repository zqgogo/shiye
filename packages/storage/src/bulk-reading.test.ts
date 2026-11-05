import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { newId } from '@shiye/core';
import { ShiyeDB } from './db.js';
import { createRepositories } from './repositories.js';
let db: ShiyeDB, repos: ReturnType<typeof createRepositories>;
beforeEach(() => { db = new ShiyeDB(`bulk-reading-${newId()}`); repos = createRepositories(db); });
afterEach(async () => { vi.restoreAllMocks(); await db.delete(); });
it('批量待看新增、跳过已有、重新激活完成项，保留原收藏和分类', async () => {
 const category = await repos.categories.create('资料');
 const bookmarks = await Promise.all([1,2,3].map(n=>repos.bookmarks.create({originalUrl:`https://bulk.example/${n}`,title:`资料${n}`,categoryId:category.id})));
 await repos.reading.add({originalUrl:bookmarks[1]!.originalUrl,relatedBookmarkId:bookmarks[1]!.id});
 const completed = await repos.reading.add({originalUrl:bookmarks[2]!.originalUrl,note:'保留备注'}); await repos.reading.complete(completed.item.id);
 expect(await repos.reading.addBookmarks(bookmarks.map(b=>({id:b.id,revision:b.localRevision})))).toEqual({added:1,reactivated:1,alreadyPending:1,changed:0,missing:0});
 expect(await repos.reading.listPending()).toHaveLength(3);
 expect((await repos.reading.get(completed.item.id))).toMatchObject({note:'保留备注',relatedBookmarkId:bookmarks[2]!.id,status:'pending'});
 expect(await db.bookmarks.toArray()).toEqual(expect.arrayContaining(bookmarks));
});
it('冻结后变更或删除则跳过；重复编号仅处理一次，隐私关联保留', async () => {
 const [changed,deleted,privateRow] = await Promise.all([1,2,3].map(n=>repos.bookmarks.create({originalUrl:`https://bulk.example/${n}`,title:`资料${n}`})));
 await db.bookmarks.update(changed!.id,{localRevision:changed!.localRevision+1}); await repos.bookmarks.softDelete(deleted!.id);
 await db.bookmarks.update(privateRow!.id,{'privacy.localOnly':true});
 const inputs=[changed!,deleted!,privateRow!,privateRow!].map(b=>({id:b.id,revision:b.localRevision}));
 expect(await repos.reading.addBookmarks(inputs)).toEqual({added:1,reactivated:0,alreadyPending:0,changed:1,missing:1});
 expect((await repos.reading.listPending())[0]?.relatedBookmarkId).toBe(privateRow!.id);
});
it('执行中存储失败，整批回滚而非部分成功', async () => {
 const rows = await Promise.all([1,2].map(n=>repos.bookmarks.create({originalUrl:`https://bulk.example/${n}`,title:'测试'})));
 const add=repos.reading.add.bind(repos.reading); let calls=0;
 vi.spyOn(repos.reading,'add').mockImplementation(async p=>{ if(++calls===2) throw new Error('模拟写入失败'); return add(p); });
 await expect(repos.reading.addBookmarks(rows.map(b=>({id:b.id,revision:b.localRevision})))).rejects.toThrow('模拟写入失败');
 expect(await db.readingItems.count()).toBe(0);
});
