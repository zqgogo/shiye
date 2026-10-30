# P0.2 / P0.3 真实浏览器验证记录

- 任务：P0.2（扩展与主库）、P0.3（重启验证）
- 日期：2026-10-27
- 关联规划：[ROADMAP](../ROADMAP.md#p0--最小工程与关键能力验证)、[P0 准备清单](../P0.md)
- 原始证据：运行后在 `.verify/reports/p0-browser-verification.json` 生成（含每条检查的通过状态与实测值）。该文件是运行产物，不入版本库。
- 复现命令：`npm run build && npm run verify:browser`

## 环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows（本机开发环境） |
| Node | 22.22.2 |
| Chrome | 155.0.8059.86（`C:\Program Files\Google\Chrome\Application\chrome.exe`） |
| Edge | 148.0.3967.54（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`） |
| 扩展产物 | `apps/extension/dist`（`manifest_version: 3`） |
| 权限 | `activeTab`、`scripting`、`contextMenus`；可选主机权限 `https://*/*`（未申请） |
| 驱动方式 | puppeteer-core 23.11.1，无头模式（`headless: true`），独立 user-data-dir |

## 加载方式（重要差异）

Chrome 137 起移除了 `--load-extension` 的命令行加载能力，Chrome 155 上该开关无效（已实测：只带该开关时浏览器内不存在任何 `chrome-extension://` target）。因此本验证按浏览器分别采用两种加载方式，并在报告中逐条记录：

- **Chrome（cdp）**：启动参数 `--enable-unsafe-extension-debugging`，随后通过 CDP 命令 `Extensions.loadUnpacked { path }` 加载未打包扩展，返回扩展 ID。
- **Edge（flag）**：`--load-extension=<dist> --disable-extensions-except=<dist>`（Edge 148 仍支持），扩展 ID 从 `service_worker` target 的 URL 取得。

两种方式得到的扩展 ID 一致：`mcnapmoocnjbhefcaolbnpkibplphgji`（由扩展目录路径派生，故同一目录在不同浏览器、不同会话中稳定）。

> 对用户安装流程的影响：以上仅影响自动化验证。真实用户是通过 `chrome://extensions` / `edge://extensions` 的「加载已解压的扩展程序」手动加载，不受该开关影响，P0.6 的安装说明按手动加载编写。

## 主库位置

两个浏览器中主库都位于扩展 origin 下：

```text
<user-data-dir>/Default/IndexedDB/chrome-extension_<扩展ID>_0.indexeddb.leveldb
```

即 `chrome-extension://<扩展ID>` 这个 origin 的 IndexedDB。IndexedDB 实际版本号 `20` 是 Dexie 把声明的 `version(2)` 乘以 10 的结果，不是 schema 版本写错。库内共 14 个 object store（bookmarks、readingItems、categories、tags、settings、policies、tombstones、aiTasks、handoffBatches、handoffItems、appliedChanges、importBatches、importItems、meta）。

## 验证步骤与结果

脚本 `scripts/verify-p0.mjs` 对每个浏览器执行 19 项检查，全部通过。

| # | 检查 | Chrome | Edge |
| --- | --- | --- | --- |
| 1 | 启动浏览器并加载扩展（记录版本/模式/策略/ID） | 通过 | 通过 |
| 2 | 工作台 `workspace.html` 渲染出侧栏与首页，未出现「主库无法打开」 | 通过 | 通过 |
| 3 | 通过工作台弹窗新建收藏「P0 验证·工作台写入」 | 通过 | 通过 |
| 4 | 工作台侧读主库能读回该记录 | 通过 | 通过 |
| 5 | `popup.html` 渲染出收藏表单 | 通过 | 通过 |
| 6 | **popup 读到工作台刚写入的收藏**（同 origin 同库） | 通过 | 通过 |
| 7 | 工作台切换到「全部收藏」并显示该记录 | 通过 | 通过 |
| 8 | 通过 popup 新建收藏「P0 验证·弹窗写入」 | 通过 | 通过 |
| 9 | popup 侧读主库能读回两条记录 | 通过 | 通过 |
| 10 | **弹窗写入后已打开的工作台自动更新**（无需手动刷新） | 通过 | 通过 |
| 11 | **service worker 上下文读同一主库（两条都在），PING 通道可用** | 通过 | 通过 |
| 12 | 工作台重新加载后两条记录都在 | 通过 | 通过 |
| 13 | 会话 A 无页面脚本错误 | 通过 | 通过 |
| 14 | 定位主库物理文件 | 通过 | 通过 |
| 15 | 重启后扩展 ID 稳定 | 通过 | 通过 |
| 16 | **重启后主库数据仍在**（2 条） | 通过 | 通过 |
| 17 | 重启后工作台列表渲染出两条记录 | 通过 | 通过 |
| 18 | 重启后 service worker 仍读到同一主库 | 通过 | 通过 |
| 19 | 会话 B 无页面脚本错误 | 通过 | 通过 |

数据全部为脱敏样例（`https://example.com/...`），未读取任何真实收藏。

## 本轮验证暴露并已修复的问题

1. **跨上下文快照过期**：弹窗写入主库后，已打开的工作台标签页仍显示旧快照（首次运行的第 10 项检查失败）。修复方式：
   - `packages/application/src/sync.ts` 新增 `notifyDataChanged()` / `subscribeDataChanged()`，用 `BroadcastChannel` 广播「主库已变」，消息只带发送者标识与时间，不携带任何收藏内容；
   - 弹窗保存成功、service worker 右键菜单保存成功、`CAPTURE_LINK` 写入成功后各广播一次；
   - 工作台订阅该广播，并在 `focus` / `visibilitychange` 时兜底刷新快照（频道不可用时仍能更新）；
   - 顺带补上 `hashchange` 路由同步，使 `workspace.html#inbox` 这类外部入口和浏览器前进/后退都生效。
2. **脚本自身的验证方式错误**：最初用「改 hash 再 `goto`」当作刷新，实际是同文档导航不会重新读库；已改为显式 `page.reload()`，并单独增加「无需刷新自动更新」这一项。

## MV3 生命周期相关结论

- 无头模式下 `service worker` 能被 CDP 观察到，且**在未收到消息时也可能已被回收**：脚本在读取 worker 前先由工作台发送一次 `PING` 唤醒，唤醒后再读取主库成功。说明 worker 休眠/唤醒不影响主库数据，写入只发生在用户主动操作时，符合「不常驻」的设计。
- 重启浏览器后扩展 ID 不变、主库数据保留，说明主库并未绑定某次 worker 生命周期，也没有被写入 `chrome.storage.session` 这类易失区。
- popup、service worker、工作台三者共享同一 IndexedDB 的结论，是在**同一浏览器进程内的三个不同上下文**中各自用原生 `indexedDB.open('shiye')` 读出同一批记录得到的，不是通过应用代码自证。

## 未覆盖 / 未验证

- **手动安装路径**：真实用户在 `chrome://extensions` 点击「加载已解压的扩展程序」并勾选「固定」的流程未在自动化中复现（自动化走 CDP/命令行）。P0.6 的安装说明按手动流程编写，需用户首次安装时确认。
- **可选主机权限授予**：`optional_host_permissions` 的运行时申请弹窗未触发、未验证（当前实现不需要它即可工作）。
- **真实右键菜单点击**：`contextMenus.onClicked` 的菜单项创建与点击未在自动化中触发（需要真实用户手势）。右键菜单的实际行为列入 P3 待验证。
- **所选文字读取**：`chrome.scripting.executeScript` 读取选区的路径需要真实页面与真实选中操作，未在无头环境中验证。
- **移动端**：手机真机未参与本轮验证（见 P0.4 记录）。
- **AI 供应商请求**：无凭据，未验证（P7）。

以上未验证项不影响 P0.2 / P0.3 的结论，均已在 [P0.md](../P0.md) 中保留为待验证。

## 复现步骤

```bash
npm install                 # 干净检出后
npm run build               # 生成 apps/extension/dist
npm run verify:browser      # Chrome + Edge 各跑 19 项检查
```

脚本先尝试无头模式，取不到扩展 ID 时自动退回有界面模式，并在 JSON 报告中记录实际使用的模式；`.verify/` 下的浏览器 profile 已被 `.gitignore` 忽略。
