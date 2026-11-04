import { expect, it } from 'vitest';
import { unknownAskReferences } from './prompt.js';
it('回答编号只允许当前材料范围，未知编号去重且不冒充来源', () => {
  expect(unknownAskReferences('资料 [1] [2] [0] [99] [99] [100]', 2)).toEqual([0, 99, 100]);
  expect(unknownAskReferences('资料 [1]，没有额外链接', 1)).toEqual([]);
});
