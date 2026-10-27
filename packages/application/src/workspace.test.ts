import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@shiye/core';
import { ShiyeDB } from '@shiye/storage';
import { createRepositories } from '@shiye/storage';
import { createWorkspaceService, type WorkspaceService } from './workspace.js';
import type { Repositories } from './ports.js';

let db: ShiyeDB;
let repos: Repositories;
let service: WorkspaceService;
let counter = 0;

beforeEach(() => {
  db = new ShiyeDB(`shiye-app-${Date.now()}-${counter += 1}`);
  repos = createRepositories(db);
  service = createWorkspaceService(repos);
});

afterEach(async () => {
  const name = db.name;
  db.close();
  await Dexie.delete(name);
});

async function seed(count: number) {
  for (let index = 0; index < count; index += 1) {
    await repos.bookmarks.create({
      originalUrl: `https://example.com/item-${index}?page=${index}`,
      title: index === 7 ? '阅读器分页与排版笔记' : `示例资料 ${index}`,
      sourceDescription: index === 7 ? '字体变化后的分页重排与阅读进度' : '普通描述',
    });
  }
}

describe('本地搜索', () => {
  it('500 条收藏下中文召回、标签与分类名可检索', async () => {
    await seed(500);
    const category = await repos.categories.create('排版设计');
    const tag = await repos.tags.create('分页');
    const bookmarks = await db.bookmarks.toArray();
    const target = bookmarks.find((bookmark) => bookmark.title.includes('分页'));
    expect(target).toBeTruthy();
    await repos.bookmarks.update(target!.id, target!.localRevision, { categoryId: category.id, tagIds: [tag.id] }, 'human');

    const byTitle = await service.search('分页');
    expect(byTitle.some((hit) => hit.bookmarkId === target!.id)).toBe(true);

    const byTag = await service.search('分页');
    expect(byTag.length).toBeGreaterThan(0);

    const byCategory = await service.search('排版设计');
    expect(byCategory.some((hit) => hit.bookmarkId === target!.id)).toBe(true);

    const byUrl = await service.search('item-499');
    expect(byUrl.length).toBe(1);

    expect(await service.search('   ')).toEqual([]);
  });
});

describe('提问资料与 AI 回复校验', () => {
  it('提问包排除隐私条目并给出明确上限', async () => {
    const visible = await repos.bookmarks.create({ originalUrl: 'https://example.com/v', title: '可见' });
    const hidden = await repos.bookmarks.create({
      originalUrl: 'https://example.com/h',
      title: '私密',
      privacy: { localOnly: true },
    });
    const pack = await service.buildAskPack({
      question: '这些资料讲了什么？',
      bookmarkIds: [visible.id, hidden.id],
    });
    expect(pack.items.map((item) => item.id)).toEqual([visible.id]);
    expect(pack.text).toContain('可见');
    expect(pack.text).not.toContain('私密');
  });

  it('逐项校验：未知字段、未知编号、锁定字段分别拒绝，合法项可应用', async () => {
    const a = await repos.bookmarks.create({ originalUrl: 'https://example.com/a', title: 'A 资料' });
    const b = await repos.bookmarks.create({ originalUrl: 'https://example.com/b', title: 'B 资料' });
    await repos.bookmarks.create({ originalUrl: 'https://example.com/c', title: 'C 资料' });
    await repos.bookmarks.update(b.id, b.localRevision, { lockedFields: ['categoryId'] }, 'human');
    const category = await repos.categories.create('开发');

    const pack = await service.buildOrganizePack({ scope: 'all', selectedIds: [] });
    const nOf = (title: string): number =>
      pack.items.find((item) => item.bookmark.title === title)?.n ?? 0;
    const reply = {
      protocolVersion: 2,
      batchId: pack.batchId,
      part: 1,
      results: [
        {
          n: nOf('A 资料'),
          domain: 'example.com',
          titleEcho: 'A 资料',
          patch: { categoryId: category.id, tagIds: [], aiPurpose: '用于核对 A' },
          reason: '匹配',
          status: 'ok',
        },
        {
          n: nOf('B 资料'),
          domain: 'example.com',
          titleEcho: 'B 资料',
          patch: { categoryId: category.id, tagIds: [], aiPurpose: '用于核对 B' },
          reason: '匹配',
          status: 'ok',
        },
        {
          n: nOf('C 资料'),
          domain: 'example.com',
          titleEcho: 'C 资料',
          patch: { inboxUnread: false, categoryId: category.id },
          reason: '越权',
          status: 'ok',
        },
        {
          n: 99,
          domain: 'example.com',
          titleEcho: '不存在的条目',
          patch: { categoryId: category.id },
          reason: '编号错误',
          status: 'ok',
        },
      ],
    };

    const checked = await service.validateAiReply({
      text: JSON.stringify(reply),
      batchId: pack.batchId,
      items: pack.items,
      policyVersion: pack.policyVersion,
    });

    expect(checked.applied).toHaveLength(1);
    expect(checked.applied[0]?.bookmark.title).toBe('A 资料');
    const reasons = checked.rejected.map((item) => `${item.n}:${item.reason}`).join(' | ');
    expect(reasons).toContain('分类已被人工锁定');
    expect(reasons).toContain('字段不合法');
    expect(reasons).toContain('未知编号');
  });

  it('批次或策略变化后旧回复被拒绝', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/x', title: 'X' });
    const pack = await service.buildOrganizePack({ scope: 'all', selectedIds: [] });
    await service.updatePolicy('新的整理策略');
    await expect(
      service.validateAiReply({
        text: JSON.stringify({ protocolVersion: 2, batchId: pack.batchId, part: 1, results: [] }),
        batchId: pack.batchId,
        items: pack.items,
        policyVersion: pack.policyVersion,
      })
    ).rejects.toMatchObject({ code: 'STALE_SUGGESTION' });

    await expect(
      service.validateAiReply({
        text: JSON.stringify({ protocolVersion: 2, batchId: 'other', part: 1, results: [] }),
        batchId: pack.batchId,
        items: pack.items,
        policyVersion: (await repos.settings.getPolicy()).policyVersion,
      })
    ).rejects.toMatchObject({ code: 'INVALID_AI_REPLY' });
  });

  it('恶意回复（未知字段/脚本字符串）不会被执行或静默应用', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/m', title: 'M' });
    const pack = await service.buildOrganizePack({ scope: 'all', selectedIds: [] });
    const text = `\`\`\`json
${JSON.stringify({
  protocolVersion: 2,
  batchId: pack.batchId,
  part: 1,
  results: [
    {
      n: 1,
      domain: 'example.com',
      titleEcho: 'M',
      patch: { aiPurpose: '<img src=x onerror=alert(1)>' },
      reason: 'ok',
      status: 'ok',
    },
  ],
})}
\`\`\``;
    const checked = await service.validateAiReply({
      text,
      batchId: pack.batchId,
      items: pack.items,
      policyVersion: pack.policyVersion,
    });
    // 字符串本身允许，但只作为纯文本保存；应用时必须由界面转义，不能当 HTML 执行。
    expect(checked.applied).toHaveLength(1);
    expect(checked.applied[0]?.patch.aiPurpose).toContain('<img');
  });
});

describe('手机只读快照', () => {
  it('排除本地专用与已删除条目，转义标题并限制链接协议', async () => {
    await repos.bookmarks.create({
      originalUrl: 'https://example.com/ok',
      title: '<script>alert(1)</script> 标题',
      note: '内部备注',
      selectedText: '选中文字',
    });
    await repos.bookmarks.create({
      originalUrl: 'https://example.com/private',
      title: '私密条目',
      privacy: { localOnly: true },
    });
    const deleted = await repos.bookmarks.create({ originalUrl: 'https://example.com/gone', title: '已删除' });
    await repos.bookmarks.softDelete(deleted.id);

    const snapshot = await service.exportSnapshot({ includeNote: false, includeText: false });
    expect(snapshot.html).not.toContain('私密条目');
    expect(snapshot.html).not.toContain('已删除');
    expect(snapshot.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(snapshot.html).not.toContain('内部备注');
    expect(snapshot.html).toContain('https://example.com/ok');
    expect(snapshot.html).toContain('不自动同步');

    const withNote = await service.exportSnapshot({ includeNote: true, includeText: true });
    expect(withNote.html).toContain('内部备注');
    expect(withNote.html).toContain('选中文字');
  });
});

describe('备份编排', () => {
  it('替换恢复前先导出安全备份，恢复后数据一致', async () => {
    await repos.categories.create('开发');
    await repos.bookmarks.create({ originalUrl: 'https://example.com/keep', title: '保留' });
    await repos.reading.add({ originalUrl: 'https://example.com/queue', title: '待看' });
    const exported = await service.exportBackup(true);
    expect(exported.text).not.toMatch(/bearer|apiKey/i);

    await repos.bookmarks.create({ originalUrl: 'https://example.com/temp', title: '临时' });
    const restored = await service.restoreBackup(exported.text, 'replace');
    expect(restored.safety).not.toBeNull();
    expect(restored.safety?.document.bookmarks).toHaveLength(2);
    expect(restored.result.bookmarksAdded).toBe(1);
    const active = await repos.bookmarks.listActive();
    expect(active.map((bookmark) => bookmark.title)).toEqual(['保留']);
    expect((await repos.reading.listPending())).toHaveLength(1);
  });

  it('拒绝未知的新版本备份', async () => {
    const exported = await service.exportBackup(true);
    const document = JSON.parse(exported.text) as Record<string, unknown>;
    document['schemaVersion'] = 99;
    await expect(service.restoreBackup(JSON.stringify(document), 'merge')).rejects.toBeInstanceOf(AppError);
  });
});

describe('导入预览编排', () => {
  it('粘贴预览逐行给出状态，切换目标重新计算', async () => {
    await repos.bookmarks.create({ originalUrl: 'https://example.com/existing', title: '已存在' });
    const preview = await service.previewImport({
      mode: 'paste',
      text: 'https://example.com/new\nhttps://example.com/existing\nnot-a-url',
      destination: 'library',
    });
    expect(preview.plan.stats).toMatchObject({ total: 3, newCount: 1, duplicate: 1, invalid: 1 });

    const asReading = await service.previewImport({
      mode: 'paste',
      text: 'https://example.com/new\nhttps://example.com/existing\nnot-a-url',
      destination: 'reading',
    });
    expect(asReading.plan.stats.newCount).toBe(2);
    expect(asReading.plan.rows[1]?.reason).toContain('仍可单独加入待看');
  });

  it('书签 HTML 预览保留目录并逐行去重', async () => {
    const fs = await import('node:fs');
    const html = fs.readFileSync(new URL('../../../fixtures/bookmarks-chrome.html', import.meta.url), 'utf8');
    await repos.bookmarks.create({ originalUrl: 'https://example.org/tools/gojs', title: '已有 GoJS' });
    const preview = await service.previewImport({
      mode: 'bookmarkHtml',
      text: html,
      fileName: 'bookmarks.html',
      destination: 'library',
    });
    expect(preview.plan.stats.total).toBe(12);
    expect(preview.plan.stats.invalid).toBe(2); // javascript: 与 chrome://
    expect(preview.plan.stats.duplicate).toBe(2); // 输入内重复 + 已有收藏
    expect(preview.plan.rows.some((row) => row.sourceFolder === '书签栏 / 开发 / 前端')).toBe(true);
  });
});
