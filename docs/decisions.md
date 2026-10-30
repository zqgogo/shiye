# 技术决定记录

记录依据冲突时的取舍、关键架构选择及其后果。每条注明「决定 / 原因 / 影响」，以便后续阶段复用或推翻时有据可查。

资料优先级：产品与技术实现说明 v2.1（需求依据）> `03_AI开发任务书` v2.1（执行顺序）> `docs/ROADMAP.md`（本仓库任务清单）> `01_UI设计稿`（视觉与交互）> `reference/`（参考资料，不直接采用）。

## 1. 资料冲突与处理

| 冲突 | 处理 | 影响 |
| --- | --- | --- |
| 技术说明第 22 节用 P0–P6 合并编号，任务书与 ROADMAP 用 P0–P7 | 采用 P0–P7；P4–P5 对应技术说明 P4，P6 对应技术说明 P5，P7 对应技术说明 P6 | 任务范围未删减，只是编号更细 |
| 交付包文件名写 v2_0，实际目录为 v2_1 | 以 v2_1 内容为准 | 无代码影响 |
| `reference/d1_candidate.sql` 提供云端表结构 | 不作为本地主库 schema 依据，仅作字段命名参考 | 本地主库为 IndexedDB，不引入 D1 |
| `reference/domain.ts` 含 `valueLevel` / `valueReason` | 按 v2.1 明确取消价值等级，最终模型不含这两个字段 | 迁移时主动清理旧值 |
| `manifest.v1a.json` 为 v1a 权限集合 | 以 v2.1 的最小权限为准，`optional_host_permissions` 保持未申请 | 不需要常驻主机权限即可工作 |

## 2. 依赖与工具链

- **决定**：npm workspaces 单仓 + React 18.3.1 + TypeScript 5.7.3 + Vite 5.4.21 + Dexie 4.0.11 + MiniSearch 7.1.3 + zod 3.23.8，测试用 Vitest 2.1.9 + fake-indexeddb 6.0.1。
- **原因**：这些版本彼此兼容且已有稳定类型定义；仓库最新大版本（TS 7 / Vite 8 / Vitest 5）在无对应类型包时无法编译。
- **影响**：`npm install` 后 `npm run verify`（typecheck + test + build）即为最小持续集成检查。本机 npm 官方源不可达，安装时使用 `registry.npmmirror.com`。
- **不做**：不引入 UI 组件库、状态管理库或表单库；样式手写在 `apps/workspace/src/styles.css`，与设计稿色值一一对应。

## 3. 安装与构建

- **架构**：UI → application（用例）→ 端口接口；storage / ai adapters 实现接口；core 保持纯规则（不依赖浏览器 API，除 Web Crypto 有回退）。
- **构建**：两个 Vite 配置。页面（`workspace.html`、`popup.html`）走 `vite.config.ts`；service worker 单独走 `vite.sw.config.ts`（`lib` 模式 + `inlineDynamicImports`），产出**自包含**的 `service-worker.js`。
  - 原因：MV3 的 worker 若引用页面 chunk，会在 worker 环境里加载失败；先前一次构建产物出现过 `import "./assets/index-*.js"`，已改为独立构建。
- **本地加载（真实用户）**：
  1. `npm install && npm run build`
  2. 打开 `chrome://extensions`（Edge：`edge://extensions`），开启「开发者模式」
  3. 点「加载已解压的扩展程序」，选择 `apps/extension/dist`
  4. 建议固定扩展图标；之后点击图标使用弹窗，右键菜单可直接收集，`工作台` 通过 `options_ui` 或弹窗内「打开工作台」进入
- **自动化加载（仅验证用）**：Chrome 137+ 已移除 `--load-extension`，自动化改用 CDP `Extensions.loadUnpacked`（需 `--enable-unsafe-extension-debugging`）；Edge 148 仍支持命令行加载。详见 [P0.2/P0.3 验证记录](verification/p0-browser-verification.md#加载方式重要差异)。

## 4. 扩展边界与安全约束（P0.6）

- **权限**：`activeTab`、`scripting`、`contextMenus`；`optional_host_permissions: ["https://*/*"]` 仅声明、**未在运行时申请**。
  - `activeTab`：只在用户点击扩展图标或右键菜单后临时获得当前标签页访问权，用于读取标题/网址。
  - `scripting`：仅在弹窗中用户点击「读取页面所选文字」时执行一次 `window.getSelection()`，不注入常驻脚本。
  - `contextMenus`：右键菜单两项，点击即视为用户授权。
- **禁止**：不常驻扫描网页、不声明 `content_scripts`、不读取 cookie / 密码 / 表单、不代理任意网络请求。
- **CSP**：`extension_pages: "script-src 'self'; object-src 'self'"`，不使用 `eval` / 远程脚本 / 内联脚本。
- **消息校验**：`service worker` 的 `onMessage` 先校验 `sender.id === chrome.runtime.id`，再经 `parseExtensionMessage`（zod `.strict()`）白名单校验；只处理 `PING` / `OPEN_WORKSPACE` / `CAPTURE_LINK`，未知类型直接拒绝。
- **凭据**：任何页面与 worker 都不写入、不读取供应商密钥；内置 AI 在 P7 之前为「未实现」状态，配置页明确禁用。

## 5. 数据与持久化

- **单一可编辑主库**：扩展 origin（`chrome-extension://<id>`）下的 IndexedDB `shiye`，由工作台、弹窗、service worker 共用。主库路径与共享性已在 Chrome / Edge 实测。
- **派生索引键**：IndexedDB 不能索引 `boolean` / `null`，因此写入时同步维护 `lifeState: 'active' | 'deleted'`、`unreadFlag: 0 | 1`、`categoryKey: categoryId ?? 'uncategorized'`。
- **版本与迁移**：`SCHEMA_VERSION = 2`。`version(1)` 保留旧库结构，`version(2)` 通过 `migrateV1ToV2` 补字段、生成派生键、清理 `valueLevel` / `valueReason` / `url` / `description` / `done`；迁移只补字段、不重置用户状态，失败时不建空库（工作台显示错误与重试，见 `BootError`）。
- **版本保护**：`revision`（跨上下文）与 `localRevision`（本条记录）分离；`touchOpened` 只写 `lastOpenedAt`，不递增 `revision`，避免打开一下就使 AI 结果失效。
- **事务一致性**：待看转收藏 = 「新增收藏 + 完成待看」同一 Dexie 事务；导入批次原子提交，失败整体回滚，重复提交返回 `ALREADY_APPLIED`；AI 建议逐条一个事务。
- **URL 规范化**：保守策略，仅 `http/https`，拒绝内嵌凭据，保留 path/query/hash，不合并 `http`/`https`、不去 `www`、不去尾斜线；同时保留 `originalUrl` 与 `canonicalUrl`。
- **墓碑**：软删除写 `tombstones`（含 `canonicalUrl`、`title`），回收站保留 30 天后可清理；恢复保留原分类与未读状态。

## 6. 待看与收藏

- **决定**：两者是独立实体（`readingItems` 与 `bookmarks`），不是同一记录的两种状态。
- **原因**：v2.1 明确"待看独立于收藏"；一处完成不影响另一处。
- **影响**：转收藏时用事务保证"A 新增 + B 完成"不会只成功一半；已完成待看仍可在待看历史里查看，不影响收藏页。

## 7. 跨上下文同步与版本保护

- **决定**：`packages/application/src/sync.ts` 用 `BroadcastChannel` 广播「主库已变」，工作台订阅后重新取快照；同时在 `focus` / `visibilitychange` 兜底刷新。写入方在成功路径上广播：`run()`（列表类操作）、详情抽屉保存、两个新建弹窗、弹窗保存、service worker 保存。
- **原因**：P0.2 验证时发现弹窗写入后，已打开的工作台标签页仍显示旧快照；P1 验证又发现两个工作台标签页之间同样不同步。
- **影响**：广播消息只带发送者标识与时间，**不含任何收藏内容**；接收方忽略自己发出的消息，不会形成刷新回环；频道不可用时静默降级为聚焦刷新。
- **配套决定（数据安全）**：详情抽屉保存必须用「打开抽屉那一刻的版本号」`baselineRevision` 做期望版本，不能用实时最新的 `localRevision`。否则跨上下文自动刷新会让旧草稿带着新版本号提交，版本比较永远通过，导致静默覆盖别人的修改。冲突时提示并需用户显式点「载入最新版本」（见 [P1 验证记录](verification/p1-browser-verification.md#本轮发现并修复的两个真实缺陷)）。
- **配套决定（可读性）**：弹窗内的写入失败原因必须常驻在弹窗里，不能只发 toast —— toast 几秒后消失，用户无法判断是否已保存。

## 8. 尚未决定 / 待外部条件

- **AI 供应商与协议细节**：P7 需要真实端点、认证方式、模型与 JSON 输出能力；在用户提供并授权凭据前保持「未实现」，不写假实现。
- **真机快照**：手机真机打开方式（文件 App / 云盘 / 直接收文件）尚未验证。
- **v1b 云同步**：明确未纳入本轮，不写任何云请求代码。原技术说明第 12 章已给出轮廓——**Worker + D1 是唯一可选同步后台**，OneDrive 仅作备份；服务端 revision、每条记录的最新 `changeVersion`、按版本增量游标、最小墓碑；`dbEpoch` 在 pull 返回、push 携带并在事务内校验，恢复旧备份或重建历史时主动换 epoch，纪元不匹配则暂停所有未确认写入（含扩展收集队列），保留本地专用与草稿，重新同步后人工核对，不自动重放。`reference/d1_candidate.sql` 标注为「仅可选 v1b 的 P0 候选，未在真实 D1 验证」，D1 即 Cloudflare 托管 SQLite，未绑定其他厂商。做 v1b 需单独确认范围，它不得自动混入 v1a。分层、接口契约、冲突矩阵与分期见 [v1b 同步设计方案](v1b-sync-design.md)（讨论稿，未立项）。
- **v1b 会改变隐私承诺**：现在可以说「全库不上传」；一旦接云同步，就只能说「`localOnly` 与禁止 AI 的条目不上传」。这不是实现细节，是产品口径的变化，必须在立项时明确写出，并重验验收清单里「内容不出本机」相关条目。
- **v1b 与 P7 是两条独立的线**：P7 内置 AI 走 BYOK 时不需要任何云端服务；v1b 也不解决 AI 问题。两者目前都未启动，互不阻塞。
