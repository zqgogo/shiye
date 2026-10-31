# P3 收集、粘贴与导入：回归覆盖与执行状态

更新日期：2026-10-28。对应 [P3 任务](../ROADMAP.md#p3--扩展收集粘贴与书签导入)。

## 1. 本轮新增的东西

P3 的功能实现此前已落地（P0.4 的导入与快照记录覆盖了文件解析的主路径），但缺少页面级回归，也不存在 Edge / Firefox 的脱敏书签样本。本轮补齐：

| 交付 | 说明 |
| --- | --- |
| `scripts/verify-p3.mjs`（`npm run verify:p3`） | 41 项页面级检查，覆盖 P3.1–P3.5，断言回读 IndexedDB 主库；每个阶段单独 try/catch，单项失败不中断整轮 |
| `fixtures/bookmarks-edge.html` | Edge 导出格式（Netscape），4 层目录 + 同 URL 重复 + `edge://` 内部页 |
| `fixtures/bookmarks-firefox.html` | Firefox PLACES 格式（`LAST_CHARSET`、`TAGS`、`PLACE` 智能书签） |
| `fixtures/bookmarks-hostile.html` | 含 `<script>`、`<style>`、`<img>`、`<iframe>` 与 `javascript:` / `data:` 链接，外部引用指向 `127.0.0.1:9` |
| `scripts/lib/launch-extension.mjs` | `readMainLibrary` 增加 `aiBlocked` / `tagIds` / `lockedFields` / `lastOpenedAt`，待看返回 `originalUrl`；新增 `readImportBatches` |

## 2. 覆盖清单

期望值不是推测出来的：先用一次性探针在 Node 里跑 `parseBookmarkHtml` + `planImport`，把每份 fixture 的真实条目数、状态分布、原因文案打印出来，再写进断言。

| 任务 | 检查项 |
| --- | --- |
| P3.1 | 首页同时有粘贴框、文件导入按钮与「粘贴 / 导入」卡片；弹窗「仅加入待看」写入队列；弹窗分类搜索能筛出目标分类并按分类保存；弹窗「保存收藏」进收件箱未读；重复保存同 URL 提示已收藏且不新建；扩展页面到 service worker 的消息通道可用（`PING` 返回 manifest 版本）；service worker 处于运行状态；`CAPTURE_LINK` 写收藏（右键「保存到拾页收藏」同一路径，进收件箱未读）；`CAPTURE_LINK` 写待看（右键「加入拾页待看」同一路径）；未定义消息类型被运行时校验拒绝 |
| P3.2 | 粘贴 4 行（2 可新增 / 1 本次重复 / 1 无效）统计正确；逐行保留状态与原因；切到收藏库后重新去重（已收藏变重复）；切换前说明会重置勾选，重算后只勾可新增行；已有收藏的行给出「已经收藏为」原因 |
| P3.3 | Chrome 书签 12 条（9/1/2）；多层目录保留为来源；目录按原目录分组给出映射选择器；映射到已有分类后写入生效（3 条）；Edge 6 条（4/1/1）且 `edge://` 判无效；Firefox 5 条（4/0/1）且 `place:` 判无效；恶意文件不执行脚本、不加载外部资源；损坏文件给出结构警告且不写入 |
| P3.4 | 取消勾选单行后已选计数同步；只写入勾选的 8 条（结果面板与主库一致）；未勾选、重复、无效行都不入库；写入后保留批次记录（`applied` / `inserted` / `fileName`）；两批导入各自留下记录 |
| P3.5 | 受限页面提示手动填写合法网址；受限页面读取所选文字给出明确拒绝；粘贴不联网抓标题（用域名占位）；取消预览不写入且保留输入；超过单批 1000 条明确拒绝；超过 3 MB 的文件被拒绝；普通导入收藏不自动完成相同 URL 的待看 |

## 3. 执行记录与修正

### 第 1 轮：第 10 项中断

以 `Could not establish connection. Receiving end does not exist.` 中断：

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| 脚本从 service worker 内部调用 `chrome.runtime.sendMessage` | MV3 下 Chrome 不会把消息投递给发送方所在的上下文，worker 的 `onMessage` 收不到自己发的消息，所以永远没有接收端 | 改由扩展页面（`workspace.html`）发起消息，这也是真实链路：页面/popup → worker。先发 `PING` 兼作唤醒，再断言 `CAPTURE_LINK` |
| `/capture` 与 `/capture:file` 共用一个组件，React 复用实例 | `initialMode` 只在挂载时读一次，从侧边栏点「粘贴链接」仍停在导入页签（真实产品缺陷，不只是测试问题） | `App.tsx` 给两个路由加不同 `key` 强制重建 |

同时把脚本改成按阶段 try/catch：任一阶段抛错只记一条 `<阶段> 中断` 的 FAIL，后续阶段继续执行，避免一次运行只暴露一个失败点。

### 第 2 轮：34 项中 32 项通过

Chrome 156.0.8078.49 无头，`headless: true`，页面脚本错误为空。两处失败都不是功能问题：

| 失败项 | 原因 | 修法 |
| --- | --- | --- |
| P3.2 粘贴预览 中断（等待「核对导入内容」超时） | 首页「预览链接 →」只把文本带到采集页，**不会自动解析**，还要在采集页再点一次同名按钮。而产品文档写的是「首页直接粘贴多链接→预览」，这条本身就与文档不符 | `capture.tsx` 在带粘贴内容挂载时自动解析一次（`useRef` 保证只触发一次），首页一步到位；产品缺陷因此修掉，脚本无需再点两次 |
| P3.3 目录映射到已有分类后写入生效（该分类下 4 条，期望 3 条） | 断言把 P3.1 弹窗样本也算进去了——它本来就带着同一个分类 | 统计时排除 `URL_POPUP_BOOKMARK`，只数本批写入的行 |

### 第 3 轮：41 项全通过（2026-10-28）

Chrome 156.0.8078.49 无头（`headless: true`），`errors=[]`，原始 JSON 在 `.verify/reports/p3-browser-verification.json`。上表两项修正均生效。关键实测值：

| 类别 | 结果 |
| --- | --- |
| 消息通道 | `PING` 返回 `{"ok":true,"result":{"ok":true,"version":"0.1.0"}}`，与 `dist/manifest.json` 一致；worker 处于运行状态 |
| `CAPTURE_LINK` 写收藏 | 入库回读 `unreadFlag=1`；写待看回读 `status=pending`；未定义类型返回「不支持的消息格式。」 |
| Chrome 书签 | 12 条 = 9 新增 / 1 重复 / 2 无效，写入 8 条（手动取消 1 行），批次记录 `["bookmarks-chrome.html","applied",8,12]` |
| Edge 书签 | 6 条 = 4 / 1 / 1，`edge://settings` 判无效 |
| Firefox 书签 | 5 条 = 4 / 0 / 1，`place:sort=8&maxResults=10` 判无效 |
| 恶意文件 | 外部请求 `[]`、脚本执行 `false`，3 条中 2 条无效（`javascript:` / `data:`） |
| 损坏文件 | 结构警告触发，收藏数 15→15，一条未写 |
| 限额 | 1001 条拒绝（「单批最多 1000 条」）、3.57 MB 拒绝（「文件超过 3 MB」） |
| 粘贴 | 4 行 = 2/1/1；切目标后重算为 1/2/1 且只勾可新增行；不联网抓标题，用域名占位 |

因此 P3.1–P3.5 已按证据勾选。第 4 节三项仍需人工或单元测试覆盖，未计入勾选依据。

## 4. 未验证项

三项无法在本轮自动化里取证，已写进报告 `limitations`：

1. **右键菜单**（「加入拾页待看」「保存到拾页收藏」）：浏览器原生菜单无法被自动化点击。本轮由扩展页面向 worker 发 `CAPTURE_LINK` 验证了同一写入路径与来源校验（菜单回调调用同一个 `saveFromMenu` / service 方法），菜单本身仍需人工右键点一次。
2. **读取页面所选文字**：需要 `activeTab` 授权，而该授权由用户点击工具栏图标时产生；自动化把 `popup.html` 当普通标签页打开，只验证了受限时的提示文案。
3. **导入事务中途失败的整体回滚**：不注入故障无法从界面触发。本轮验证的是「只写勾选行」与「重复提交返回 `ALREADY_APPLIED`」（后者在 `packages/storage` 测试里覆盖），事务性本身由 Dexie 事务保证。

## 5. 执行方式

```bash
npm run build
npm run verify:p3              # 只跑 P3（默认无头，不弹窗口）
SHIYE_HEADED=1 npm run verify:p3   # 开可见窗口，用来人工观察自动化点了什么
npm run verify:all             # P0 + P0.4 + P1 + P2 + P3 全量回归
```

浏览器不是常驻应用：脚本用 `puppeteer-core` 拉起一个子进程，`userDataDir` 指向 `.verify/p0-profile-chrome-*`，所以主库落在那个临时 profile 里，与你日常 Chrome 的数据完全隔离，每轮都是空库起步。

原始 JSON 写到 `.verify/reports/p3-browser-verification.json`（不入库）。失败项按报告里的 `step` 与 `detail` 修正实现或选择器。

> 执行状态：2026-10-28 第 3 轮 41 项全部通过，P3.1–P3.5 已勾选。三轮的修正过程见第 3 节。

## 6. 使用反馈后的补充（2026-10-30）

真实导入时暴露出两件事：① 「导入收藏夹」沿用了「粘贴链接」的默认目标（待看），整批书签静默进待看，而待看没有分类字段、目录映射区只在收藏库目标下渲染，看起来就是「分类丢了」；② 导错之后没有退路——只能逐条删，而且删掉的记录会留下墓碑，同一批书签再也导不进来。

| 改动 | 落点 | 断言 |
| --- | --- | --- |
| 默认目标跟随入口：`capture:file` / 切到「导入收藏夹」→ `library`；粘贴仍为 `reading` | `apps/workspace/src/capture.tsx` | `verify:p3`「导入收藏夹默认保存到收藏库」「默认目标下目录映射区直接可见」 |
| 按批次撤销：`undoBatch()` 删掉这一批新建的条目，`localRevision > 1` 的保留并报数；连墓碑一起清，批次记 `reverted` | `packages/storage/src/repositories.ts`、`packages/application/src/ports.ts`、`packages/application/src/workspace.ts` | 单测「撤销导入只移除这一批新建的收藏，导入后改过的保留」「撤销后同一批网址可以重新导入（不留下墓碑）」「同一批只能撤销一次」 |
| 撤销入口：结果面板 + 数据页「最近导入」 | `apps/workspace/src/capture.tsx`、`apps/workspace/src/data.tsx` | `verify:p3`「撤销导入移除这一批」「批次记为 reverted」「数据页列出批次并可从那里撤销」 |
| 批量清空：`purgeAll()` / `purgeCategory()` / `purgePending()`，**连墓碑一起删** | `packages/storage/src/repositories.ts`、`apps/workspace/src/pages.tsx` | 单测「彻底清空收藏库连墓碑一起清掉，之后可以重新导入」「清空分类只移除该分类下的收藏」「清空待看只清队列」；`verify:p3`「彻底清空后收藏与墓碑都归零」「清空待看只清队列，收藏数量不变」 |

为什么清空要删墓碑：导入去重会看墓碑，只软删的话重新导入会全部判成「存在已删除收藏，未绕过墓碑」，用户看到的是「清空了却导不进来」。代价（不可恢复；更早的备份合并时会把它们带回来）记在 [open-issues](../open-issues.md) ⑨。

复跑：`verify:p3` **42 → 48 项全通过**，`npm test` 89 → 96 项，`verify:p2/p4/p5/p6` 无回归。

### 第 4 轮：补深层目录与同文件再导断言（2026-10-31）

[open-issues](../open-issues.md) 里两条「部分覆盖」本轮收成正式断言，`verify:p3` 48 → **55 项全通过**（Chrome 156.0.8078.74 无头，`errors=[]`）。

| 新增断言 | 实测值 |
| --- | --- |
| 超过 32 层的目录给出层级告警 | 界面提示「目录层级超过 32 层，更深的目录会合并到上限层级。」 |
| 超限深度的条目不被丢弃，来源目录截断到第 32 层 | 40 层 fixture 的 1 条收藏正常解析（1 新增 / 0 重复 / 0 无效），原目录末段为「第 30 层 / 第 31 层 / 第 32 层」，不含第 33 层 |
| 深层目录预览不写入主库 | 收藏数 11→11 |
| 同一文件再导：已写入的 8 条全部转为重复 | 总 12 = 1 新增 / 9 重复 / 2 无效 |
| 再导时只剩上次没勾选的那条仍可新增 | 唯一可新增行是 `https://example.com/same-title`（第 3 轮手动取消勾选的那条） |
| 再导只写入剩下的 1 条，不重复写已入库的 | 结果面板 1 条新增，收藏 11→12 |
| 同一文件第三次导入：可新增为 0，写入按钮不可用 | 总 12 = 0 新增 / 10 重复 / 2 无效，已选 0，`确认写入` disabled |

顺带修掉两处脚手架问题，都是「测试自己的错，不是产品缺陷」：

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| 同一文件再导不出现预览 | `<input type=file>` 的 value 没变，浏览器不再触发 `change`，采集页收不到新选择 | `uploadFixture()` 上传前先清空 `value`，让每次选择都被当成新选择 |
| Edge 阶段「继续导入」找不到 | 新增的再导阶段结束时已「取消预览」，结果面板被消费掉了，而 Edge 阶段假设它还在 | Edge 阶段改为「存在才点」，与「恶意内容」阶段的一致性写法对齐 |

一条既有断言随覆盖范围变化更新：批次记录由「两批」改为「每批各自留痕」，断言 3 条 `applied`（Chrome 8、Chrome 再导 1、Firefox 4），并核对 Chrome 两条的 `inserted` 排序后为 `1,8`。

### 第 5 轮：清空确认框的条数与实删数量对齐（P9.0，2026-10-31）

[open-issues](../open-issues.md) ⑩ 记的是一处真实缺陷：确认框按当前活跃列表计数（`items.length`），而 `purgeCategory()` / `purgeAll()` 连回收站里的记录一起删，确认数可能小于实删数。修法与断言：

| 改动 | 落点 | 断言 |
| --- | --- | --- |
| 新增作用域计数 `PurgeCounts { active, trashed, tombstones }` | `packages/core/src/types.ts` | 类型与端口契约 |
| `countPurgeAll()` / `countPurgeCategory()` | `packages/storage/src/repositories.ts` | 单测「整库清空的计数包含回收站，且与实删数量一致」「分类清空把回收站里的记录算进来，计数与实删数量一致」 |
| `purgeCounts(scope)` 用例 | `packages/application/src/workspace.ts` | 同上（单测直接走仓储） |
| 确认框改为「将删除 N 条记录（在库 A · 回收站 B），并清掉 K 条删除标记」，确认后核对返回的实删数量 | `apps/workspace/src/pages.tsx` | `verify:p3`「清空确认框拆出在库 / 回收站 / 删除标记，且与实删数量一致」 |

实测（`verify:p3`，Chrome 156.0.8078.74 无头）：先删 1 条进回收站，确认框显示 `total=12 active=11 trashed=1 tombstones=1`，与主库 12 条（含回收站 1）一致；`verify:p3` 55 → **56 项全通过**，单测 96 → 98 项。

仍存的边界：分类页与未分类页走同一条 `countPurgeCategory`，浏览器级只覆盖了「全部收藏」页，两页的数字由单测保证，未单独在页面上取数。

### 第 6 轮：补「淘汰到 5 份」与「重开浏览器仍可恢复」两条断言（P9.4 收尾，2026-10-31）

P9.4 第一段落地时留了两条边界只有单测保证，本轮补成浏览器断言，`verify:p3` 56 → **62 项全通过**（Chrome 156，`errors=[]`）。

| 断言 | 做法 | 实测值 |
| --- | --- | --- |
| 清理快照只保留最近 5 份 | 连做 6 轮「新建一条 → 彻底清空」，每轮都会真实写一份快照 | 淘汰前 4 条 → 连做 6 轮后 **5 条**，最新一条为「清 整个收藏库 收藏 1」 |
| 关掉浏览器重开后仍可找回 | `browser.close()` 后用**同一个 profile** 重新拉起扩展，再打开数据页读「最近清理」 | 重启前 **5 条** → 重启后 **5 条**，扩展 ID 不变，`errors=0` |

淘汰断言的关键是不能只看「有 5 条」，还要满足「淘汰前 + 6 > 5」——否则在快照还没到上限时，数量恰好是 5 也只是巧合。

同时修掉一处与被测功能无关的脚手架竞态：数据页的「最近导入」是异步加载的，原来在标题一出现就点「撤销这次导入」，批次还没渲染出来就扑空（`未找到可点击元素`）。改为先等按钮文案出现再点。

单测同轮 108 → **110 项**：新增「替换恢复不会清掉清理快照」与「替换恢复后仍能找回清理前的条目」。前者防的是「换机器恢复一次，本机安全网被连带清空」——`restore(..., 'replace')` 的清表清单里没有 `purgeSnapshots`，但这一点此前没有任何断言守护。

### 第 7 轮：撤回改成「先预演、后留档」（P9.1，2026-10-31）

原先点「撤销这次导入」是一步直删，只在几秒后消失的提示里报一句「移除 N 条」。P9.1 把它拆成两段，并补上事后可回查的留档。

| 改动 | 落点 | 断言 |
| --- | --- | --- |
| 只读预演 `previewUndoBatch()`，与执行共用 `judgeBatchItems()` | `packages/storage/src/repositories.ts` | 单测「预览的三类计数与执行结果完全一致」并在预览后核对主库条数不变 |
| 五类保留原因 `modified / trashed / completed / converted / missing` | `packages/core/src/types.ts` | 单测「保留原因区分改过 / 回收站 / 待看已完成 / 已转收藏 / 已不存在」 |
| 批次持久化 `revertedAt / undoCounts / undoKept`（schema v3 → v4） | `packages/storage/src/db.ts`、`packages/core/src/types.ts` | 单测「撤回结果写进批次，刷新后仍能回看条数与原因」+「版本 3 主库升级时给老批次补上撤回字段」 |
| 结果页与数据页都改成「预演 → 确认 → 常驻结果面板」 | `apps/workspace/src/capture.tsx`、`apps/workspace/src/data.tsx`、`components.tsx` | `verify:p3` 四条：预演条数、常驻面板、刷新后仍可查、批次搜索 |
| 批次历史分页搜索 `listBatches({ search, status, limit, offset })` | `packages/application/src/ports.ts` | 单测「批次列表可按文件名搜索并分页，不再固定只给最近 20 批」 |

实测（`verify:p3`，Chrome 156 无头）：结果页预演文案为「将移除 4 条，保留 0 条」，撤回后批次上 `undoCounts={removed:4,kept:0,missing:0}` 且 `revertedAt` 有值；数据页撤回同样先给「将移除 2 条」；刷新后批次行仍显示「已撤回 时间（移除 2 · 保留 0）」；搜索 `bookmarks-firefox` 只命中该批。`verify:p3` 62 → **68 项全通过**，单测 110 → 116 项。

仍存的边界：撤回本身不可撤销（靠 P9.4 清理快照找回）；被移走的条目没有留存清单，只有三数，P9.2 的「查看本批记录」才会补上。
