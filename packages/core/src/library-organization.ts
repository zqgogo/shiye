import { z } from 'zod';
import { LIMITS } from './constants.js';
import type { Category, ImportRow } from './types.js';

export function categorySegments(categories: readonly Category[], id: string | null): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const category = categories.find((row) => row.id === id);
    if (!category) break;
    names.unshift(category.name);
    id = category.parentId ?? null;
  }
  return names;
}

export function categoryPath(categories: readonly Category[], id: string | null): string {
  return categorySegments(categories, id).join(' / ') || '未分类';
}

export function folderSegments(row: Pick<ImportRow, 'sourceFolder' | 'sourceFolderSegments'>): string[] {
  return row.sourceFolderSegments ?? (row.sourceFolder ? row.sourceFolder.split(' / ') : []);
}

export interface ImportArrangement {
  mode: 'original' | 'group' | 'manual';
  parentId: string | null;
  groupName: string;
  parentRevision?: number | undefined;
  categoryFingerprint?: string | undefined;
  groupCategoryId?: string | undefined;
  paths: Record<string, string[]>;
}

export interface ImportDraft {
  id: string;
  revision: number;
  fileName: string;
  fileHash: string | null;
  savedAt: string;
  rows: ImportRow[];
  arrangement: ImportArrangement;
  aiExcluded: string[];
  fixedKeys?: string[] | undefined;
}

const pathSchema = z.array(z.string().trim().min(1).max(LIMITS.categoryName)).max(LIMITS.importDepth);
export const ImportAiReplySchema = z.object({
  planId: z.string().uuid(),
  draftId: z.string(),
  revision: z.number().int().positive(),
  moves: z.array(z.object({ sourceKey: z.string(), path: pathSchema }).strict()).max(LIMITS.importRows),
}).strict();

export const ImportDraftSchema = z.object({
  id: z.string().min(1), revision: z.number().int().positive(), fileName: z.string().max(300),
  fileHash: z.string().nullable(), savedAt: z.string(),
  rows: z.array(z.object({
    sourceKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)), line: z.number().int().positive(), originalUrl: z.string().max(LIMITS.url),
    canonicalUrl: z.string().nullable(), title: z.string().max(LIMITS.title), sourceFolder: z.string(),
    sourceFolderSegments: z.array(z.string()).optional(), targetCategoryId: z.string().nullable(),
    status: z.enum(['new', 'duplicate', 'invalid', 'suspected']), reason: z.string(),
    selected: z.boolean(), duplicateOf: z.string().nullable(),
  }).strict()).max(LIMITS.importRows),
  arrangement: z.object({
    mode: z.enum(['original', 'group', 'manual']), parentId: z.string().nullable(), groupName: z.string(),
    parentRevision: z.number().optional(), categoryFingerprint: z.string().optional(), groupCategoryId: z.string().optional(), paths: z.record(z.array(z.string().min(1).max(1000)).max(LIMITS.importDepth)),
  }).strict(),
  aiExcluded: z.array(z.string()),
  fixedKeys: z.array(z.string()).optional(),
}).strict().superRefine((draft, context) => {
  const keys = new Set(draft.rows.map((row) => row.sourceKey));
  if (keys.size !== draft.rows.length) context.addIssue({ code: z.ZodIssueCode.custom, message: '暂存包含重复的记录编号。' });
  if (Object.keys(draft.arrangement.paths).some((key) => !keys.has(key))) context.addIssue({ code: z.ZodIssueCode.custom, message: '目录方案引用了暂存范围外的记录。' });
});

export type OrganizationTarget =
  | { kind: 'category'; id: string; revision: number }
  | { kind: 'bookmark'; id: string; revision: number };

export interface OrganizationMove {
  merge?: boolean;
  categoryFingerprint?: string;
  items: OrganizationTarget[];
  parentId: string | null;
  parentRevision?: number | undefined;
  beforeId?: string;
  afterId?: string;
  anchorRevision?: number;
}

export interface OrganizationResult { operationId: string; moved: number; }

export interface OrganizationRepository {
  drafts(): Promise<ImportDraft[]>;
  draftRevision(id: string): Promise<number | null>;
  saveDraft(draft: ImportDraft): Promise<ImportDraft>;
  removeDraft(id: string, revision: number): Promise<void>;
  move(input: OrganizationMove): Promise<OrganizationResult>;
  undo(operationId: string): Promise<void>;
}

export function categoryFingerprint(categories: readonly Category[]): string {
  return JSON.stringify([...categories].sort((a, b) => a.id.localeCompare(b.id)).map((row) => [row.id, row.parentId ?? null, row.name, row.revision]));
}

export function previewImportCategories(categories: readonly Category[], rows: ImportRow[], arrangement: ImportArrangement) {
  const planned = new Map(categories.map((row) => [JSON.stringify([row.parentId ?? null, row.name]), row]));
  const created = new Set<string>();
  const reused = new Set<string>();
  for (const row of rows.filter((item) => item.selected && item.status === 'new')) {
    if (arrangement.mode === 'manual') {
      if (row.targetCategoryId) reused.add(row.targetCategoryId);
      continue;
    }
    const path = arrangement.paths[row.sourceKey] ?? folderSegments(row);
    const names = arrangement.mode === 'group' ? [arrangement.groupName, ...path] : path;
    let parentId = arrangement.parentId;
    for (const name of names) {
      if (!name.trim() || name.trim().length > LIMITS.categoryName) throw new Error('目录名需为 1–60 字，请调整过长或空白的目录名。');
      const key = JSON.stringify([parentId, name.trim()]);
      const existing = planned.get(key);
      if (existing) {
        if (arrangement.mode === 'group' && parentId === arrangement.parentId && !created.has(existing.id) && existing.id !== arrangement.groupCategoryId) {
          throw new Error('新分类组名称已存在，请更改名称或选择合并到现有目录。');
        }
        if (!created.has(existing.id)) reused.add(existing.id);
        parentId = existing.id;
      } else {
        const id = `planned-${created.size}`;
        planned.set(key, { id, name: name.trim(), parentId, revision: 1, description: '', createdAt: '', updatedAt: '' });
        created.add(id);
        parentId = id;
      }
    }
  }
  return { created: created.size, reused: reused.size };
}
