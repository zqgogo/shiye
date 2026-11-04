# 部署自己的 Cloudflare 私有记录镜像（S1）

这是当前单写端发布、手机只读的实现。不是双向同步，不代理 AI，不上传备份或完整正文。部署资源和费用归你自己的 Cloudflare 账号。

## 准备

本地使用仓库锁定的 Wrangler 4，执行 `npm ci`。SQL 协议测试用 Node 内置 SQLite，需要 Node 22.13+（本轮使用 Node 25.2.1）；扩展构建照旧。

```sh
npm run build:worker
npm run cloud:credentials
cp apps/worker/wrangler.jsonc apps/worker/wrangler.local.jsonc
npx wrangler login
npx wrangler d1 create shiye-private-library
```

把创建结果中的 database_id 填入 `apps/worker/wrangler.local.jsonc`，也可调整独立 Worker 名。不要把 Cloudflare 管理 API token 填进插件。`wrangler.local.jsonc` 与本地凭据目录均已被 Git 忽略。

## 初始化与部署

下面的 remote 命令会操作你自己的远端资源，请核对账号和数据库名称后再运行。`cloud:credentials` 生成的 publisher.txt 是扩展发布凭据，reader.txt 是手机只读凭据；其余 SHA256 文件只用于 Worker secret。不要互换两种凭据。

```sh
npx wrangler d1 migrations apply shiye-private-library --remote --config apps/worker/wrangler.local.jsonc
npx wrangler secret put WRITE_TOKEN_SHA256 --config apps/worker/wrangler.local.jsonc < .verify/cloudflare-setup/WRITE_TOKEN_SHA256.txt
npx wrangler secret put READ_TOKEN_SHA256 --config apps/worker/wrangler.local.jsonc < .verify/cloudflare-setup/READ_TOKEN_SHA256.txt
npx wrangler deploy --config apps/worker/wrangler.local.jsonc
```

初次设置 secret 时 Wrangler 可能先创建 Worker 的草稿，之后 deploy 会上传代码和私有网页静态资源。也可先 deploy 再设置 secret；两份 secret 配齐前 API 拒绝服务。源码中不含任何共享账号、固定服务器或可用凭据。

## 插件与手机

1. 重新加载扩展，打开工作台侧栏「Cloudflare 镜像」。填刚部署的 HTTPS 根地址，以及 publisher.txt 中的应用凭据。点击测试连接并授予该域名权限；握手不会上传收藏。
2. 准备发布预览。核对实际白名单内容、目标库和条数，再确认上传发布。按最多 50 项及 180 KB 分片，完整镜像上限 50000 项（含分类和标签）/24 MB。
3. 手机打开同一个 HTTPS 根地址，填 reader.txt。登录后通过 HttpOnly / Secure / SameSite=Strict cookie 只读访问（浏览器 cookie 8 小时），可以搜索、筛选分类、打开网址及退出。发布凭据不能用于手机登录；手机 cookie 不允许写接口。
4. 电脑修改后再次手动发布。删除和转为本地专用只有再次发布成功后才从云端撤回，离线不会擦掉云端旧镜像。需要立即取消共享时使用「清空云端镜像」。断开插件只清本页凭据，不清云端。

未读取网页正文；不包含备注、摘录、来源历史、AI 会话/任务、Key、暂存和日志。云端保存的是可读记录，并非端到端加密备份。Cloudflare 账号所有者及其平台权限仍可访问 D1；自己的账号不等于消除所有网络风险。

## 故障与维护

- 上传中断：active 指针不变，手机仍读旧版本。本页保留计划时可手动重试同一编号；重试相同分片幂等，发布成功但响应丢失也能核对。关闭页面后计划不持久续传，重新打开先连接核对再创建新计划。
- 多标签页竞争：同基线只允许一份发布成功；另一份返回冲突并要求重新预览。不会悄悄覆盖新镜像。
- 首次上传或修改隐私后仍应检查手机实测结果。旧已发布版本与放弃上传随成功发布一并删除；未完成上传在后续创建计划时清理超过 24 小时的内容。空闲期间不会自动清理，必要时手动清空。
- 凭据轮换：重新生成各角色随机 token，更新对应 SHA256 secret，并在相应设备重新输入。旧 token 即失效；不提供单设备独立撤销管理界面。保护本机凭据文件，不通过 URL 传递。
- 备份 D1：使用 Cloudflare 提供的导出或恢复工具。不要直接编辑身份/epoch；后续若设计重置流程，必须更换身份并让旧客户端停下。
- API 和静态页面明确 no-store，不安装 Service Worker、不持久缓存私有内容。关闭/退出页面清空当前 DOM 数据；浏览器、操作系统及离线旧设备的已有副本不受云端删除控制。
- 最终发布校验需完整读取/校验镜像，规模大时应使用并实测适当 Workers 计划；本轮不承诺免费 CPU 额度覆盖最坏样本。国内网络可达性需要用最终域名实测。

本地验证不等于已完成真实 Cloudflare 部署，也不等于 iOS Safari 真机验收。协议 SQLite 测试、Worker dry-run 与扩展浏览器测试记录见本轮实施报告。
