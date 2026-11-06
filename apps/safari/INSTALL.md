# 拾页 Safari 本地开发包

这是原生 macOS App 包装的 Safari Web Extension，共用拾页的本地数据库逻辑、导入导出、AI 与同步代码。不是把普通网页当作 Safari 扩展。

## 安装

1. 本机已有构建好的 `Shiye.app`，不必为了填写 Cloudflare 地址重新编译。双击运行；可以把 App 保留在固定位置后再启用。
2. 在 Safari 设置的「高级」打开网页开发者功能（旧版为显示“开发”菜单）。
3. 在 Safari 的“开发”菜单或开发者设置里允许未签名扩展。这是 Apple 的本地开发流程；若系统要求密码/Touch ID，请本人完成。
4. 打开 Safari「设置 → 扩展」，勾选“拾页 · 收藏工作台”。打开 App 内“Safari 扩展设置”按钮也可以到达该页面。
5. 点击 Safari 工具栏的拾页图标，收藏页面或打开工作台。若看不到图标，在 Safari 工具栏自定中添加扩展按钮。

此包使用本机 ad-hoc 签名，不是 Apple Developer ID/公证安装包，也未提交 App Store。“允许未签名扩展”在 Safari 重启后可能需要重新开启。若希望长期安装不走开发设置，需要后续使用本人 Apple 开发者账号签名并采用 Apple 支持的分发流程；不会借用别人的证书或绕过 Gatekeeper。

## 数据与权限

- Safari 的库与 Chrome/Edge 相互独立；同一个 Safari 扩展的 popup、工作台与后台共用库。
- 迁移可使用 JSON 备份，或填写同一个 Cloudflare 地址和 publisher 同步收藏。待看仍按现有独立流程处理。
- AI Key 仍仅当前工作台内存；publisher 可主动选择在此设备记住，保存在扩展本机配置中。不进入 App 包、收藏备份或云同步；取消勾选或断开连接可清除。普通 AI 设置、后端地址可在本机保存。
- 仅收集当前网页或手动读取选中文字；模型和后端域名按需申请，拒绝后可继续使用本地功能。不要为连接一个服务而默认授权所有网站。
- 更新前请导出 JSON；本机开发包的升级持久性尚未完整验收。删除扩展或清理 Safari 扩展数据可能删除本地库，先备份。

## 开发者构建

安装 Xcode 和项目依赖后，在项目根目录运行 `npm run build:safari`。输出在 `apps/safari/dist/`；生成工程、日志与派生缓存在 `.verify/safari-build/`，不进入 Git。

构建声明最低 macOS 14 / Safari 17，仅实际测试过的版本列入验证记录；编译目标不等于旧系统已经验收。当前不包含 iOS/iPadOS 原生扩展包，手机仍使用 Cloudflare 网页。
