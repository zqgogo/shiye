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
