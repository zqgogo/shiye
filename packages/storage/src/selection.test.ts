import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Repositories } from '@shiye/application';
import { ShiyeDB } from './db.js';
import { createRepositories } from './repositories.js';

let counter = 0;
let db: ShiyeDB;
let repos: Repositories;

beforeEach(() => {
  db = new ShiyeDB(`shiye-selection-${Date.now()}-${(counter += 1)}`);
  repos = createRepositories(db);
});

afterEach(async () => {
  const name = db.name;
  db.close();
  await Dexie.delete(name);
});

describe('列表批量操作的版本与状态保护', () => {
  it('冻结后被加备注的收藏不会被移入回收站', async () => {
    const first = await repos.bookmarks.create({ originalUrl: 'https://a.example.com/1', title: '甲' });
    const second = await repos.bookmarks.create({ originalUrl: 'https://a.example.com/2', title: '乙' });

    const plan = await repos.selection.prepare('trash', [first.id, second.id]);
    expect(plan.actionable).toBe(2);

    // 另一页在确认前给甲补了备注：这正是「用户的决定」不该被旧清单覆盖的场景。
    await repos.bookmarks.update(first.id, first.localRevision, { note: '刚补的备注' }, 'human');

    const result = await repos.selection.run(plan.token);
    expect(result.removed).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ entityId: first.id, reason: '确认后被修改，已保留' });

    const kept = await db.bookmarks.get(first.id);
    expect(kept?.deletedAt).toBeNull();
    expect(kept?.note).toBe('刚补的备注');
    expect((await db.bookmarks.get(second.id))?.deletedAt).not.toBeNull();
  });

  it('回收站里勾选的条目，确认后被另一页恢复，就不再被彻底删除', async () => {
    const bookmark = await repos.bookmarks.create({ originalUrl: 'https://b.example.com/1', title: '会恢复' });
    await repos.bookmarks.softDeleteMany([bookmark.id]);

    const plan = await repos.selection.prepare('purge', [bookmark.id]);
    expect(plan.actionable).toBe(1);

    await repos.bookmarks.restoreMany([bookmark.id]);

    const result = await repos.selection.run(plan.token);
    expect(result.removed).toBe(0);
    expect(result.skipped[0]?.reason).toBe('确认后已从回收站恢复，已保留');

    const kept = await db.bookmarks.get(bookmark.id);
    expect(kept?.deletedAt).toBeNull();
    expect(kept?.title).toBe('会恢复');
  });

  it('待看勾选后被另一页标为完成，就不再被批量移出', async () => {
    const added = await repos.reading.add({ originalUrl: 'https://read.example.com/1', title: '读完再删' });
    const plan = await repos.selection.prepare('reading-remove', [added.item.id]);
    expect(plan.actionable).toBe(1);

    await repos.reading.complete(added.item.id);

    const result = await repos.selection.run(plan.token);
    expect(result.removed).toBe(0);
    expect(result.skipped[0]?.reason).toBe('确认后已完成，已保留');
    expect((await db.readingItems.get(added.item.id))?.status).toBe('completed');
  });

  it('待看勾选后被转成收藏，也不再被移出', async () => {
    const added = await repos.reading.add({ originalUrl: 'https://read.example.com/2', title: '转收藏' });
    const plan = await repos.selection.prepare('reading-remove', [added.item.id]);

    await repos.reading.convertToBookmark(added.item.id, added.item.localRevision, {});

    const result = await repos.selection.run(plan.token);
    expect(result.removed).toBe(0);
    expect(result.skipped[0]?.reason).toBe('确认后已转成收藏，已保留');
    expect(await db.readingItems.get(added.item.id)).toBeTruthy();
  });

  it('确认时就已完成 / 已恢复的条目不会进入冻结清单，确认前就说清楚', async () => {
    const done = await repos.reading.add({ originalUrl: 'https://read.example.com/3', title: '已读完' });
    await repos.reading.complete(done.item.id);

    const trashed = await repos.bookmarks.create({ originalUrl: 'https://c.example.com/1', title: '在回收站' });
    await repos.bookmarks.softDeleteMany([trashed.id]);

    const readingPlan = await repos.selection.prepare('reading-remove', [done.item.id]);
    expect(readingPlan.actionable).toBe(0);
    expect(readingPlan.excluded[0]?.reason).toBe('已完成');

    const restorePlan = await repos.selection.prepare('restore', [trashed.id]);
    expect(restorePlan.actionable).toBe(1);

    const active = await repos.bookmarks.create({ originalUrl: 'https://c.example.com/2', title: '在库' });
    const trashPlan = await repos.selection.prepare('trash', [active.id]);
    expect(trashPlan.actionable).toBe(1);
    const missing = await repos.selection.prepare('trash', ['not-exist']);
    expect(missing.excluded[0]?.reason).toBe('已不在库里');
  });

  it('全部通过时按实际条数处理，硬删除留下可找回的快照', async () => {
    const rows = await Promise.all(
      ['1', '2', '3'].map((suffix) =>
        repos.bookmarks.create({ originalUrl: `https://d.example.com/${suffix}`, title: `删${suffix}` })
      )
    );
    const plan = await repos.selection.prepare('purge', rows.map((row) => row.id));
    const result = await repos.selection.run(plan.token);

    expect(result.removed).toBe(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.snapshotId).toBeTruthy();
    expect(await db.bookmarks.count()).toBe(0);
    expect(await db.purgeSnapshots.count()).toBe(1);
  });

  it('批量恢复要把派生索引一起改回来，列表才看得见', async () => {
    const bookmark = await repos.bookmarks.create({ originalUrl: 'https://f.example.com/1', title: '回来' });
    await repos.bookmarks.softDeleteMany([bookmark.id]);
    expect((await db.bookmarks.get(bookmark.id))?.lifeState).toBe('deleted');

    const plan = await repos.selection.prepare('restore', [bookmark.id]);
    const result = await repos.selection.run(plan.token);
    expect(result.removed).toBe(1);

    const restored = await db.bookmarks.get(bookmark.id);
    expect(restored?.lifeState).toBe('active');
    expect(restored?.deletedAt).toBeNull();
    expect(await db.tombstones.get(['bookmark', bookmark.id])).toBeUndefined();
  });

  it('移入回收站与恢复都按冻结时的状态判断，不会把已删除的再删一次', async () => {
    const bookmark = await repos.bookmarks.create({ originalUrl: 'https://e.example.com/1', title: '再删一次？' });
    const plan = await repos.selection.prepare('trash', [bookmark.id]);

    // 另一页先把它移入回收站：状态变了，这次就跳过，而不是刷新删除时间。
    await repos.bookmarks.softDeleteMany([bookmark.id]);
    const result = await repos.selection.run(plan.token);
    expect(result.removed).toBe(0);
    expect(result.skipped[0]?.reason).toBe('确认后已被移入回收站，已保留');
  });

  it('待看全部通过时真的删掉并留一份可找回的快照', async () => {
    const rows = await Promise.all(
      ['4', '5'].map((suffix) =>
        repos.reading.add({ originalUrl: `https://read.example.com/${suffix}`, title: `待看${suffix}` })
      )
    );
    const plan = await repos.selection.prepare(
      'reading-remove',
      rows.map((row) => row.item.id)
    );
    const result = await repos.selection.run(plan.token);

    // 待看没有墓碑表：这条路径上不能顺带查询墓碑，否则整条事务都会失败。
    expect(result.removed).toBe(2);
    expect(result.skipped).toHaveLength(0);
    expect(await db.readingItems.count()).toBe(0);

    const snapshots = await db.purgeSnapshots.toArray();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.scopeLabel).toBe('手动移除的 2 条待看');
    expect(snapshots[0]?.readingItems).toHaveLength(2);
  });

  it('硬删除快照的标签只记真正删掉的条数，被跳过的不算进去', async () => {
    const first = await repos.bookmarks.create({ originalUrl: 'https://g.example.com/1', title: '甲' });
    const second = await repos.bookmarks.create({ originalUrl: 'https://g.example.com/2', title: '乙' });
    const plan = await repos.selection.prepare('purge', [first.id, second.id]);

    await repos.bookmarks.update(first.id, first.localRevision, { note: '刚补的备注' }, 'human');
    const result = await repos.selection.run(plan.token);
    expect(result.removed).toBe(1);

    const snapshots = await db.purgeSnapshots.toArray();
    // 写成「2 条」会让「找回」时以为被跳过的那条也是这次清掉的。
    expect(snapshots[0]?.scopeLabel).toBe('手动选择的 1 条收藏');
    expect(snapshots[0]?.bookmarks).toHaveLength(1);
    expect(snapshots[0]?.bookmarks?.[0]?.id).toBe(second.id);
  });
});
