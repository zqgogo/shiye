# 拾页 Shiye

一个安放待看与收藏的个人工作台。先收下，慢慢看。

## 当前状态

当前为 **v0.2 预览版**：Chrome / Edge 扩展中的本地收藏工作台、弹窗快速访问、自配模型的问答/全范围分片整理，以及用户自有 Cloudflare 的双机收藏同步、手机只读视图与其他设备提交收件箱。真实双机使用、大库配额和 Safari 发布仍有后续验收；不把本地模拟验证当作云端/真机验收。**逐阶段进度与证据只以 [开发进度规划](docs/ROADMAP.md) 为准**。下一版方案见 [v0.2 计划](docs/v0.2-cloudflare-ai-plan.md)，部署自己后端见 [Cloudflare 说明](docs/deployment/cloudflare-s1.md)。

产品与技术依据位于 `resource/拾页开发交付包_v2_1/`。开发前先读其中的 `00_先读我.md`、`02_产品与技术实现说明_v2_1.md`、`03_AI开发任务书_v2_1.md`。该目录只作为输入资料归档，其中的原型、参考类型和 SQL 不作为正式实现代码。

## 方向

- v1a：Chrome / Edge MV3 扩展；React + TypeScript 工作台；Dexie / IndexedDB 为唯一可编辑主库。
- 待看与收藏是两条独立的线，共用一套 URL 去重；不引入价值等级。
- AI 默认关闭；保留人工交接，可自配 DeepSeek / Chat Completions 服务，测试并主动开启后确认发送。
- Cloudflare Worker + D1 为可选私有镜像，代码与模板位于 apps/worker；S2 双向同步单独实施。

## 在新机器上继续

```bash
git clone https://github.com/zqgogo/shiye.git
cd shiye
git checkout develop
npm install
```

要求：Node 22.13+、npm 10+；本轮使用 Node 25.2.1。正式测试使用 Node 内置 SQLite，Wrangler 为锁定的开发依赖。

接手前按顺序读四份：`docs/ROADMAP.md` 的「当前进度」看做到哪、`docs/next-step-cloudflare-ai-implementation.md` 看下一阶段（自有 Cloudflare 后端、自配 AI、Safari 支持）的要求、`docs/import-rollback-and-bulk-cleanup-design.md` 看撤回与清理的场景与已定默认值、`docs/purge-by-criteria-design.md` 看 P9 的分层与接口。进度只在 ROADMAP 维护。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 以开发模式打开工作台页面 |
| `npm run build` | 产出 `apps/extension/dist`（页面 + 自包含 service worker） |
| `npm run build:worker` | 本地打包 Worker 与手机页面，不部署 |
| `npm run cloud:prepare` | 本地准备自有后端配置和独立应用凭据 |
| `npm run cloud:doctor` | 离线检查部署配置与凭据 |
| `npm run cloud:login` | 登录用户自己的 Cloudflare |
| `npm run cloud:deploy` | 创建/复用 D1 并部署 Worker 与手机查看/提交页，不上传收藏 |
| `npm run cloud:verify` | 在线只做鉴权及身份检查，不上传记录 |
| `npm run verify:cloud-runtime` | 官方 workerd / D1 本地集成测试 |
| `npm run verify:connections` | 配置保存/验证/开启/修改/失效、密钥不落盘与小屏状态显示 |
| `npm run verify:two-way` | 两个独立浏览器验证收藏合并、删除、冲突和隐私撤回 |
| `npm run verify:cloud-inbox` | 手机提交、本机临时列表、总机接收和发布核对验证 |
| `npm run verify:cloud-publication` | 镜像续传、刷新、隐私和取消专项浏览器验证 |
| `npm run cloud:credentials` | 在 Git 忽略目录生成独立的发布/只读/提交凭据，不打印凭据 |
| `npm run verify:organize-plan` | 300 条分片、重试、续接和跨页应用/撤销专项验证 |
| `npm run verify:v02` | 快速访问、AI 与镜像手机页面专项浏览器验证（合成数据） |
| `npm run typecheck` | TypeScript 全量检查 |
| `npm test` | Vitest 单元 / 集成测试（已限制 V8 堆上限，抗内存紧张） |
| `npm run test:lowmem` | 同上，进一步降到 384 MB 堆，给浏览器别的活腾地方 |
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
| `npm run verify:all` | 以上全部（各项断言数以各次运行报告为准） |

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
- **内存紧张的机器上跑验证**：`npm test` 已把 V8 老生代限制在 768 MB（`--max-old-space-size=768`），进一步吃紧时用 `npm run test:lowmem`（384 MB 堆 + 小 semi-space）。浏览器回归一次只跑一套，不要把 `build` 与验证串成一条命令。若 Windows 提交量打满，进程会被系统终止，表现为「闪退」或 `Fatal process out of memory: Zone` 而非用例失败；常见原因是 `PagefileOnOsVolume` 这个注册表值把分页文件锁在系统盘（详见 [docs/ROADMAP.md](docs/ROADMAP.md) 的 2026-10-31 记录）。

未解决的问题、数据风险与下一步见 [docs/open-issues.md](docs/open-issues.md)，验收清单的逐项对照见 [docs/verification/delivery-acceptance.md](docs/verification/delivery-acceptance.md)。

家里与工作电脑同步收藏的使用步骤与范围见 [双机同步说明](docs/two-computer-sync.md)。

配置状态、修改入口与保存边界见 [配置管理说明](docs/verification/connection-status-2026-11-05.md)。
