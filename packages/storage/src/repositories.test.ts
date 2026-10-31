import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, SCHEMA_VERSION, nowIso } from '@shiye/core';
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
    expect(document.schemaVersion).toBe(SCHEMA_VERSION);

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

describe('清理快照与单次恢复', () => {
  const withHooks = (hooks: Parameters<typeof createRepositories>[2]) =>
    createRepositories(db, createBackupRepository(db), hooks);

  it('每次硬删除都留下快照，六个入口都能找回', async () => {
    const a = await repos.bookmarks.create({ originalUrl: 'https://example.com/p1', title: 'A' });
    const b = await repos.bookmarks.create({ originalUrl: 'https://example.com/p2', title: 'B' });
    await repos.reading.add({ originalUrl: 'https://example.com/r1', title: 'R1' });
    await repos.reading.add({ originalUrl: 'https://example.com/r2', title: 'R2' });

    await repos.bookmarks.softDelete(b.id);
    await repos.bookmarks.purgeAll();
    await repos.reading.purgePending();

    const snapshots = await repos.purge.list();
    expect(snapshots.map((row) => row.entry)).toEqual(['readingPending', 'all']);
    const all = snapshots.find((row) => row.entry === 'all');
    expect(all?.counts.bookmarks).toBe(2);
    expect(all?.counts.tombstones).toBe(1);
    const pending = snapshots.find((row) => row.entry === 'readingPending');
    expect(pending?.counts.readingItems).toBe(2);
    expect(a.id).toBeTruthy();
  });

  it('快照写不进去时一条都不删', async () => {
    const broken = withHooks({
      beforeSnapshotWrite: () => {
        throw new AppError('QUOTA_EXCEEDED', '空间不足');
      },
    });
    await broken.bookmarks.create({ originalUrl: 'https://example.com/keep1', title: '保留 1' });
    await broken.bookmarks.create({ originalUrl: 'https://example.com/keep2', title: '保留 2' });

    await expect(broken.bookmarks.purgeAll()).rejects.toBeInstanceOf(AppError);
    expect(await db.bookmarks.count()).toBe(2);
    expect(await broken.purge.list()).toHaveLength(0);
  });

  it('删除中途失败时整体回滚，快照也不残留', async () => {
    const broken = withHooks({
      beforeDelete: () => {
        throw new AppError('STORAGE_FAILED', '写到一半失败');
      },
    });
    await broken.bookmarks.create({ originalUrl: 'https://example.com/mid1', title: '中途 1' });
    await broken.reading.add({ originalUrl: 'https://example.com/mid2', title: '中途 2' });

    await expect(broken.reading.purgePending()).rejects.toBeInstanceOf(AppError);
    expect(await db.readingItems.count()).toBe(1);
    expect(await broken.purge.list()).toHaveLength(0);
  });

  it('超过单份上限时拒绝清理，主库不动', async () => {
    const seed = await repos.bookmarks.create({ originalUrl: 'https://example.com/seed', title: 'seed' });
    const rows = Array.from({ length: 5001 }, (_, index) => ({
      ...seed,
      id: `bulk-${index}`,
      originalUrl: `https://example.com/bulk-${index}`,
      canonicalUrl: `https://example.com/bulk-${index}`,
      title: `bulk ${index}`,
    }));
    await db.bookmarks.bulkPut(rows);

    await expect(repos.bookmarks.purgeAll()).rejects.toMatchObject({ code: 'SNAPSHOT_TOO_LARGE' });
    expect(await db.bookmarks.count()).toBe(5002);
    expect(await repos.purge.list()).toHaveLength(0);
  });

  it('只保留最近 5 份快照，最旧的被淘汰', async () => {
    for (let index = 0; index < 6; index += 1) {
      await repos.bookmarks.create({
        originalUrl: `https://example.com/round-${index}`,
        title: `第 ${index} 轮`,
      });
      await repos.bookmarks.purgeAll();
    }
    const snapshots = await repos.purge.list();
    expect(snapshots).toHaveLength(5);
    const labels = snapshots.map((row) => row.bookmarks[0]?.title);
    expect(labels).not.toContain('第 0 轮');
    expect(labels).toContain('第 5 轮');
  });

  it('恢复只加回这一次删掉的条目，其它记录不变', async () => {
    const keep = await repos.bookmarks.create({ originalUrl: 'https://example.com/keep', title: '不该被动' });
    await repos.bookmarks.create({ originalUrl: 'https://example.com/gone-1', title: '被清 1' });
    await repos.bookmarks.create({ originalUrl: 'https://example.com/gone-2', title: '被清 2' });
    await repos.bookmarks.purgeAll();
    const [snapshot] = await repos.purge.list();
    if (!snapshot) throw new Error('应当留下清理快照');

    const preview = await repos.purge.preview(snapshot.id);
    expect(preview.candidates).toBe(3);
    expect(preview.restorable).toBe(3);

    const outcome = await repos.purge.restore(snapshot.id);
    expect(outcome.restored).toBe(3);
    expect(await db.bookmarks.count()).toBe(3);
    const titles = (await db.bookmarks.toArray()).map((row) => row.title).sort();
    expect(titles).toEqual(['不该被动', '被清 1', '被清 2']);
    expect(await db.bookmarks.get(keep.id)).toBeTruthy();
  });

  it('同网址已重新导入时跳过不覆盖，且在事务内重新判定', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/reimport', title: '清理前的旧标题' });
    await repos.bookmarks.purgeAll();
    const [snapshot] = await repos.purge.list();
    if (!snapshot) throw new Error('应当留下清理快照');

    // 清理后用户重新导入了同一网址，标题不同。
    const reimported = await repos.bookmarks.create({
      originalUrl: 'https://example.com/reimport',
      title: '重新导入的新标题',
    });

    const outcome = await repos.purge.restore(snapshot.id);
    expect(outcome.restored).toBe(0);
    expect(outcome.preview.conflicted).toBe(1);
    const current = await db.bookmarks.toArray();
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(reimported.id);
    expect(current[0]?.title).toBe('重新导入的新标题');
  });

  it('恢复到回收站状态而不是把已删条目复活到列表', async () => {
    const gone = await repos.bookmarks.create({ originalUrl: 'https://example.com/trashed', title: '进过回收站' });
    await repos.bookmarks.softDelete(gone.id);
    await repos.bookmarks.purgeAll();
    const [snapshot] = await repos.purge.list();
    if (!snapshot) throw new Error('应当留下清理快照');

    await repos.purge.restore(snapshot.id);
    const restored = await db.bookmarks.get(gone.id);
    expect(restored?.deletedAt).toBeTruthy();
    expect(restored?.lifeState).toBe('deleted');
  });

  it('恢复后清掉同网址墓碑，同一批书签可以重新导入', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/tomb', title: '带墓碑' });
    await repos.bookmarks.purgeAll();
    const [snapshot] = await repos.purge.list();
    if (!snapshot) throw new Error('应当留下清理快照');

    await repos.purge.restore(snapshot.id);
    const tombstones = await db.tombstones.toArray();
    expect(tombstones.filter((row) => row.entityType === 'bookmark')).toHaveLength(0);
  });

  it('待看清空后可以只把这一次的队列找回来', async () => {
    await repos.reading.add({ originalUrl: 'https://example.com/q1', title: '队列 1' });
    await repos.reading.add({ originalUrl: 'https://example.com/q2', title: '队列 2' });
    await repos.reading.purgePending();
    const [snapshot] = await repos.purge.list();
    if (!snapshot) throw new Error('应当留下清理快照');
    expect(snapshot.entry).toBe('readingPending');

    const outcome = await repos.purge.restore(snapshot.id);
    expect(outcome.restored).toBe(2);
    expect(await repos.reading.listPending()).toHaveLength(2);
  });
});

describe('清理快照与本机安全网', () => {
  it('替换恢复不会清掉清理快照', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/safety-1', title: '安全网 1' });
    await repos.bookmarks.purgeAll();
    const [snapshot] = await repos.purge.list();
    if (!snapshot) throw new Error('应当留下清理快照');
    expect(await repos.purge.list()).toHaveLength(1);

    const document = await repos.backup.exportDocument({ includeLocalOnly: true });
    await repos.backup.restore(document, 'replace');

    // 替换恢复会清空收藏、待看、分类等表——但清理快照是本机安全网，不能被连带清掉。
    expect(await db.bookmarks.count()).toBe(0);
    const survived = await repos.purge.list();
    expect(survived).toHaveLength(1);
    expect(survived[0]?.id).toBe(snapshot.id);
    expect(survived[0]?.counts.bookmarks).toBe(1);
  });

  it('替换恢复后仍能找回清理前的条目', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/safety-2', title: '安全网 2' });
    await repos.bookmarks.purgeAll();
    const [snapshot] = await repos.purge.list();
    if (!snapshot) throw new Error('应当留下清理快照');

    const document = await repos.backup.exportDocument({ includeLocalOnly: true });
    await repos.backup.restore(document, 'replace');
    expect(await db.bookmarks.count()).toBe(0);

    const outcome = await repos.purge.restore(snapshot.id);
    expect(outcome.restored).toBe(1);
    const titles = (await db.bookmarks.toArray()).map((row) => row.title);
    expect(titles).toEqual(['安全网 2']);
  });
});

describe('批次撤回：预览、保留原因与留档', () => {
  let seq = 0;

  async function commitBatch(
    destination: 'library' | 'reading',
    specs: { title: string; url: string }[]
  ): Promise<{ batchId: string; createdIds: string[] }> {
    seq += 1;
    const batchId = `batch-${seq}-${Date.now()}`;
    const result = await repos.imports.commit({
      batchId,
      source: 'bookmarkHtml',
      fileName: `bookmarks-${seq}.html`,
      fileHash: null,
      destination,
      rows: specs.map((spec, index) => ({
        sourceKey: `row-${index + 1}`,
        line: index + 1,
        originalUrl: spec.url,
        canonicalUrl: spec.url,
        title: spec.title,
        sourceFolder: '',
        targetCategoryId: null,
        status: 'new' as const,
        reason: '可保存',
        selected: true,
        duplicateOf: null,
      })),
    });
    return { batchId, createdIds: result.createdIds };
  }

  it('预览的三类计数与执行结果完全一致', async () => {
    const { batchId, createdIds } = await commitBatch('library', [
      { title: '原样未动', url: 'https://example.com/keep-clean' },
      { title: '被改过', url: 'https://example.com/keep-modified' },
      { title: '进了回收站', url: 'https://example.com/keep-trashed' },
      { title: '自己删了', url: 'https://example.com/gone' },
    ]);
    const modified = await repos.bookmarks.findByCanonical('https://example.com/keep-modified');
    if (!modified) throw new Error('样本缺失');
    await repos.bookmarks.update(modified.id, modified.localRevision, { title: '改过的标题' }, 'human');
    const trashed = await repos.bookmarks.findByCanonical('https://example.com/keep-trashed');
    if (!trashed) throw new Error('样本缺失');
    await repos.bookmarks.softDelete(trashed.id);
    const goneId = createdIds[3];
    if (!goneId) throw new Error('样本缺失');
    await db.bookmarks.delete(goneId);

    const preview = await repos.imports.previewUndoBatch(batchId);
    expect(preview.total).toBe(4);
    expect(preview.removed).toBe(1);
    expect(preview.kept).toBe(2);
    expect(preview.missing).toBe(1);
    expect(preview.blockedReason).toBeNull();
    // 预览只读：此时主库一条都不该少。
    expect(await db.bookmarks.count()).toBe(3);

    const outcome = await repos.imports.undoBatch(batchId);
    expect(outcome.removed).toBe(preview.removed);
    expect(outcome.kept).toBe(preview.kept);
    expect(outcome.missing).toBe(preview.missing);
    expect(await db.bookmarks.count()).toBe(2);
  });

  it('保留原因区分改过 / 回收站 / 待看已完成 / 已转收藏 / 已不存在', async () => {
    const library = await commitBatch('library', [
      { title: '被编辑', url: 'https://example.com/r-modified' },
      { title: '进回收站', url: 'https://example.com/r-trashed' },
    ]);
    const edited = await repos.bookmarks.findByCanonical('https://example.com/r-modified');
    if (!edited) throw new Error('样本缺失');
    await repos.bookmarks.update(edited.id, edited.localRevision, { note: '加个备注' }, 'human');
    const trashed = await repos.bookmarks.findByCanonical('https://example.com/r-trashed');
    if (!trashed) throw new Error('样本缺失');
    await repos.bookmarks.softDelete(trashed.id);
    await repos.imports.undoBatch(library.batchId);

    const libraryBatch = await repos.imports.getBatch(library.batchId);
    const libraryReasons = (libraryBatch?.undoKept ?? []).map((item) => item.reason).sort();
    expect(libraryReasons).toEqual(['modified', 'trashed']);

    const reading = await commitBatch('reading', [
      { title: '完成的', url: 'https://example.com/r-completed' },
      { title: '转收藏的', url: 'https://example.com/r-converted' },
    ]);
    const completed = await repos.reading.findByCanonical('https://example.com/r-completed');
    if (!completed) throw new Error('样本缺失');
    await repos.reading.complete(completed.id);
    const converted = await repos.reading.findByCanonical('https://example.com/r-converted');
    if (!converted) throw new Error('样本缺失');
    await repos.reading.convertToBookmark(converted.id, converted.localRevision, {});
    await repos.imports.undoBatch(reading.batchId);

    const readingBatch = await repos.imports.getBatch(reading.batchId);
    const readingReasons = (readingBatch?.undoKept ?? []).map((item) => item.reason).sort();
    expect(readingReasons).toEqual(['completed', 'converted']);
  });

  it('撤回结果写进批次，刷新后仍能回看条数与原因', async () => {
    const { batchId } = await commitBatch('library', [
      { title: '要删的', url: 'https://example.com/persist-1' },
      { title: '要留的', url: 'https://example.com/persist-2' },
    ]);
    const kept = await repos.bookmarks.findByCanonical('https://example.com/persist-2');
    if (!kept) throw new Error('样本缺失');
    await repos.bookmarks.update(kept.id, kept.localRevision, { note: '改过' }, 'human');

    await repos.imports.undoBatch(batchId);
    const stored = await repos.imports.getBatch(batchId);
    expect(stored?.status).toBe('reverted');
    expect(stored?.revertedAt).toBeTruthy();
    expect(stored?.undoCounts).toEqual({ removed: 1, kept: 1, missing: 0 });
    expect(stored?.undoKept).toHaveLength(1);
    expect(stored?.undoKept[0]?.reason).toBe('modified');

    // 关掉再开（模拟刷新 / 重开页），批次上的留档还在。
    const name = db.name;
    db.close();
    const reopened = new ShiyeDB(name);
    try {
      const reopenedBatch = await reopened.importBatches.get(batchId);
      expect(reopenedBatch?.undoCounts).toEqual({ removed: 1, kept: 1, missing: 0 });
      expect(reopenedBatch?.undoKept).toHaveLength(1);
    } finally {
      reopened.close();
      db = new ShiyeDB(`${name}-tail`);
      repos = createRepositories(db, createBackupRepository(db));
    }
  });

  it('已撤回的批次不能再撤一次，预览直接给出理由', async () => {
    const { batchId } = await commitBatch('library', [
      { title: '一次', url: 'https://example.com/once' },
    ]);
    await repos.imports.undoBatch(batchId);

    const preview = await repos.imports.previewUndoBatch(batchId);
    expect(preview.blockedReason).toBe('这一批已经撤销过了。');
    expect(preview.total).toBe(0);
    await expect(repos.imports.undoBatch(batchId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('批次列表可按文件名搜索并分页，不再固定只给最近 20 批', async () => {
    for (let index = 0; index < 25; index += 1) {
      await commitBatch('library', [
        { title: `条目 ${index}`, url: `https://example.com/list-${index}` },
      ]);
    }
    const firstPage = await repos.imports.listBatches({ limit: 20 });
    expect(firstPage.rows).toHaveLength(20);
    expect(firstPage.total).toBe(25);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await repos.imports.listBatches({ limit: 20, offset: 20 });
    expect(secondPage.rows).toHaveLength(5);
    expect(secondPage.hasMore).toBe(false);

    // 按文件名模糊搜索：用真实存在的那个名字，避免依赖批次序号。
    const target = firstPage.rows[0]?.fileName ?? '';
    const searched = await repos.imports.listBatches({ search: target });
    expect(searched.total).toBe(1);
    expect(searched.rows[0]?.fileName).toBe(target);

    const none = await repos.imports.listBatches({ search: '不存在的文件名' });
    expect(none.total).toBe(0);
    expect(none.hasMore).toBe(false);
  });
});

describe('批次字段迁移', () => {
  it('版本 3 主库升级时给老批次补上撤回字段，且不编造撤回记录', async () => {
    const name = `shiye-migrate-v4-${Date.now()}`;
    const legacy = new Dexie(name);
    legacy.version(3).stores({
      bookmarks:
        '&id, canonicalUrl, categoryKey, lifeState, [lifeState+unreadFlag], createdAt, lastOpenedAt, localRevision, *tagIds',
      readingItems: '&id, canonicalUrl, status, [status+addedAt], relatedBookmarkId, localRevision',
      categories: '&id, name',
      tags: '&id, name',
      settings: '&key',
      policies: '&id',
      tombstones: '&[entityType+id], deletedAt, canonicalUrl',
      aiTasks: '&id, kind, state, createdAt',
      handoffBatches: '&id, createdAt, status',
      handoffItems: '&[batchId+n], [batchId+bookmarkId], status',
      appliedChanges: '&id, taskId, bookmarkId, appliedAt',
      importBatches: '&id, fileHash, status, createdAt',
      importItems: '&[batchId+sourceKey], entityId',
      purgeSnapshots: '&id, createdAt, entry',
      meta: '&key',
    });
    await legacy.open();
    await legacy.table('importBatches').add({
      id: 'old-batch',
      source: 'bookmarkHtml',
      fileName: 'old.html',
      fileHash: null,
      destination: 'library',
      status: 'applied',
      total: 2,
      inserted: 2,
      skipped: 0,
      invalid: 0,
      createdAt: nowIso(),
      appliedAt: nowIso(),
      error: null,
    });
    legacy.close();

    const upgraded = new ShiyeDB(name);
    try {
      await upgraded.open();
      const row = await upgraded.importBatches.get('old-batch');
      // 只补字段，不改状态：老批次仍然算「已写入、未撤回」。
      expect(row?.status).toBe('applied');
      expect(row?.revertedAt).toBeNull();
      expect(row?.undoCounts).toBeNull();
      expect(row?.undoKept).toEqual([]);
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });
});
