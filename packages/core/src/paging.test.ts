import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  normalizePageSize,
  paginate,
} from './paging.js';

const rows = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe('列表分页', () => {
  it('默认一页 50 条，可选 20 / 50 / 100', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
    expect([...PAGE_SIZE_OPTIONS]).toEqual([20, 50, 100]);
  });

  it('第一页交出前 50 条，并写明序号范围', () => {
    const view = paginate(rows(180), 1, 50);
    expect(view.rows).toHaveLength(50);
    expect(view.rows[0]).toBe(1);
    expect(view.rows[49]).toBe(50);
    expect(view.page).toBe(1);
    expect(view.pageCount).toBe(4);
    expect([view.from, view.to, view.total]).toEqual([1, 50, 180]);
  });

  it('最后一页只交出剩下的零头', () => {
    const view = paginate(rows(180), 4, 50);
    expect(view.rows).toHaveLength(30);
    expect(view.rows[0]).toBe(151);
    expect([view.from, view.to]).toEqual([151, 180]);
  });

  it('整除时不会多出一页空页', () => {
    const view = paginate(rows(100), 2, 50);
    expect(view.pageCount).toBe(2);
    expect([view.from, view.to]).toEqual([51, 100]);
  });

  it('空列表仍是第 1 / 1 页，序号从 0 起', () => {
    const view = paginate([], 3, 50);
    expect(view).toMatchObject({ rows: [], page: 1, pageCount: 1, from: 0, to: 0, total: 0 });
  });

  it('页码越界时钳到最近的合法页，而不是给空列表', () => {
    // 删掉最后一页的最后几条后，调用方还停在第 4 页是常见的。
    const shrunk = paginate(rows(30), 4, 50);
    expect(shrunk.page).toBe(1);
    expect(shrunk.rows).toHaveLength(30);

    expect(paginate(rows(180), 99, 50).page).toBe(4);
    expect(paginate(rows(180), 0, 50).page).toBe(1);
    expect(paginate(rows(180), -3, 50).page).toBe(1);
    expect(paginate(rows(180), Number.NaN, 50).page).toBe(1);
  });

  it('页大小不合法时回落到默认值，避免整页变空', () => {
    expect(normalizePageSize(30)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize('50')).toBe(50);
    expect(normalizePageSize(100)).toBe(100);
    expect(normalizePageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(-10)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePageSize('abc')).toBe(DEFAULT_PAGE_SIZE);

    const view = paginate(rows(10), 1, 7);
    expect(view.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(view.rows).toHaveLength(10);
  });

  it('翻页拼起来不重不漏', () => {
    const all = rows(137);
    const seen: number[] = [];
    for (let page = 1; page <= paginate(all, 1, 20).pageCount; page += 1) {
      seen.push(...paginate(all, page, 20).rows);
    }
    expect(seen).toEqual(all);
  });
});
