/**
 * 全局字段与容量限制。所有表单一律从这里取值，不散落到组件。
 * 数值来自产品与技术实现说明 v2.1 第 16、6 节。
 */
export const LIMITS = {
  title: 300,
  url: 8192,
  sourceDescription: 4000,
  aiPurpose: 4000,
  note: 20000,
  selectedText: 4000,
  tagsPerBookmark: 30,
  pinnedCategories: 8,
  recentOpened: 15,
  categoryName: 60,
  categoryDescription: 200,
  tagName: 40,
  importFileBytes: 3 * 1024 * 1024,
  importRows: 1000,
  importDepth: 32,
  importNodes: 20000,
  importWarningChars: 4000,
  aiReplyChars: 300_000,
  aiItemsPerPart: 20,
  questionChars: 4000,
  aiPurposeSuggestion: 2000,
} as const;

/** 软删除后允许正文清理的最早天数（首版不自动清理）。 */
export const TRASH_RETENTION_DAYS = 30;

export const DELETED_CATEGORY_KEY = 'uncategorized';

export const SCHEMA_VERSION = 2;
export const AI_PROTOCOL_VERSION = 2;
