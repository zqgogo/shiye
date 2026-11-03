/**
 * 列表分页。
 *
 * 之前所有列表都是一口气全渲染，条数一多就得一直往下滚：找不到位置、
 * 不知道自己看到第几条、勾选和删除时也没有「这一页」的概念。这里把切片
 * 逻辑抽成纯函数，界面只负责把当前页交出去——页码钳制、空列表的边界都
 * 在这一个地方算清楚，避免每个页面各写一遍 `slice()` 各差一条。
 */

/** 每页条数的可选范围：20–50。太小翻页太勤，太大又回到「一直往下滚」。 */
export const MIN_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** 设置页与分页条共用的快捷档位；中间值（如 33）也能存，只是不出现在下拉里。 */
export const PAGE_SIZE_OPTIONS = [20, 25, 30, 35, 40, 45, 50] as const;

/** 默认一页 50 条：一屏能扫完，又不至于翻页太勤。 */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * 把下拉/输入里的值收敛成合法页大小。
 *
 * 限制在 20–50 之间：旧版本存下的 100、手输的 0 或负数、被改坏的 select，
 * 都收敛到区间内，而不是让 `slice(0, NaN)` 把整个列表变成空。
 * 非数字回落默认值 50；小数四舍五入（30.4 → 30）。
 */
export function normalizePageSize(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.round(parsed)));
}

export interface PageView<T> {
  /** 当前页的条目。 */
  rows: T[];
  /** 钳制后的页码，1 起；总数为 0 时仍是 1，页面不会出现「第 0 / 0 页」。 */
  page: number;
  pageCount: number;
  pageSize: number;
  /** 当前页第一条在整个列表里的序号（1 起）；空列表为 0。 */
  from: number;
  /** 当前页最后一条的序号（1 起）；空列表为 0。 */
  to: number;
  total: number;
}

/**
 * 取某一页。
 *
 * 页码越界不报错而是钳到最近的合法页：删掉最后一页的最后几条之后，
 * 调用方还在第 3 页是很正常的，界面应该退到第 2 页而不是显示空白列表。
 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): PageView<T> {
  const size = normalizePageSize(pageSize);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), pageCount) : 1;
  const start = (safePage - 1) * size;
  const rows = items.slice(start, start + size);

  return {
    rows,
    page: safePage,
    pageCount,
    pageSize: size,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + rows.length,
    total,
  };
}
