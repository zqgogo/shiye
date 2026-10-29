# 安装、升级与数据迁移

面向「拿到源码，自己装一份用」的场景。进度与验收证据在 [开发进度规划](ROADMAP.md) 与 [验收逐项回归](verification/delivery-acceptance.md)，本文只讲怎么装、怎么升、数据怎么搬。

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| 浏览器 | Chrome 或 Edge，需支持 Manifest V3（Chrome 116+ 起均可；开发与验证用 Chrome 156） |
| Node | 20 以上，开发时用 22.22.2 |
| npm | 10 以上 |
| 磁盘 | 依赖约 300 MB（`node_modules` 为主），构建产物 `apps/extension/dist` 约 1 MB |

不需要数据库、不需要账号、不需要联网运行。数据全部落在扩展 origin 下的 IndexedDB。

## 2. 首次安装

```bash
git clone https://github.com/zqgogo/shiye.git
cd shiye
git checkout main        # 稳定版；开发中的改动在 develop
npm install
npm run build
```

`npm install` 卡在 `registry.npmjs.org` 时改用镜像：

```bash
npm install --registry=https://registry.npmmirror.com --strict-ssl=false
```

`npm run build` 会产出两个东西：工作台页面与弹窗（`apps/extension/dist/assets/*`）和一个**自包含**的 service worker（`apps/extension/dist/service-worker.js`，不引用外部 CDN）。

加载扩展：

1. Chrome 打开 `chrome://extensions`（Edge 为 `edge://extensions`）；
2. 右上角打开「开发者模式」；
3. 点「加载已解压的扩展程序」，选 `apps/extension/dist`；
4. 记住扩展 ID —— 数据就挂在 `chrome-extension://<这个 ID>/` 下。

> 想固定扩展 ID（换机器后仍能认回同一份数据），可以在 `manifest.json` 里填 `key`。当前仓库没有填，所以**换机器或重新加载到别的目录后 ID 可能变**，数据不会自动跟过去——这也是备份存在的意义。

打开方式：点工具栏图标弹小窗，或在小窗里进「打开工作台」看完整界面。

## 3. 升级

```bash
git pull                # 或 git checkout 新 tag
npm install             # 依赖有变动时必须
npm run build
```

然后到 `chrome://extensions` 点这张卡片上的**刷新**按钮（改了 `dist` 就必须点，否则跑的还是旧代码）。

数据不用动：库版本升级由 Dexie 的 `version().upgrade()` 在打开时自动完成。当前 `SCHEMA_VERSION = 2`，从 v1 升上来时会补齐字段、重算派生索引键、清掉历史遗留的价值等级字段（`valueLevel` / `valueReason`），失败会整体回滚而不是留下半套结构。

`chrome://extensions` 上出现「清单文件缺失或不可读」时，多半是 `apps/extension/dist` 被删了，重新 `npm run build` 即可。

## 4. 换机器 / 换浏览器配置文件

数据不会跟着扩展 ID 走，所以换环境只有一条正路：**先导出，再恢复**。

1. 旧环境：工作台 →「备份 / 恢复 / 手机快照」→ 勾选「包含本地专用条目」（**只有确定这台机器安全时才勾**）→ 导出完整 JSON；
2. 新环境：装好扩展、打开数据页 → 选择这个 JSON → 先看预览的条数与导出时间 → 选「替换」→ 勾选确认 → 恢复；
3. 恢复完成后面板会提示「主库身份已切换」，并说明旧设备或旧配置上的 AI 交接映射已失效——此时不要再用旧环境继续写，否则两份库会分叉。

合并和替换的区别：

- **合并**：按 ID 去重，只加新条目，同 ID 保留本机现有版本（本机改动不会被旧备份覆盖）；
- **替换**：清空当前主库后按备份重建，**替换前会自动导出一份安全备份**，面板会显示它的导出时间与收藏/待看/分类/标签条数，文件在浏览器下载目录里。

备份文件名形如 `shiye-backup-20261029-123752.json`，精确到秒——同一天导出多次不会互相覆盖。

## 5. 日常备份与恢复

- **备份**：数据页「导出完整 JSON」。默认不含本地专用条目，并在文件里写明 `includesLocalOnly: false`。已删除条目和墓碑会一起导出，避免恢复后被旧数据复活。
- **恢复**：同上，先预览再选合并或替换。未知的新版备份（`schemaVersion` 高于本机）会被拒绝并提示升级扩展；损坏 JSON 会提示「文件不是有效的 JSON」，主库不受影响。
- **本地专用条目**（`localOnly`）：默认不进备份、不进手机快照、不进 AI 材料包。要备份它们必须显式勾选。
- **手机上翻**：数据页「导出可搜索 HTML」，得到一份纯静态、不加载任何外部资源的 HTML，用手机浏览器直接打开，支持分类 + 关键词组合筛选。它是**只读快照**，别人拿到这个文件就能读到里面的标题和链接，分享前请确认内容。

## 6. 卸载与清数据

在 `chrome://extensions` 移除扩展，**该 origin 下的 IndexedDB 会一起被删除**，且不可恢复。移除前请先导出备份。

只想清空内容而保留扩展：数据页用「替换」恢复一份空备份，或在 `chrome://extensions` 里用扩展详情页的「清除数据」。

## 7. 验证自己装得对不对

```bash
npm run verify        # typecheck + 68 项单测 + build
npm run verify:p6     # 备份、恢复与手机快照
npm run verify:a11y   # 键盘、焦点、小屏
npm run verify:all    # 全部 262 项，约 10 分钟
```

脚本用本机已装的 Chrome / Edge（通过 `puppeteer-core`，不额外下载浏览器），跑在独立 profile 里，**不会碰你日常用的那份数据**。报告写到 `.verify/reports/`。

## 8. 已知限制

- **内置 AI 未实现**（P7）：界面明确禁用，只能走「手动交接」——导出材料、自己粘给任意 AI、再把回复贴回来逐条校验应用。凭据相关的东西一概没有，所以现在也不存在密钥泄露面。
- **手机快照只在桌面浏览器的移动视口下验证过**，真机打开（P6.4）仍是未验证项。
- **右键菜单与「读取所选文字」**走的是与弹窗相同的消息通道，通道本身在 `verify:p3` 里验证过（`CAPTURE_LINK`），但真实右键菜单点击、划词读取的浏览器权限交互仍需人工确认。
- **云同步、账号、手机在线编辑**不在本轮范围（另行立项）。
- 数据只在**一个浏览器配置文件**内共享；同一浏览器的多个工作台标签页会通过广播保持同步，两个不同 profile 之间不会。
- 没有自动备份。删了扩展或清了数据就是真没了，请自己定期导出。
