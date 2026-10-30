import type { ImportDestination, ImportRow, ParsedImportEntry } from '../types.js';
import { fallbackTitle } from '../text.js';
import { tryCanonicalizeUrl, canonicalizeUrl } from '../url.js';
import { isAppError } from '../errors.js';

export interface ImportPlanContext {
  destination: ImportDestination;
  /** canonicalUrl → 现有收藏摘要 */
  existingBookmarks: ReadonlyMap<string, { id: string; title: string }>;
  /** canonicalUrl → 活动待看（仅 pending） */
  pendingReadings: ReadonlyMap<string, { id: string }>;
  /** canonicalUrl → 已删除收藏（墓碑） */
  tombstonedBookmarks: ReadonlyMap<string, { id: string }>;
  /** 原目录 → 目标分类；未提供按未分类处理 */
  folderMapping?: ReadonlyMap<string, string | null>;
}

export interface ImportPlanStats {
  total: number;
  newCount: number;
  duplicate: number;
  invalid: number;
  suspected: number;
  selected: number;
}

export interface ImportPlan {
  rows: ImportRow[];
  stats: ImportPlanStats;
}

/**
 * 按目标重新计算每一行的状态。切换目标必须重新调用，
 * 不能被「已经算过一次」的缓存复用。
 */
export function planImport(entries: ParsedImportEntry[], ctx: ImportPlanContext): ImportPlan {
  const rows: ImportRow[] = [];
  const seen = new Map<string, ParsedImportEntry>();

  for (const entry of entries) {
    const checked = tryCanonicalizeUrl(entry.originalUrl);
    const base: ImportRow = {
      sourceKey: entry.sourceKey,
      line: entry.line,
      originalUrl: entry.originalUrl,
      canonicalUrl: checked ? checked.canonicalUrl : null,
      title: entry.title.trim() || (checked ? fallbackTitle(checked.originalUrl) : ''),
      sourceFolder: entry.sourceFolder,
      targetCategoryId: ctx.folderMapping?.get(entry.sourceFolder) ?? null,
      status: 'new',
      reason: '可保存',
      selected: true,
      duplicateOf: null,
    };

    if (!checked) {
      rows.push({
        ...base,
        status: 'invalid',
        selected: false,
        reason: invalidReason(entry.originalUrl),
      });
      continue;
    }

    if (entry.title.trim().length === 0) {
      base.reason = '标题未提取，已使用域名占位';
    }

    const previous = seen.get(checked.canonicalUrl);
    if (previous) {
      rows.push({
        ...base,
        status: 'duplicate',
        selected: false,
        duplicateOf: previous.sourceKey,
        reason: `本次输入重复，保留第 ${previous.line} 行的第一条`,
      });
      continue;
    }
    seen.set(checked.canonicalUrl, entry);

    const tombstone = ctx.tombstonedBookmarks.get(checked.canonicalUrl);
    if (ctx.destination === 'library' && tombstone) {
      rows.push({
        ...base,
        status: 'suspected',
        selected: false,
        reason: '该网址存在已删除的收藏，需要在回收站明确恢复或单独新建',
      });
      continue;
    }

    if (ctx.destination === 'reading') {
      if (ctx.pendingReadings.has(checked.canonicalUrl)) {
        rows.push({
          ...base,
          status: 'duplicate',
          selected: false,
          reason: '已经在待看列表中',
        });
        continue;
      }
      if (ctx.existingBookmarks.has(checked.canonicalUrl)) {
        base.reason = '已在收藏库，仍可单独加入待看（不会改变原收藏）';
      }
      rows.push(base);
      continue;
    }

    const existing = ctx.existingBookmarks.get(checked.canonicalUrl);
    if (existing) {
      rows.push({
        ...base,
        status: 'duplicate',
        selected: false,
        reason: `已经收藏为「${existing.title}」`,
      });
      continue;
    }
    if (ctx.pendingReadings.has(checked.canonicalUrl)) {
      base.reason = '已在待看，仍可保存为收藏；不会自动完成待看';
    }
    rows.push(base);
  }

  return { rows, stats: computeStats(rows) };
}

function invalidReason(url: string): string {
  try {
    canonicalizeUrl(url);
    return '不是有效的 HTTP / HTTPS 链接';
  } catch (error) {
    return isAppError(error) ? error.message : '不是有效的 HTTP / HTTPS 链接';
  }
}

export function computeStats(rows: ImportRow[]): ImportPlanStats {
  return {
    total: rows.length,
    newCount: rows.filter((row) => row.status === 'new').length,
    duplicate: rows.filter((row) => row.status === 'duplicate').length,
    invalid: rows.filter((row) => row.status === 'invalid').length,
    suspected: rows.filter((row) => row.status === 'suspected').length,
    selected: rows.filter((row) => row.selected && row.status === 'new').length,
  };
}

export function selectAllNew(rows: ImportRow[]): ImportRow[] {
  return rows.map((row) => ({ ...row, selected: row.status === 'new' }));
}

export function clearSelection(rows: ImportRow[]): ImportRow[] {
  return rows.map((row) => ({ ...row, selected: false }));
}

export function toggleRow(rows: ImportRow[], sourceKey: string, selected: boolean): ImportRow[] {
  return rows.map((row) =>
    row.sourceKey === sourceKey && row.status === 'new' ? { ...row, selected } : row
  );
}

export function foldersOf(rows: ImportRow[]): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== 'new') continue;
    counts.set(row.sourceFolder, (counts.get(row.sourceFolder) ?? 0) + 1);
  }
  return [...counts.entries()].map(([folder, count]) => ({ folder, count }));
}
