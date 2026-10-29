# 拾页 Shiye

一个安放待看与收藏的个人工作台。先收下，慢慢看。

## 当前状态

v1a 主体已实现并可构建：Chrome / Edge MV3 扩展 + React 工作台，数据落在扩展 origin 下的单一 IndexedDB 主库。P0–P6 已完成并留下真实浏览器证据（9 个回归脚本共 262 项断言、79 项单测）；P7 内置 AI 未实现，界面明确禁用；P6.4 手机真机与读屏播报仍待人工验证。**逐阶段进度与证据只以 [开发进度规划](docs/ROADMAP.md) 为准**，本文件不重复记录状态。

产品与技术依据位于 `resource/拾页开发交付包_v2_1/`。开发前先读其中的 `00_先读我.md`、`02_产品与技术实现说明_v2_1.md`、`03_AI开发任务书_v2_1.md`。该目录只作为输入资料归档，其中的原型、参考类型和 SQL 不作为正式实现代码。

## 方向

- v1a：Chrome / Edge MV3 扩展；React + TypeScript 工作台；Dexie / IndexedDB 为唯一可编辑主库。
- 待看与收藏是两条独立的线，共用一套 URL 去重；不引入价值等级。
- AI 默认关闭、默认人工交接：只导出材料、导入结果并逐条校验应用，不接真实模型。
- v1b Worker + D1 同步是独立可选阶段，当前不建云端工程。

## 在新机器上继续

```bash
git clone https://github.com/zqgogo/shiye.git
cd shiye
git checkout develop
npm install
```

要求：Node 20+（开发时用 22.22.2）、npm 10+。若 `registry.npmjs.org` 不可达，改用镜像：
`npm install --registry=https://registry.npmmirror.com --strict-ssl=false`。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 以开发模式打开工作台页面 |
| `npm run build` | 产出 `apps/extension/dist`（页面 + 自包含 service worker） |
| `npm run typecheck` | TypeScript 全量检查 |
| `npm test` | Vitest 单元 / 集成测试 |
| `npm run verify` | typecheck + test + build |
| `npm run verify:browser` | 真实浏览器验证共享主库与重启持久化（P0.2 / P0.3） |
| `npm run verify:import` | 真实浏览器验证书签导入与手机快照（P0.4） |
| `npm run verify:p1` | 真实浏览器验证并发、版本冲突、墓碑（P1） |
| `npm run verify:p2` | 真实浏览器验证工作台页面、待看与收藏、编辑冲突（P2） |
| `npm run verify:p3` | 真实浏览器验证扩展收集、粘贴与书签导入（P3） |
| `npm run verify:p4` | 真实浏览器验证分类、搜索与提问资料选择（P4，含 500 条造数） |
| `npm run verify:p5` | 真实浏览器验证手动 AI 交接、校验、应用与撤销（P5） |
| `npm run verify:p6` | 真实浏览器验证备份、恢复与手机快照（P6，断言真实落盘的文件） |
| `npm run verify:a11y` | 真实浏览器验证键盘焦点、Tab、Escape、长链接与小屏（整体交付） |
| `npm run verify:all` | 以上全部，共 262 项 |

手动加载扩展：`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `apps/extension/dist`。Edge 同理（`edge://extensions`）。

浏览器验证脚本依赖本机已装的 Chrome 或 Edge（通过 `puppeteer-core` 调用，不额外下载浏览器）。脚本会自动探测常见安装路径；装在非默认位置或换了系统时，用环境变量指定：

```bash
SHIYE_CHROME="/path/to/chrome" SHIYE_EDGE="/path/to/msedge" npm run verify:browser
```

`P0_BROWSER=chrome|edge` 可只跑其中一个。

## 目录

```text
apps/workspace/          扩展工作台页面（React）
apps/extension/          弹窗、service worker、manifest 与受控消息
packages/core/           领域类型与纯规则（URL、隐私、校验、导入解析、快照生成）
packages/application/    用例与仓储端口、本地搜索、跨上下文变更广播
packages/storage/        IndexedDB / Dexie 实现、schema 迁移、备份恢复
packages/adapters/ai/    AI 服务适配器（P7，默认关闭，尚未实现）
fixtures/                脱敏测试样例（书签 HTML、旧版备份）
scripts/                 真实浏览器验证脚本
docs/                    进度规划、安装说明、技术决定、未解决问题与验证记录
```

## 安装、升级与数据迁移

见 [docs/install.md](docs/install.md)：首次安装、加载扩展、升级后刷新、换机器怎么搬数据、备份恢复与卸载会怎样。**卸载扩展会连同 IndexedDB 一起删除，删之前先导出备份。**

## 亲手验一遍

自动化覆盖不到的部分（浏览器原生右键菜单、真实划词、真机快照，以及几条要眼睛判断的路径）按 [docs/manual-test.md](docs/manual-test.md) 走，19 项、30–40 分钟，附记录表。测试材料在 `fixtures/`：`bookmarks-edge.html`（重复与无效链接）、`bookmarks-deep.html`（40 层目录）、`bookmarks-hostile.html`、`legacy-backup-v1.json`（v1 迁移）。

## 已知限制

- P7 内置 AI 未实现，界面明示并禁用；接真实模型需要供应商凭据与显式授权。
- 手机只读快照只在桌面浏览器的移动视口下验证过，真机打开（P6.4）仍列为未验证。
- 右键菜单真实点击、正常页面划词读取、读屏播报尚未实测。
- 没有自动备份；数据只在一个浏览器 profile 内共享，两个 profile 之间不同步。
- 验证记录里的未验证项一律标注「未验证」，不当作通过。

未解决的问题、数据风险与下一步见 [docs/open-issues.md](docs/open-issues.md)，验收清单的逐项对照见 [docs/verification/delivery-acceptance.md](docs/verification/delivery-acceptance.md)。
