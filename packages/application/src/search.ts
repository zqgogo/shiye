import MiniSearch, { type SearchResult } from 'minisearch';
import type { Bookmark, Category, Tag } from '@shiye/core';

/** 中文召回：按字 + 双字切分，拉丁词按空白与标点切分。 */
export function tokenizeForSearch(text: string): string[] {
  const normalized = text.toLowerCase();
  const segments = normalized.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  const tokens: string[] = [];
  for (const segment of segments) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(segment)) {
      const chars = [...segment];
      for (let i = 0; i < chars.length; i += 1) {
        tokens.push(chars[i] as string);
        if (i + 1 < chars.length) tokens.push(`${chars[i]}${chars[i + 1]}`);
      }
    } else {
      tokens.push(segment);
    }
  }
  return tokens;
}

export interface SearchDoc {
  id: string;
  title: string;
  url: string;
  description: string;
  aiPurpose: string;
  note: string;
  selectedText: string;
  categoryName: string;
  tagNames: string;
}

export interface SearchHit {
  bookmarkId: string;
  score: number;
}

export class LocalSearchIndex {
  private index: MiniSearch<SearchDoc> | null = null;
  private fingerprint = '';

  constructor(
    private readonly bookmarks: Bookmark[],
    private readonly categories: Category[],
    private readonly tags: Tag[]
  ) {}

  private build(): MiniSearch<SearchDoc> {
    const index = new MiniSearch<SearchDoc>({
      fields: ['title', 'url', 'description', 'aiPurpose', 'note', 'selectedText', 'categoryName', 'tagNames'],
      storeFields: ['id'],
      tokenize: tokenizeForSearch,
      searchOptions: {
        prefix: true,
        fuzzy: 0.1,
        combineWith: 'AND',
        boost: { title: 3, tagNames: 2, categoryName: 2 },
      },
    });
    const categoryName = new Map(this.categories.map((c) => [c.id, c.name]));
    const tagName = new Map(this.tags.map((t) => [t.id, t.name]));
    index.addAll(
      this.bookmarks.map((bookmark) => ({
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.originalUrl,
        description: bookmark.sourceDescription,
        aiPurpose: bookmark.aiPurpose,
        note: bookmark.note,
        selectedText: bookmark.selectedText,
        categoryName: bookmark.categoryId ? categoryName.get(bookmark.categoryId) ?? '' : '',
        tagNames: bookmark.tagIds.map((id) => tagName.get(id) ?? '').join(' '),
      }))
    );
    return index;
  }

  search(query: string): SearchHit[] {
    const term = query.trim();
    if (!term) return [];
    if (!this.index) this.index = this.build();
    const results: SearchResult[] = this.index.search(term);
    return results.map((result) => ({ bookmarkId: String(result.id), score: result.score }));
  }

  /** 数据变化后显式重建；索引不是主数据，可随时重建。 */
  rebuild(): void {
    this.index = this.build();
    this.fingerprint = String(Date.now());
  }

  get builtAt(): string {
    return this.fingerprint;
  }
}

export function createSearchIndex(
  bookmarks: Bookmark[],
  categories: Category[],
  tags: Tag[]
): LocalSearchIndex {
  return new LocalSearchIndex(bookmarks, categories, tags);
}
