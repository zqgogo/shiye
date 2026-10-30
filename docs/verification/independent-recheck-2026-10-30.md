# 拾页修复复核（2026-10-30）

复核提交：`2cd4bacd27c744be4165870aa86d722af10157a5`。开始时工作区干净。本次仅新增复核报告与 `.verify/` 内的本地复现材料，没有修改产品代码。

## 结论

上次报告的主路径已补上多项实质修复，但“10 条全部修复”仍过于绝对。本轮确认了 5 组剩余问题；其中安全备份覆盖、隐私遗漏建议优先处理。新保护也引入了一条实际界面错误分支，不能只用 service 单测作为验收。

## 1. [P1] 尚未确认保存的安全备份会被下一次恢复覆盖，甚至下一次恢复失败也会覆盖

位置：[backup.ts:313](../../packages/storage/src/backup.ts#L313)、[workspace.ts:407](../../packages/application/src/workspace.ts#L407)。

复现：

1. 当前库为 A，替换恢复为 B；`meta.safetyBackup` 正确保存了 A。
2. 没有点击“已确认保存”，也没有保存 A 到文件。
3. 再选一个信封合法、条目缺 ID 的损坏备份，点击替换。
4. 第二次替换被拒绝，当前库仍是 B；但安全副本已经从 A 改成 B，A 无法从本机取回。

原因：安全备份使用固定键无条件 `put`，并且在逐条恢复校验之前执行。数据页只显示提醒，没有阻止下一次替换。仅说明“副本不随替换 clear”不能保证它不会被下一次 put 覆盖。

建议：为每份安全备份分配 ID，保留未确认副本；或在仓储事务中拒绝覆盖未确认副本，要求先保存并确认。清理也应按副本 ID 核对，防止旧标签页清掉新副本。对新文件的完整校验应在覆盖任何安全状态之前完成。

证据：独立用例“第二次恢复即使失败，也覆盖了尚未确认保存的原始安全备份”成功复现。

## 2. [P1] 从本地专用收藏重新加入已完成待看，仍会把内容带进默认备份

位置：[repositories.ts:552](../../packages/storage/src/repositories.ts#L552)、[backup.ts:271](../../packages/storage/src/backup.ts#L271)。

复现：

1. 先独立添加网址 U 到待看，再标记完成。
2. 收藏 U，设为“本地专用”。
3. 从这条收藏点击“加入待看”，调用携带正确的 `relatedBookmarkId`。
4. 复用旧待看时只修改 pending、完成时间和修订号，没有更新关联 ID，仍为 null。
5. 默认导出仅按关联 ID 过滤；这条待看的标题和网址仍进入 JSON。

因此，上次测试覆盖的“新建关联待看”已修，但“重新激活已有待看”未修。独立加入待看、之后再把同网址收藏标成私密的路径也存在相同边界。

建议：重新激活时正确维护关联信息；导出过滤再按 canonicalUrl 与本地专用收藏核对，或为待看设计独立且明确的隐私规则。必须覆盖重新加入、修改隐私、关联丢失三条路径。

证据：独立用例确认调用传入关联 ID 后，库内仍为 null；默认 JSON 仍包含私密网址与标题。

## 3. [P2] 墓碑裁决仍不完整：不同 ID 的同网址收藏可重新进入活跃库

位置：[backup.ts:508](../../packages/storage/src/backup.ts#L508)、[backup.ts:516](../../packages/storage/src/backup.ts#L516)。

复现：本机删除网址 U 的收藏 A；另一设备备份含同 U、不同 ID 的活跃收藏 B；合并后 B 进入日常收藏，A 的墓碑仍在。普通创建路径对回收站中同网址会要求明确恢复，合并路径却只按 ID 检查墓碑，按网址检查时又排除了已删除记录，因此绕过了同一条产品规则。

建议：按 canonicalUrl 同时查询本机删除实体和删除标记，对这类条目跳过并提示，或让用户单独明确恢复。补不同设备独立创建同网址、不同 ID 的回归。

同一处恢复逻辑还有一个状态一致性遗漏：`restoredActiveIds` 来自备份输入，而不是事务中最终保留的活跃实体。若备份仅含某条墓碑、不含对应收藏，合并会给本机仍活跃的收藏写入同 ID 墓碑。已用独立场景确认两种状态同时存在。墓碑冲突处理应依据最终库状态，而不只是备份数组。

## 4. [P2] AI 过期错误没有被界面捕获，按钮卡在“应用中…”

位置：[ai.tsx:246](../../apps/workspace/src/ai.tsx#L246)。

真实 Chrome 复现：生成材料包 → 校验到预览页 → 模拟另一标签页提交新的策略版本 → 点击“应用勾选项”。

后端正确抛出 `STALE_SUGGESTION`，收藏没有被修改；但 UI 的 apply 没有 try/catch/finally，`setBusy(false)` 不会执行。实测结果：

```json
{
  "button": "应用中…",
  "disabled": true,
  "visibleError": false,
  "targetPurpose": ""
}
```

浏览器同时记录了未处理的 AppError。报告中“应用阶段拒绝并说明原因”的断言只验证了 service 抛错，未验证用户能看见原因。

建议：参照同页 validate/revert，catch 后调用 `setError(toUserMessage(cause))`，finally 解除 busy；对批次失效、主库替换、重复应用和存储失败也覆盖这条错误分支。

证据：`.verify/review-2026-10-30/ai-stale-ui.json`、`ai-stale-ui.png`；脚本可复跑。

## 5. [P2] AI 策略检查仍在写入事务外，竞态窗口尚未关闭

位置：[workspace.ts:499](../../packages/application/src/workspace.ts#L499)、[workspace.ts:515](../../packages/application/src/workspace.ts#L515)、[repositories.ts:352](../../packages/storage/src/repositories.ts#L352)。

当前做法是在 service 逐条读取批次、设置、策略，然后再调用仓储开启收藏写事务。仓储事务只包含 bookmarks、appliedChanges、categories、tags，没有 policies、settings 或 handoffBatches。

独立用例让另一笔策略更新精确提交在“检查已通过”和“写事务开始”之间：策略版本已经变了，旧建议仍成功写入。该用例注入的是并发调度点，并未移除或绕过已有检查。

建议：每条应用事务同时读取批次、主库身份与当前策略，再检查、写收藏和日志。扩大事务表范围，把预期批次/策略上下文传入仓储；单纯再加一次事务外检查仍会留下窗口。

证据：独立用例“应用前检查通过后、写事务开始前策略被更新，旧建议仍然写入”成功复现。

## 上次 10 条的本轮状态

| 原编号 | 本轮判断 |
| --- | --- |
| 1 删除复活 / 合并覆盖 | 同 ID 高修订覆盖已修；不同 ID 的同网址及墓碑一致性仍需处理，见本报告 3 |
| 2 损坏条目替换清空 | 原复现场景已修；逐条损坏会拒绝替换，主库保持不变 |
| 3 非法原始链接 | 原复现场景已修；原始 URL 重新校验，UI 增加打开检查 |
| 4 安全备份只在内存 | 已持久化；连续恢复可覆盖未确认副本，见本报告 1 |
| 5 本地专用关联待看 | 新关联场景已修；已有待看重新激活漏关联，见本报告 2 |
| 6 AI 过期保护 | 常规 service 拒绝已修；界面报错和事务竞态仍未收口，见本报告 4、5 |
| 7 来源字段丢失 | 原备份往返场景已修，正式测试验证目录、批次与待看来源 |
| 8 待看同网址重复 | 原 pending + pending 合并场景已修 |
| 9 空库策略与设置 | 原迁移场景已修 |
| 10 划词截断 | 码点处理和弹窗提示已改；右键保存仍静默截断，已列为已知限制，不能按原规格宣称完全修复 |

右键超长摘录是已公开的未完成项，本报告不将其重复计为新缺陷。若接受该产品取舍，应同步修改验收标准；若坚持原要求，应补明确提示或确认流程。

## 本轮验证范围

- `npm run verify`：类型检查、79 项正式单测、生产构建全部通过。
- `npm run verify:p6`：当前报告 `steps` 为 31 项，全部通过。并未在本轮重新执行整套 262 项。
- 5 个额外领域复现用例全部成功观察到上述剩余问题，位于 `.verify/review-2026-10-30/probes.test.ts`。它们断言当前错误现象，未加入正式测试集。
- 1 条真实浏览器异常路径：成功复现 AI 过期后界面卡住；使用临时 profile，未读取或修改日常浏览器数据。
- 手机真机、右键原生点击、真实划词、读屏、P7 真实模型仍不在本次已验证范围内。

复跑独立用例：

```sh
npx vitest run --config .verify/review-2026-10-30/vitest.config.ts
node .verify/review-2026-10-30/ai-stale-ui.mjs
```

浏览器脚本复用 P5 的样本准备及校验流程，在预览后插入策略变更，输出到本轮独立 JSON；未改动正式验证脚本。`.verify/` 被 Git 忽略，仅本机保留。修复后应将复现断言改成正确行为，再加入正式回归。

## 处理结果（2026-10-30）

五组问题逐条修复，并在同一批提交里补了正式回归：报告里的 5 个复现用例已改成「修复后应当发生的结果」重跑通过，其中界面相关的一条同时进了 `verify:p5`，不再只靠 service 单测验收。

| 原编号 | 处理 | 落点 | 回归 |
| --- | --- | --- | --- |
| 1 安全备份被下一次恢复覆盖 | 每份副本分配 `id`；存在未清理副本时 `saveSafetyCopy` 直接抛 `SAFETY_COPY_PENDING`，替换被挡下、主库不动；**整份文件校验前移到保存副本之前**（`validateRestore` 与 `restore` 共用同一套清洗判定），注定失败的替换不再触碰安全状态；清理按副本 `id` 核对，旧标签页的按钮动不了新副本 | `packages/storage/src/backup.ts`、`packages/application/src/workspace.ts`、`apps/workspace/src/data.tsx` | 单测「第二次替换失败不会覆盖尚未确认的安全备份」「未确认的安全备份存在时下一次替换被挡下，清理按编号核对」；复跑用例 1 |
| 2 重新激活待看漏关联 | 重新激活时写回 `relatedBookmarkId`（`params` 优先，保留旧值兜底）；导出的隐私过滤再加一层 `canonicalUrl` 核对——同网址存在本地专用收藏（含回收站里的）时，待看同样不导出 | `packages/storage/src/repositories.ts`、`packages/storage/src/backup.ts` | 单测「重新激活已完成待看时补上关联编号…」「先加入待看、之后才把同网址收藏设为本地专用…」；复跑用例 2 |
| 3 同网址不同 ID 绕过删除 | 合并时按 `canonicalUrl` 同时查活跃记录、已删除记录与墓碑（含只在网址上命中的墓碑），命中即跳过并计 `keptLocalDeletes`；墓碑冲突不再看备份数组，改为在事务里查该 ID 的最终实体 | `packages/storage/src/backup.ts` | 单测「合并时同网址、不同编号的备份收藏不能绕过本机删除」「合并只含墓碑的备份不会给本机活跃收藏写墓碑」；复跑用例 3、5b |
| 4 AI 过期后界面卡住 | `apply` 补 `try/catch/finally`：捕获后 `setError(toUserMessage)` + 错误 toast，`finally` 解锁 `busy`；一条都没写进去时把第一条跳过原因写进页面，不再只弹「已应用 0 条」 | `apps/workspace/src/ai.tsx` | `verify:p5` 新增 37 项：浏览器里造出「预览后另一标签页提交新策略」，断言按钮回到「应用勾选项」且可点、页面显示原因、目标条目未被写入；复核脚本复跑 `pageErrors=[]` |
| 5 策略检查与写入不在同一事务 | `applySuggestion` 的事务范围扩到 `handoffBatches` / `settings` / `policies`，写之前在同一事务里复核批次状态、主库身份与策略版本（`ApplySuggestionContext` 带 `libraryId` / `policyVersion` 进入事务）；服务层的事务外检查保留，只用于提前给出可读原因 | `packages/storage/src/repositories.ts`、`packages/application/src/ports.ts`、`packages/application/src/workspace.ts` | 单测「检查通过后、写事务开始前策略被更新，旧建议仍然写不进去」（在检查与事务之间精确注入策略更新）；复跑用例 5 |

### 验证

- `npm run typecheck`、`npm run build` 通过；`npm test` 79 → **86 项**。
- `npm run verify:p5` **37 项全通过**（原 36 项 + 新增界面断言），报告 `.verify/reports/p5-browser-verification.json`，`errors=[]`、`外部请求=[]`。
- 复跑无回归：`verify:p2` 37 项、`verify:p4` 45 项、`verify:p6` 31 项全通过。
- 复核脚本 `.verify/review-2026-10-30/ai-stale-ui.mjs` 复跑：`button=应用勾选项`、`disabled=false`、`visibleError=true`、`pageErrors=[]`；`probes.test.ts` 改成正确行为后 5 项全过。

### 仍不在本轮范围

P6.4 手机真机、右键菜单原生点击、真实划词、读屏播报、P7 真实模型；右键菜单保存超长摘录仍按码点静默截断（已公开的取舍，见 [open-issues](../open-issues.md)）。
