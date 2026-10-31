import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, nowIso } from '@shiye/core';
import type { Repositories } from '@shiye/application';
import { ShiyeDB } from './db.js';
import { createRepositories } from './repositories.js';
import { createBackupRepository } from './backup.js';

let counter = 0;
let db: ShiyeDB;
let repos: Repositories;

beforeEach(() => {
  db = new ShiyeDB(`shiye-test-${Date.now()}-${counter += 1}`);
  repos = createRepositories(db, createBackupRepository(db));
});

afterEach(async () => {
  const name = db.name;
  db.close();
  await Dexie.delete(name);
});

describe('收藏仓库', () => {
  it('创建时写入派生索引键，重复网址被拒绝并返回已有 ID', async () => {
    const created = await repos.bookmarks.create({
      originalUrl: 'https://Example.com/A?x=1#h',
      title: '测试收藏',
    });
    expect(created.canonicalUrl).toBe('https://example.com/A?x=1#h');
    expect(created.lifeState).toBe('active');
    expect(created.unreadFlag).toBe(1);
    expect(created.categoryKey).toBe('uncategorized');
    expect(created.inboxUnread).toBe(true);

    await expect(
      repos.bookmarks.create({ originalUrl: 'https://example.com/A?x=1#h', title: '重复' })
    ).rejects.toMatchObject({ code: 'DUPLICATE', details: { bookmarkId: created.id } });

    const stored = await db.bookmarks.get(created.id);
    expect(stored?.title).toBe('测试收藏');
  });

  it('版本冲突拒绝写入，人工修正可成功并递增版本', async () => {
    const created = await repos.bookmarks.create({ originalUrl: 'https://example.com/a', title: 'A' });
    await expect(
      repos.bookmarks.update(created.id, created.localRevision + 5, { title: 'B' }, 'human')
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    const updated = await repos.bookmarks.update(created.id, created.localRevision, { title: 'B' }, 'human');
    expect(updated.title).toBe('B');
    expect(updated.revision).toBe(2);
    expect(updated.localRevision).toBe(2);
  });

  it('AI 写入受锁定字段约束，且不能改备注与隐私', async () => {
    const created = await repos.bookmarks.create({ originalUrl: 'https://example.com/lock', title: 'L' });
    await repos.bookmarks.update(created.id, created.localRevision, { lockedFields: ['categoryId'] }, 'human');
    const current = await repos.bookmarks.get(created.id);
    await expect(
      repos.bookmarks.update(created.id, current!.localRevision, { categoryId: null }, 'ai')
    ).rejects.toMatchObject({ code: 'LOCKED_FIELD' });
    await expect(
      repos.bookmarks.update(created.id, current!.localRevision, { note: 'AI 改写' }, 'ai')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('已读与分类互相独立', async () => {
    const uncategorized = await repos.bookmarks.create({ originalUrl: 'https://example.com/u', title: 'U' });
    const category = await repos.categories.create('开发');
    const categorized = await repos.bookmarks.create({
      originalUrl: 'https://example.com/c',
      title: 'C',
      categoryId: category.id,
    });
    await repos.bookmarks.markRead([uncategorized.id, categorized.id]);
    const u = await repos.bookmarks.get(uncategorized.id);
    const c = await repos.bookmarks.get(categorized.id);
    expect(u?.inboxUnread).toBe(false);
    expect(u?.categoryId).toBeNull();
    expect(c?.inboxUnread).toBe(false);
    expect(c?.categoryId).toBe(category.id);

    await repos.bookmarks.markUnread([u!.id]);
    expect((await repos.bookmarks.get(uncategorized.id))?.inboxUnread).toBe(true);
  });

  it('软删除写入墓碑，普通新增不能绕过，恢复保留分类与未读状态', async () => {
    const category = await repos.categories.create('阅读');
    const created = await repos.bookmarks.create({
      originalUrl: 'https://example.com/deleted',
      title: '将被删除',
      categoryId: category.id,
      inboxUnread: true,
    });
    const deleted = await repos.bookmarks.softDelete(created.id);
    expect(deleted.deletedAt).toBeTruthy();
    expect(deleted.lifeState).toBe('deleted');

    const tombstones = await repos.backup.listTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.canonicalUrl).toBe('https://example.com/deleted');

    await expect(
      repos.bookmarks.create({ originalUrl: 'https://example.com/deleted', title: '复活' })
    ).rejects.toMatchObject({ code: 'TOMBSTONED' });

    const restored = await repos.bookmarks.restore(created.id);
    expect(restored.deletedAt).toBeNull();
    expect(restored.categoryId).toBe(category.id);
    expect(restored.inboxUnread).toBe(true);
    expect(await repos.backup.listTombstones()).toHaveLength(0);
  });
});

describe('待看队列', () => {
  it('转入收藏在同一事务中新增并完成，重复转换不再新建', async () => {
    const { item } = await repos.reading.add({
      originalUrl: 'https://example.com/queue',
      title: '队列条目',
      note: '稍后看',
    });
    const category = await repos.categories.create('开发');
    const { bookmark } = await repos.reading.convertToBookmark(item.id, item.localRevision, {
      categoryId: category.id,
      title: '转入后的标题',
    });
    expect(bookmark.inboxUnread).toBe(true);
    expect(bookmark.categoryId).toBe(category.id);
    expect(bookmark.note).toBe('稍后看');

    const queue = await repos.reading.get(item.id);
    expect(queue?.status).toBe('completed');
    expect(queue?.relatedBookmarkId).toBe(bookmark.id);

    await expect(
      repos.reading.convertToBookmark(item.id, queue!.localRevision, {})
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await repos.bookmarks.listActive()).toHaveLength(1);
  });

  it('已有收藏时不重复创建，队列保持 pending（R01）', async () => {
    const existing = await repos.bookmarks.create({
      originalUrl: 'https://example.com/dup',
      title: '已有收藏',
    });
    const { item } = await repos.reading.add({ originalUrl: 'https://example.com/dup', title: '待看' });
    await expect(
      repos.reading.convertToBookmark(item.id, item.localRevision, {})
    ).rejects.toMatchObject({ code: 'DUPLICATE', details: { bookmarkId: existing.id } });
    expect((await repos.reading.get(item.id))?.status).toBe('pending');
    expect(await repos.bookmarks.listActive()).toHaveLength(1);
  });

  it('分类引用失效时整体回滚，没有半批写入', async () => {
    const { item } = await repos.reading.add({ originalUrl: 'https://example.com/rollback', title: '回滚' });
    await expect(
      repos.reading.convertToBookmark(item.id, item.localRevision, { categoryId: 'missing-category' })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await repos.reading.get(item.id))?.status).toBe('pending');
    expect(await repos.bookmarks.listActive()).toHaveLength(0);
  });

  it('完成待看不影响已有收藏；已完成可恢复 pending', async () => {
    const bookmark = await repos.bookmarks.create({
      originalUrl: 'https://example.com/keep',
      title: '保留收藏',
      categoryId: null,
    });
    const { item } = await repos.reading.add({
      originalUrl: 'https://example.com/keep',
      title: '保留收藏',
      relatedBookmarkId: bookmark.id,
    });
    const completed = await repos.reading.complete(item.id);
    expect(completed.status).toBe('completed');
    const stillThere = await repos.bookmarks.get(bookmark.id);
    expect(stillThere?.deletedAt).toBeNull();
    expect(stillThere?.title).toBe('保留收藏');

    const reopened = await repos.reading.reopen(item.id);
    expect(reopened.status).toBe('pending');
    expect(reopened.completedAt).toBeNull();
  });

  it('已完成记录再次加入时恢复 pending 并刷新加入时间', async () => {
    const { item } = await repos.reading.add({ originalUrl: 'https://example.com/again', title: '再来' });
    await repos.reading.complete(item.id);
    const again = await repos.reading.add({ originalUrl: 'https://example.com/again', title: '再来' });
    expect(again.reactivated).toBe(true);
    expect(again.item.id).toBe(item.id);
    expect(again.item.status).toBe('pending');
    expect(again.item.addedAt >= item.addedAt).toBe(true);
  });
});

describe('分类与导入', () => {
  it('删除分类迁移引用而不删除收藏', async () => {
    const from = await repos.categories.create('待删除');
    const to = await repos.categories.create('目标');
    const bookmark = await repos.bookmarks.create({
      originalUrl: 'https://example.com/move',
      title: '迁移',
      categoryId: from.id,
    });
    const result = await repos.categories.remove(from.id, to.id);
    expect(result.movedBookmarks).toBe(1);
    const moved = await repos.bookmarks.get(bookmark.id);
    expect(moved?.categoryId).toBe(to.id);
    expect(moved?.deletedAt).toBeNull();
    expect(await db.categories.get(from.id)).toBeUndefined();
  });

  it('导入只写入勾选的可新增行，重复提交返回 ALREADY_APPLIED', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/existing', title: '已存在' });
    const params = {
      batchId: 'batch-1',
      source: 'paste' as const,
      fileName: '粘贴链接',
      fileHash: 'hash-1',
      destination: 'library' as const,
      rows: [
        {
          sourceKey: 'row-1',
          line: 1,
          originalUrl: 'https://example.com/new-1',
          canonicalUrl: 'https://example.com/new-1',
          title: '新增一',
          sourceFolder: '',
          targetCategoryId: null,
          status: 'new' as const,
          reason: '可保存',
          selected: true,
          duplicateOf: null,
        },
        {
          sourceKey: 'row-2',
          line: 2,
          originalUrl: 'https://example.com/existing',
          canonicalUrl: 'https://example.com/existing',
          title: '已存在',
          sourceFolder: '',
          targetCategoryId: null,
          status: 'new' as const,
          reason: '并发期间被收藏',
          selected: true,
          duplicateOf: null,
        },
        {
          sourceKey: 'row-3',
          line: 3,
          originalUrl: 'https://example.com/unselected',
          canonicalUrl: 'https://example.com/unselected',
          title: '未勾选',
          sourceFolder: '',
          targetCategoryId: null,
          status: 'new' as const,
          reason: '可保存',
          selected: false,
          duplicateOf: null,
        },
      ],
    };
    const result = await repos.imports.commit(params);
    expect(result.inserted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(await repos.bookmarks.findByCanonical('https://example.com/unselected')).toBeUndefined();

    await expect(repos.imports.commit(params)).rejects.toMatchObject({ code: 'ALREADY_APPLIED' });
    expect((await repos.bookmarks.listActive()).length).toBe(2);
  });
});

describe('备份与恢复', () => {
  it('导出包含待看、收藏与墓碑，且不含凭据字段', async () => {
    const category = await repos.categories.create('开发');
    await repos.bookmarks.create({
      originalUrl: 'https://example.com/one',
      title: '一',
      categoryId: category.id,
    });
    const second = await repos.bookmarks.create({ originalUrl: 'https://example.com/two', title: '二' });
    await repos.reading.add({ originalUrl: 'https://example.com/queue', title: '待看' });
    await repos.bookmarks.softDelete(second.id);

    const document = await repos.backup.exportDocument({ includeLocalOnly: true });
    const text = JSON.stringify(document);
    expect(document.bookmarks).toHaveLength(2);
    expect(document.readingItems).toHaveLength(1);
    expect(document.tombstones).toHaveLength(1);
    expect(text).not.toMatch(/apiKey|password|bearer/i);
    expect(document.schemaVersion).toBe(2);

    const freshDb = new ShiyeDB(`shiye-restore-${Date.now()}`);
    try {
      await freshDb.open();
      const freshRepos = createRepositories(freshDb);
      const result = await freshRepos.backup.restore(document, 'replace');
      expect(result.bookmarksAdded).toBe(2);
      expect(result.readingAdded).toBe(1);
      expect(result.tombstonesAdded).toBe(1);
      const restored = await freshRepos.bookmarks.listDeleted();
      expect(restored).toHaveLength(1);
      expect(restored[0]?.lifeState).toBe('deleted');
    } finally {
      const name = freshDb.name;
      freshDb.close();
      await Dexie.delete(name);
    }
  });

  it('恢复旧版备份时显式迁移并提示价值等级被忽略', async () => {
    const legacy = JSON.parse(
      await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('../../../fixtures/legacy-backup-v1.json', import.meta.url), 'utf8')
      )
    ) as Record<string, unknown>;
    const document = legacy as unknown as Parameters<typeof repos.backup.restore>[0];
    const result = await repos.backup.restore(document, 'merge');
    expect(result.warnings.join(' ')).toContain('旧版格式');
    const bookmarks = await repos.bookmarks.listActive();
    expect(bookmarks).toHaveLength(2);
    const uncategorized = bookmarks.find((bookmark) => bookmark.id === 'b-uncategorized');
    expect(uncategorized?.inboxUnread).toBe(true);
    expect(uncategorized?.title).toBe('UIKit 文档');
    const categorized = bookmarks.find((bookmark) => bookmark.id === 'b-categorized');
    expect(categorized?.inboxUnread).toBe(false);
    expect(uncategorized).not.toHaveProperty('valueLevel');
  });
});

describe('旧库迁移', () => {
  it('版本 1 主库升级时补齐字段、生成派生键并移除价值等级', async () => {
    const name = `shiye-migration-${Date.now()}`;
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      bookmarks: '&id, canonicalUrl, categoryId, createdAt, lastOpenedAt',
      readingItems: '&id, canonicalUrl, status, addedAt',
      categories: '&id, name',
      tags: '&id, name',
      settings: '&key',
    });
    await legacy.open();
    await legacy.table('bookmarks').bulkAdd([
      {
        id: 'legacy-1',
        url: 'https://example.com/legacy?b=2',
        title: '旧条目',
        description: '旧描述',
        categoryId: null,
        valueLevel: 'high',
        valueReason: '常用',
        createdAt: Date.parse('2026-01-02T03:04:05Z'),
        revision: 3,
      },
      {
        id: 'legacy-2',
        url: 'https://example.com/categorized',
        title: '已分类旧条目',
        categoryId: 'cat-x',
        valueLevel: 'low',
        createdAt: Date.parse('2026-01-03T03:04:05Z'),
        deadline: nowIso(),
      },
    ]);
    legacy.close();

    const migrated = new ShiyeDB(name);
    try {
      await migrated.open();
      const one = await migrated.bookmarks.get('legacy-1');
      expect(one?.canonicalUrl).toBe('https://example.com/legacy?b=2');
      expect(one?.originalUrl).toBe('https://example.com/legacy?b=2');
      expect(one?.inboxUnread).toBe(true);
      expect(one?.lifeState).toBe('active');
      expect(one?.sourceDescription).toBe('旧描述');
      expect(one?.createdAt).toBe('2026-01-02T03:04:05.000Z');
      expect((one as unknown as Record<string, unknown>)['valueLevel']).toBeUndefined();
      const two = await migrated.bookmarks.get('legacy-2');
      expect(two?.inboxUnread).toBe(false);
      expect(two?.categoryKey).toBe('cat-x');
      expect((await migrated.bookmarks.where('lifeState').equals('active').toArray()).length).toBe(2);
    } finally {
      migrated.close();
      await Dexie.delete(name);
    }
  });
});

describe('错误契约', () => {
  it('未找到记录返回 NOT_FOUND', async () => {
    await expect(repos.bookmarks.update('missing', 1, { title: 'x' }, 'human')).rejects.toBeInstanceOf(AppError);
  });
});

describe('清空作用域计数', () => {
  it('分类清空把回收站里的记录算进来，计数与实删数量一致', async () => {
    const category = await repos.categories.create('计数分类');
    const keep = await repos.bookmarks.create({ originalUrl: 'https://example.com/keep', title: '留下' });
    const alive = await repos.bookmarks.create({
      originalUrl: 'https://example.com/alive',
      title: '在库',
      categoryId: category.id,
    });
    const trashed = await repos.bookmarks.create({
      originalUrl: 'https://example.com/trashed',
      title: '已删除',
      categoryId: category.id,
    });
    await repos.bookmarks.softDelete(trashed.id);

    const counts = await repos.bookmarks.countPurgeCategory(category.id);
    expect(counts).toEqual({ active: 1, trashed: 1, tombstones: 1 });

    const removed = await repos.bookmarks.purgeCategory(category.id);
    // 界面按「在库 + 回收站」报数，必须与实际删除量一致。
    expect(removed).toBe(counts.active + counts.trashed);
    expect(await db.bookmarks.get(alive.id)).toBeUndefined();
    expect(await db.bookmarks.get(trashed.id)).toBeUndefined();
    expect(await db.bookmarks.get(keep.id)).toBeDefined();
    expect(await repos.bookmarks.countPurgeCategory(category.id)).toEqual({
      active: 0,
      trashed: 0,
      tombstones: 0,
    });
  });

  it('整库清空的计数包含回收站，且与实删数量一致', async () => {
    const alive = await repos.bookmarks.create({ originalUrl: 'https://example.com/a1', title: 'A1' });
    const trashed = await repos.bookmarks.create({ originalUrl: 'https://example.com/a2', title: 'A2' });
    await repos.bookmarks.softDelete(trashed.id);

    const counts = await repos.bookmarks.countPurgeAll();
    expect(counts).toEqual({ active: 1, trashed: 1, tombstones: 1 });

    const removed = await repos.bookmarks.purgeAll();
    expect(removed).toBe(counts.active + counts.trashed);
    expect(await db.bookmarks.count()).toBe(0);
    expect(await repos.bookmarks.countPurgeAll()).toEqual({ active: 0, trashed: 0, tombstones: 0 });
    expect(await db.bookmarks.get(alive.id)).toBeUndefined();
  });
});
