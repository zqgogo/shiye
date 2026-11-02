import type {
  BatchCleanupMode,
  BatchEntryState,
  ImportDestination,
} from './types.js';

/**
 * 这个动作能不能处理这条记录。
 *
 * **界面的按钮计数与仓库的冻结范围共用这一个函数**，避免「界面说 200 条、实际处理 260 条」。
 * 规则按动作区分，而不是按「有没有被加工」一刀切：
 *
 * - 移入回收站：只收还在列表里的记录（未改动 / 已改动）。已经在回收站里的没有「移入」可言，
 *   已转收藏、已完成的待看也不在这里动——它们不在这个动作的语义里。
 * - 彻底删除：除了列表里的，**也收已经在回收站里的记录**。这是「先移入回收站看看，确定不要了
 *   再彻底删除并重新导入」这条路的唯一入口；少了它，用户只能改走整库或整分类清空，范围更大。
 * - 已改动在两种动作里都可处理：撤回要保护用户的加工成果，但用户明确筛「已改动」并要求清理时，
 *   那正是他的意图。执行时仍按版本复核，预览之后又改的照样跳过。
 * - 已转收藏 / 已完成的待看一律不动：删待看记录会牵动「要不要连收藏一起删」的语义，
 *   留给它们各自入口（完成历史清理、收藏侧清理），不在这里顺手删。
 * - 已不存在的记录没有可删的东西，只报状态。
 */
export function isBatchCleanupActionable(
  state: BatchEntryState,
  destination: ImportDestination,
  mode: BatchCleanupMode
): boolean {
  if (state === 'missing') return false;
  if (destination === 'reading') {
    // 待看没有回收站：两个动作都是硬删除（靠清理快照找回），但转换与完成有各自的语义。
    if (state === 'converted' || state === 'completed') return false;
    return state === 'untouched' || state === 'modified';
  }
  if (state === 'trashed') return mode === 'delete';
  return state === 'untouched' || state === 'modified';
}
