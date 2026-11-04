import { expect, it } from 'vitest';
import { ORGANIZE_SYSTEM, splitOrganizeMaterial } from './organize-plan.js';
import { AI_INSTRUCTION, type AiInputItem } from './prompt.js';
const items = (count: number): AiInputItem[] => Array.from({ length: count }, (_, index) => ({ n: index + 1, bookmarkId: `b${index}`,
  title: `资料${index}`, url: `https://example.com/${index}`, sourceDescription: '', note: '', selectedText: '', categoryId: null, tagIds: [], lockedFields: [] }));
const options = { categories: [], tags: [], instruction: AI_INSTRUCTION, policyVersion: 1, inputChars: 60000, outputTokens: 4096 };
it('300 条完整分成 15 片，每片编号独立且材料覆盖所有资料', () => {
  const parts = splitOrganizeMaterial({ ...options, items: items(300) }); expect(parts).toHaveLength(15);
  expect(new Set(parts.map((part) => part.batchId)).size).toBe(15);
  expect(parts.flatMap((part) => part.items.map((row) => row.title))).toEqual(items(300).map((row) => row.title));
  for (const part of parts) expect(part.items.map((row) => row.n)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
});
it('同时按实际字符与输出预算分片，不把超长单条悄悄丢弃', () => {
  const source = items(50).map((row) => ({ ...row, sourceDescription: '长'.repeat(1200) }));
  const parts = splitOrganizeMaterial({ ...options, inputChars: 4000, items: source });
  expect(parts.length).toBeGreaterThan(3); expect(parts.flatMap((part) => part.items)).toHaveLength(50);
  expect(parts.every((part) => JSON.stringify(part, null, 2).length + ORGANIZE_SYSTEM.length <= 4000)).toBe(true);
  expect(splitOrganizeMaterial({ ...options, outputTokens: 832, items: items(7) }).map((part) => part.items.length)).toEqual([2, 2, 2, 1]);
  expect(() => splitOrganizeMaterial({ ...options, inputChars: 2000, items: [{ ...items(1)[0]!, note: 'x'.repeat(4000) }] })).toThrow();
  expect(() => splitOrganizeMaterial({ ...options, outputTokens: 512, items: items(1) })).toThrow();
  expect(() => splitOrganizeMaterial({ ...options, items: items(10001) })).toThrow('缩小范围');
  expect(() => splitOrganizeMaterial({ ...options, items: [] })).toThrow();
});
