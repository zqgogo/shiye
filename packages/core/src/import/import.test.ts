import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBookmarkHtml, parsePasteInput, planImport } from '../index.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), 'utf8');

describe('parseBookmarkHtml', () => {
  it('按 DL/DT/H3 解析多层目录、实体与标题', () => {
    const result = parseBookmarkHtml(fixture('bookmarks-chrome.html'));
    expect(result.entries).toHaveLength(12);
    const first = result.entries[0];
    expect(first?.title).toBe('UIKit 交互与界面文档');
    expect(first?.sourceFolder).toBe('书签栏');

    const nested = result.entries.find((entry) => entry.title === '阅读器分页与排版笔记');
    expect(nested?.sourceFolder).toBe('书签栏 / 开发 / 前端');
    expect(nested?.originalUrl).toBe('https://example.com/reading/pagination?a=1&b=2#part-2');

    const escaped = result.entries.find((entry) => entry.originalUrl.includes('/safe?x=1'));
    expect(escaped?.title).toBe('标题里的 <script>alert(1)</script> 需要转义');

    const sibling = result.entries.filter((entry) => entry.title === '相同标题');
    expect(sibling).toHaveLength(2);
    expect(sibling[0]?.originalUrl).not.toBe(sibling[1]?.originalUrl);
  });

  it('脚本与样式内容不会被当成书签解析', () => {
    const result = parseBookmarkHtml(fixture('bookmarks-chrome.html'));
    expect(result.entries.some((entry) => entry.originalUrl.includes('evil.example'))).toBe(false);
  });

  it('损坏结构仍能读出可辨认的链接且不抛异常', () => {
    const result = parseBookmarkHtml(fixture('bookmarks-malformed.html'));
    const urls = result.entries.map((entry) => entry.originalUrl);
    expect(urls).toContain('https://example.org/unclosed');
    expect(urls).toContain('https://example.org/single-quote');
    expect(urls).toContain('https://example.org/after-broken');
    expect(urls).toContain('https://example.org/attrs?a=1'); // 属性里的 > 不能截断标签
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('空文件与非书签文件给出明确警告', () => {
    expect(parseBookmarkHtml('   ').warnings[0]?.code).toBe('EMPTY');
    expect(parseBookmarkHtml('<html><body>没有书签</body></html>').warnings[0]?.code).toBe('NO_LINKS');
  });
});

describe('planImport（I01）', () => {
  const entries = parsePasteInput(
    ['https://example.com/a', 'https://example.com/a', 'javascript:alert(1)', 'https://example.com/b'].join('\n')
  ).entries;

  it('逐行标记新、重复、无效并默认只勾选可新增', () => {
    const plan = planImport(entries, {
      destination: 'library',
      existingBookmarks: new Map([['https://example.com/b', { id: 'b1', title: '已有收藏' }]]),
      pendingReadings: new Map(),
      tombstonedBookmarks: new Map(),
    });
    expect(plan.rows.map((row) => row.status)).toEqual(['new', 'duplicate', 'invalid', 'duplicate']);
    expect(plan.rows.map((row) => row.selected)).toEqual([true, false, false, false]);
    expect(plan.stats).toMatchObject({ total: 4, newCount: 1, duplicate: 2, invalid: 1, selected: 1 });
    expect(plan.rows[1]?.reason).toContain('本次输入重复');
    expect(plan.rows[3]?.reason).toContain('已有收藏');
  });

  it('切换目标后重新去重：待看按队列判重，收藏按库判重', () => {
    const plan = planImport(entries.slice(0, 1), {
      destination: 'reading',
      existingBookmarks: new Map([['https://example.com/a', { id: 'b1', title: '已有' }]]),
      pendingReadings: new Map(),
      tombstonedBookmarks: new Map(),
    });
    expect(plan.rows[0]?.status).toBe('new');
    expect(plan.rows[0]?.reason).toContain('已在收藏库');

    const pendingPlan = planImport(entries.slice(0, 1), {
      destination: 'reading',
      existingBookmarks: new Map(),
      pendingReadings: new Map([['https://example.com/a', { id: 'w1' }]]),
      tombstonedBookmarks: new Map(),
    });
    expect(pendingPlan.rows[0]?.status).toBe('duplicate');
  });

  it('墓碑阻止普通导入悄悄复活', () => {
    const plan = planImport(entries.slice(0, 1), {
      destination: 'library',
      existingBookmarks: new Map(),
      pendingReadings: new Map(),
      tombstonedBookmarks: new Map([['https://example.com/a', { id: 'dead' }]]),
    });
    expect(plan.rows[0]?.status).toBe('suspected');
    expect(plan.rows[0]?.selected).toBe(false);
  });
});
