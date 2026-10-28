# P3 收集、粘贴与导入：回归覆盖与执行状态

更新日期：2026-10-28。对应 [P3 任务](../ROADMAP.md#p3--扩展收集粘贴与书签导入)。

## 1. 本轮新增的东西

P3 的功能实现此前已落地（P0.4 的导入与快照记录覆盖了文件解析的主路径），但缺少页面级回归，也不存在 Edge / Firefox 的脱敏书签样本。本轮补齐：

| 交付 | 说明 |
| --- | --- |
| `scripts/verify-p3.mjs`（`npm run verify:p3`） | 36 项页面级检查，覆盖 P3.1–P3.5，断言回读 IndexedDB 主库 |
| `fixtures/bookmarks-edge.html` | Edge 导出格式（Netscape），4 层目录 + 同 URL 重复 + `edge://` 内部页 |
| `fixtures/bookmarks-firefox.html` | Firefox PLACES 格式（`LAST_CHARSET`、`TAGS`、`PLACE` 智能书签） |
| `fixtures/bookmarks-hostile.html` | 含 `<script>`、`<style>`、`<img>`、`<iframe>` 与 `javascript:` / `data:` 链接，外部引用指向 `127.0.0.1:9` |
| `scripts/lib/launch-extension.mjs` | `readMainLibrary` 增加 `aiBlocked` / `tagIds` / `lockedFields` / `lastOpenedAt`，待看返回 `originalUrl`；新增 `readImportBatches` |

## 2. 覆盖清单

期望值不是推测出来的：先用一次性探针在 Node 里跑 `parseBookmarkHtml` + `planImport`，把每份 fixture 的真实条目数、状态分布、原因文案打印出来，再写进断言。

| 任务 | 检查项 |
| --- | --- |
| P3.1 | 首页同时有粘贴框、文件导入按钮与「粘贴 / 导入」卡片；弹窗「仅加入待看」写入队列；弹窗分类搜索能筛出目标分类并按分类保存；弹窗「保存收藏」进收件箱未读；重复保存同 URL 提示已收藏且不新建；`CAPTURE_LINK` 消息（右键菜单的同一写入路径）写入成功；未定义消息类型被运行时校验拒绝 |
| P3.2 | 粘贴 4 行（2 可新增 / 1 本次重复 / 1 无效）统计正确；逐行保留状态与原因；切到收藏库后重新去重（已收藏变重复）；切换前说明会重置勾选，重算后只勾可新增行；已有收藏的行给出「已经收藏为」原因 |
| P3.3 | Chrome 书签 12 条（9/1/2）；多层目录保留为来源；目录按原目录分组给出映射选择器；映射到已有分类后写入生效（3 条）；Edge 6 条（4/1/1）且 `edge://` 判无效；Firefox 5 条（4/0/1）且 `place:` 判无效；恶意文件不执行脚本、不加载外部资源；损坏文件给出结构警告且不写入 |
| P3.4 | 取消勾选单行后已选计数同步；只写入勾选的 8 条（结果面板与主库一致）；未勾选、重复、无效行都不入库；写入后保留批次记录（`applied` / `inserted` / `fileName`）；两批导入各自留下记录 |
| P3.5 | 受限页面提示手动填写合法网址；受限页面读取所选文字给出明确拒绝；粘贴不联网抓标题（用域名占位）；取消预览不写入且保留输入；超过单批 1000 条明确拒绝；超过 3 MB 的文件被拒绝；普通导入收藏不自动完成相同 URL 的待看 |

## 3. 未验证项

三项无法在本轮自动化里取证，已写进报告 `limitations`：

1. **右键菜单**（「加入拾页待看」「保存到拾页收藏」）：浏览器原生菜单无法被自动化点击。本轮通过 service worker 的 `CAPTURE_LINK` 消息验证了同一写入路径与来源校验，菜单本身仍需人工右键点一次。
2. **读取页面所选文字**：需要 `activeTab` 授权，而该授权由用户点击工具栏图标时产生；自动化把 `popup.html` 当普通标签页打开，只验证了受限时的提示文案。
3. **导入事务中途失败的整体回滚**：不注入故障无法从界面触发。本轮验证的是「只写勾选行」与「重复提交返回 `ALREADY_APPLIED`」（后者在 `packages/storage` 测试里覆盖），事务性本身由 Dexie 事务保证。

## 4. 执行方式

```bash
npm run build
npm run verify:p3     # 只跑 P3
npm run verify:all    # P0 + P0.4 + P1 + P2 + P3 全量回归
```

原始 JSON 写到 `.verify/reports/p3-browser-verification.json`（不入库）。通过后按结果勾选 P3.1–P3.5；失败项按报告里的 `step` 与 `detail` 修正实现或选择器。

> 本脚本尚未在真实浏览器执行过。期望值取自 Node 探针，选择器取自 `capture.tsx` 与 `Popup.tsx` 的实际 DOM，若首轮有失败项，先看失败项是选择器问题还是行为问题。
