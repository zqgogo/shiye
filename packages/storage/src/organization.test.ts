import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LIMITS, newId, nowIso, parseBookmarkHtml, planImport, type ImportArrangement, type ImportDraft, type ImportRow } from '@shiye/core';
import { ShiyeDB } from './db.js';
import { createRepositories } from './repositories.js';

let db: ShiyeDB;
let repos: ReturnType<typeof createRepositories>;
beforeEach(() => { db = new ShiyeDB(`organization-${newId()}`); repos = createRepositories(db); });
afterEach(async () => { await db.delete(); });

function rows(paths: string[][]): ImportRow[] {
  return paths.map((path, index) => ({ sourceKey: `r${index}`, line: index + 1,
    originalUrl: `https://example.com/${index}`, canonicalUrl: `https://example.com/${index}`, title: `书签${index}`,
    sourceFolder: path.join(' / '), sourceFolderSegments: path, targetCategoryId: null,
    status: 'new', reason: '可新增', selected: true, duplicateOf: null }));
}
const arrangement = (mode: 'group' | 'original' = 'original'): ImportArrangement => ({ mode, parentId: null, groupName: '独立导入', paths: {} });
async function commit(input: ImportRow[], options = arrangement(), batchId = newId()) {
  return repos.imports.commit({ batchId, source: 'bookmarkHtml', fileName: 'bookmarks.html', fileHash: null,
    destination: 'library', rows: input, arrangement: options });
}

it('保留真实路径片段，含斜杠的单层目录不会被误拆', () => {
  const parsed = parseBookmarkHtml('<DL><DT><H3>A / B</H3><DL><DT><A HREF="https://example.com">标题</A></DL></DL>');
  expect(parsed.entries[0]?.sourceFolderSegments).toEqual(['A / B']);
});

it('按完整父子结构新建分类，重复路径复用，不同父级同名分类独立', async () => {
  await commit(rows([['工作', '工具'], ['生活', '工具'], ['工作', '工具']]));
  const categories = await db.categories.toArray();
  expect(categories).toHaveLength(4);
  const tools = categories.filter((row) => row.name === '工具');
  expect(new Set(tools.map((row) => row.parentId)).size).toBe(2);
  const bookmarks = await repos.bookmarks.listActive();
  expect(bookmarks.find((row) => row.originalUrl === 'https://example.com/0')?.categoryId).toBe(bookmarks.find((row) => row.originalUrl === 'https://example.com/2')?.categoryId);
});

it('全重复导入不创建空组，组名冲突不会擅自混入已有组', async () => {
  await commit(rows([['工作']]));
  const duplicate = await commit(rows([['别的目录']]), arrangement('group'));
  expect(duplicate.inserted).toBe(0);
  expect((await db.categories.toArray()).some((row) => row.name === '独立导入')).toBe(false);
  const other = rows([['工具']]); other[0]!.originalUrl = other[0]!.canonicalUrl = 'https://example.com/new';
  await repos.categories.create('独立导入');
  await expect(commit(other, arrangement('group'))).rejects.toMatchObject({ code: 'DUPLICATE' });
  expect(await db.bookmarks.count()).toBe(1);
});

it('分类创建与收藏写入失败共同回滚', async () => {
  await expect(commit(rows([['正常'], ['过'.repeat(61)]]))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await db.categories.count()).toBe(0);
  expect(await db.bookmarks.count()).toBe(0);
  expect(await db.importBatches.count()).toBe(0);
});

it('暂存使用版本保护，部分加入只移除本次处理的条目', async () => {
  const draft: ImportDraft = { id: newId(), revision: 1, fileName: 'draft.html', fileHash: null,
    savedAt: nowIso(), rows: rows([['一'], ['二']]), arrangement: arrangement(), aiExcluded: [] };
  const saved = await repos.organization.saveDraft(draft);
  const updated = await repos.organization.saveDraft({ ...saved, fileName: '新名称' });
  await expect(repos.organization.saveDraft(saved)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const selected = updated.rows.map((row, index) => ({ ...row, selected: index === 0 }));
  await repos.imports.commit({ batchId: newId(), draftId: updated.id, draftRevision: updated.revision,
    source: 'bookmarkHtml', fileName: updated.fileName, fileHash: null, destination: 'library', rows: selected,
    arrangement: updated.arrangement });
  const remaining = (await repos.organization.drafts())[0]!;
  expect(remaining.rows.map((row) => row.sourceKey)).toEqual(['r1']);
  expect(remaining.revision).toBe(updated.revision + 1);
  expect(await db.bookmarks.count()).toBe(1);
});

it('撤回清理本批创建的空目录，清理快照可恢复原目录结构', async () => {
  const result = await commit(rows([['父', '子']]));
  await repos.imports.undoBatch(result.batch.id);
  expect(await db.categories.count()).toBe(0);
  expect(await db.bookmarks.count()).toBe(0);
  const snapshot = (await repos.purge.list())[0]!;
  await repos.purge.restore(snapshot.id);
  const child = (await db.categories.toArray()).find((row) => row.name === '子')!;
  expect(child.parentId).toBeTruthy();
  expect((await repos.bookmarks.listActive())[0]?.categoryId).toBe(child.id);
});

it('分类不能移动到后代，失败时层级与日志共同回滚', async () => {
  await commit(rows([['父', '子']]));
  const categories = await db.categories.toArray();
  const parent = categories.find((row) => row.name === '父')!;
  const child = categories.find((row) => row.name === '子')!;
  await expect(repos.organization.move({ items: [{ kind: 'category', id: parent.id, revision: parent.revision }], parentId: child.id, parentRevision: child.revision }))
    .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect((await db.categories.get(parent.id))?.parentId).toBeNull();
});

it('记录移动保留原始来源，撤销不覆盖之后的修改', async () => {
  await commit(rows([['原目录']]));
  const row = (await repos.bookmarks.listActive())[0]!;
  const target = await repos.categories.create('新目录');
  const move = await repos.organization.move({ items: [{ kind: 'bookmark', id: row.id, revision: row.localRevision }], parentId: target.id, parentRevision: target.revision });
  const moved = (await db.bookmarks.get(row.id))!;
  expect(moved.categoryId).toBe(target.id);
  expect(moved.sources).toEqual(row.sources);
  await repos.bookmarks.update(row.id, moved.localRevision, { note: '之后的修改' }, 'human');
  await expect(repos.organization.undo(move.operationId)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await db.bookmarks.get(row.id))?.note).toBe('之后的修改');
});

it('手动排序刷新后稳定，撤销恢复原位置', async () => {
  const first = await repos.bookmarks.create({ originalUrl: 'https://example.com/first', title: '一' });
  const second = await repos.bookmarks.create({ originalUrl: 'https://example.com/second', title: '二' });
  const moved = await repos.organization.move({ items: [{ kind: 'bookmark', id: second.id, revision: second.localRevision }], parentId: null, beforeId: first.id });
  expect((await db.bookmarks.get(second.id))!.sortOrder).toBeLessThan((await db.bookmarks.get(first.id))!.sortOrder!);
  await repos.organization.undo(moved.operationId);
  expect((await db.bookmarks.get(second.id))!.sortOrder).toBeGreaterThan((await db.bookmarks.get(first.id))!.sortOrder!);
});

it('旧版分类迁移为根级，迁移不删除原数据', async () => {
  const name = `old-${newId()}`;
  const old = new Dexie(name);
  old.version(4).stores({ categories: '&id, name', bookmarks: '&id, canonicalUrl' });
  await old.table('categories').add({ id: 'old', name: '原分类', description: '', revision: 1, createdAt: nowIso(), updatedAt: nowIso() });
  old.close();
  const upgraded = new ShiyeDB(name);
  try { expect((await upgraded.categories.get('old'))?.parentId).toBeNull(); }
  finally { await upgraded.delete(); }
});

it('同一暂存分两次加入同一新组，第二次继续复用本组', async () => {
  const input = rows([['甲'], ['乙']]);
  let draft = await repos.organization.saveDraft({ id: newId(), revision: 1, fileName: 'group.html', fileHash: null,
    savedAt: nowIso(), rows: input, arrangement: { ...arrangement('group'), paths: Object.fromEntries(input.map((row) => [row.sourceKey, row.sourceFolderSegments!])) }, aiExcluded: [] });
  const first = input.map((row, index) => ({ ...row, selected: index === 0 }));
  await repos.imports.commit({ batchId: newId(), draftId: draft.id, draftRevision: draft.revision,
    source: 'bookmarkHtml', fileName: draft.fileName, fileHash: null, destination: 'library', rows: first, arrangement: draft.arrangement });
  draft = (await repos.organization.drafts())[0]!;
  expect(draft.arrangement.groupCategoryId).toBeTruthy();
  await repos.imports.commit({ batchId: newId(), draftId: draft.id, draftRevision: draft.revision,
    source: 'bookmarkHtml', fileName: draft.fileName, fileHash: null, destination: 'library', rows: draft.rows, arrangement: draft.arrangement });
  expect((await db.categories.toArray()).filter((row) => row.name === '独立导入')).toHaveLength(1);
  expect(await db.bookmarks.count()).toBe(2);
  expect(await repos.organization.drafts()).toHaveLength(0);
});

it('最终提交重新规范化网址并尊重刚写入的墓碑', async () => {
  await repos.bookmarks.create({ originalUrl: 'https://example.com/0', title: '原有' });
  const forged = rows([['不应创建']]); forged[0]!.canonicalUrl = 'https://forged.example/';
  expect((await commit(forged)).inserted).toBe(0);
  expect(await db.categories.count()).toBe(0);
  const pending = rows([['不应创建']]); pending[0]!.originalUrl = 'https://example.com/deleted';
  await db.tombstones.put({ entityType: 'bookmark', id: newId(), revision: 1, changeVersion: null, deletedAt: nowIso(), privacyScope: 'main', canonicalUrl: 'https://example.com/deleted', title: '已删除' });
  expect((await commit(pending)).inserted).toBe(0);
  expect(await db.categories.count()).toBe(0);
});

it('备份恢复保留目录层级，合并同路径时引用指向复用分类', async () => {
  await commit(rows([['父', '子']]));
  const bundle = await repos.backup.exportDocument({ includeLocalOnly: true }).catch((cause) => { throw new Error(`EXPORT: ${cause}`); });
  // A foreign device has the same path with different IDs.
  const other = new ShiyeDB(`other-${newId()}`);
  const otherRepos = createRepositories(other);
  try {
    const parent = await otherRepos.categories.create('父');
    const restored = await otherRepos.backup.restore(bundle, 'merge').catch((cause) => { throw new Error(`RESTORE: ${cause}`); });
    expect(restored.bookmarksAdded).toBe(1);
    const child = (await other.categories.toArray()).find((row) => row.name === '子')!;
    expect(child.parentId).toBe(parent.id);
    expect((await otherRepos.bookmarks.listActive())[0]?.categoryId).toBe(child.id);
  } finally { await other.delete(); }
});

it('同名目录合并递归迁移收藏，撤销恢复各自目录与归属', async () => {
  await commit(rows([['原组', '同名', '共同子目录'], ['目标组', '同名', '共同子目录'], ['原组', '同名', '独有子目录']]));
  const all = await db.categories.toArray();
  const sourceRoot = all.find((row) => row.name === '原组')!;
  const targetRoot = all.find((row) => row.name === '目标组')!;
  const source = all.find((row) => row.name === '同名' && row.parentId === sourceRoot.id)!;
  const original = (await db.bookmarks.toArray()).map((row) => [row.id, row.categoryId]);
  const result = await repos.organization.move({ items: [{ kind: 'category', id: source.id, revision: source.revision }], parentId: targetRoot.id, parentRevision: targetRoot.revision, merge: true });
  expect(await db.categories.get(source.id)).toBeUndefined();
  expect(await db.bookmarks.count()).toBe(3);
  await repos.organization.undo(result.operationId);
  expect(await db.categories.get(source.id)).toBeTruthy();
  expect((await db.bookmarks.toArray()).map((row) => [row.id, row.categoryId])).toEqual(original);
});

it('旧数据具有相同排序值时仍可插入到指定记录之前', async () => {
  const first = await repos.bookmarks.create({ originalUrl: 'https://order.example/1', title: '一' });
  const second = await repos.bookmarks.create({ originalUrl: 'https://order.example/2', title: '二' });
  const third = await repos.bookmarks.create({ originalUrl: 'https://order.example/3', title: '三' });
  await db.bookmarks.update(first.id, { sortOrder: 0 }); await db.bookmarks.update(second.id, { sortOrder: 0 });
  const result = await repos.organization.move({ items: [{ kind: 'bookmark', id: third.id, revision: third.localRevision }], parentId: null, beforeId: first.id });
  expect(result.moved).toBe(1);
  expect((await db.bookmarks.get(third.id))!.sortOrder).toBeLessThan((await db.bookmarks.get(first.id))!.sortOrder!);
});

it('原文件根级的书签可直接入库并保持未分类', async () => {
  const result = await commit(rows([[], []]));
  expect(result.inserted).toBe(2);
  expect(await db.categories.count()).toBe(0);
  expect((await db.bookmarks.toArray()).every((row) => row.categoryId === null)).toBe(true);
});

it('用户移动过导入目录后，撤回导入保留目录下的收藏', async () => {
  const imported = await commit(rows([['导入目录', '子目录']]));
  const directory = (await db.categories.toArray()).find((row) => row.name === '导入目录')!;
  const target = await repos.categories.create('用户整理区');
  await repos.organization.move({ items: [{ kind: 'category', id: directory.id, revision: directory.revision }], parentId: target.id, parentRevision: target.revision });
  const preview = await repos.imports.previewUndoBatch(imported.batch.id);
  expect(preview.kept).toBe(1);
  expect(preview.removed).toBe(0);
  await repos.imports.undoBatch(imported.batch.id);
  expect(await db.bookmarks.count()).toBe(1);
});

it('898 条书签一次入库，分类按原目录复用，编号映射完整', async () => {
  const input = rows(Array.from({ length: 898 }, (_, index) => ['收藏夹栏', `分类${index % 64}`]));
  const result = await commit(input);
  expect(result.inserted).toBe(898);
  expect(await db.bookmarks.count()).toBe(898);
  expect(await db.categories.count()).toBe(65);
  expect(await db.importItems.count()).toBe(898);
});

it('一万条 HTML 完整解析、暂存、同目录入库并整批撤回，超限暂存拒绝', async () => {
  const html = `<DL><DT><H3>全部书签</H3><DL>${Array.from({ length: 10_000 }, (_, index) =>
    `<DT><A HREF="https://large.example/${index}">书签${index}</A>`).join('')}</DL></DL>`;
  const parsed = parseBookmarkHtml(html);
  expect(parsed.entries).toHaveLength(10_000);
  expect(parsed.warnings.some((warning) => warning.code === 'NODE_LIMIT')).toBe(false);
  const planned = planImport(parsed.entries, { destination: 'library', existingBookmarks: new Map(),
    pendingReadings: new Map(), tombstonedBookmarks: new Map() });
  const draft: ImportDraft = { id: newId(), revision: 1, fileName: 'large.html', fileHash: null,
    savedAt: nowIso(), rows: planned.rows, arrangement: arrangement(), aiExcluded: [] };
  await expect(repos.organization.saveDraft({ ...draft, rows: [...draft.rows,
    { ...draft.rows[0]!, sourceKey: 'overflow', line: LIMITS.importRows + 1 }] })).rejects.toThrow();
  const saved = await repos.organization.saveDraft(draft);
  expect((await repos.organization.drafts())[0]?.rows).toHaveLength(10_000);
  const result = await repos.imports.commit({ batchId: newId(), draftId: saved.id, draftRevision: saved.revision,
    source: 'bookmarkHtml', fileName: saved.fileName, fileHash: null, destination: 'library',
    rows: saved.rows, arrangement: saved.arrangement });
  expect(result.inserted).toBe(10_000);
  const stored = await db.bookmarks.toArray();
  expect(new Set(stored.map((row) => row.sortOrder)).size).toBe(10_000);
  expect(await db.importItems.count()).toBe(10_000);
  expect(await repos.organization.drafts()).toHaveLength(0);
  const undone = await repos.imports.undoBatch(result.batch.id);
  expect(undone.removed).toBe(10_000);
  expect(await db.bookmarks.count()).toBe(0);
  expect(await db.categories.count()).toBe(0);
  expect((await db.purgeSnapshots.toArray())[0]?.counts.bookmarks).toBe(10_000);
}, 60_000);
