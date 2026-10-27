import type { AIField, Bookmark, LockableField, Privacy } from './types.js';

export const DEFAULT_PRIVACY: Privacy = { localOnly: false, aiBlocked: false };

export type AiExclusion = 'deleted' | 'localOnly' | 'aiBlocked';

/** 两条 AI 通道共用：localOnly 与 aiBlocked 一律排除，删除项不参与。 */
export function aiExclusionReason(bookmark: Pick<Bookmark, 'deletedAt' | 'privacy'>): AiExclusion | null {
  if (bookmark.deletedAt) return 'deleted';
  if (bookmark.privacy.localOnly) return 'localOnly';
  if (bookmark.privacy.aiBlocked) return 'aiBlocked';
  return null;
}

export function isAiEligible(bookmark: Pick<Bookmark, 'deletedAt' | 'privacy'>): boolean {
  return aiExclusionReason(bookmark) === null;
}

export function aiExclusionText(reason: AiExclusion): string {
  switch (reason) {
    case 'deleted':
      return '条目已删除';
    case 'localOnly':
      return '本地专用，不发送 AI';
    case 'aiBlocked':
      return '已禁止发送 AI';
  }
}

/** 手机快照默认排除 localOnly 与删除项；aiBlocked 不等于禁止用户普通导出。 */
export function isSnapshotEligible(bookmark: Pick<Bookmark, 'deletedAt' | 'privacy'>): boolean {
  return !bookmark.deletedAt && !bookmark.privacy.localOnly;
}

/**
 * 字段写入授权。Partial 不是授权：来源决定可写字段集合，
 * AI 只能写白名单且不能覆盖人工锁定字段。
 */
export function canWriteField(field: AIField, source: 'human' | 'ai', lockedFields: LockableField[]): boolean {
  if (source === 'human') return true;
  return !lockedFields.includes(field);
}

const AI_FIELD_SET = new Set<string>(['categoryId', 'tagIds', 'aiPurpose']);

export function isAIField(field: string): field is AIField {
  return AI_FIELD_SET.has(field);
}
