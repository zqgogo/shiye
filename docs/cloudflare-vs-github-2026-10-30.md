# 自有后端配置与 Cloudflare / GitHub 选型

调研日期：2026-10-30。用户新增要求：后端应可配置，使用者能够部署到自己的 Cloudflare 账号，不依赖开发者提供的统一服务。本文件是选型与产品约束，未创建或部署资源。

## 建议结论

推荐组合：**GitHub 保存项目源码和部署模板；用户自己的 Cloudflare Workers + D1 承担私有镜像/同步后端；GitHub 私有仓库备份作为可选后续能力。**

GitHub 也能满足“单台电脑写入、手机查看一份数据文件”，不是技术上做不到。但若目标包含后续双向同步、逐条版本守卫、权限和撤回，Workers + D1 更适合作为默认后端。这是基于产品需求和平台能力的架构判断，不是已部署的性能结论。

## 三种不同的 GitHub 用法

| 方案 | 能做什么 | 对拾页的判断 |
| --- | --- | --- |
| GitHub Pages | 发布 HTML/CSS/JS 静态页面 | 可以承载不含私人数据的界面，不能单独替代鉴权与动态同步 API |
| 私有仓库 + GitHub Contents/Git API | 授权后读取/提交数据文件，有版本历史 | 可做备份、手动搬运或单写端镜像；双向同步需要另一套文件版本和冲突协议 |
| GitHub Actions | 自动构建和部署、执行备份任务 | 可辅助发布到 Cloudflare，不能把构建流水线当成每次收藏写入的数据库接口 |

GitHub 官方将 Pages 定义为静态托管。私有源码仓库不等于发布出来的网站自动私有；Pages 的私有发布访问控制面向 GitHub Enterprise Cloud 组织条件。[Pages 定义](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[访问控制条件](https://docs.github.com/en/enterprise-cloud@latest/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site)

因此，不要把包含收藏标题/网址/备注的 HTML 或 JSON 发布到普通公共 Pages；可以让静态界面运行时向受保护 API 请求数据。

## 两个平台的实际取舍

| 维度 | 自有 Cloudflare Workers + D1 | 自有 GitHub 私有仓库 |
| --- | --- | --- |
| 前期部署 | 需要部署 Worker、建 D1、初始化权限 | 不用部署 API 服务，但要配置专用私库和授权 |
| 数据保存 | 数据库记录 | 仓库文件与提交历史 |
| 单写端手机查看 | 合适，需要只读页面与认证 | 可行，需要通过 API 授权读取私库，或在用户自己的应用里查看 |
| 双向编辑 | 可以在服务端落实版本/epoch/CAS 事务 | 可用文件 SHA 或分支 HEAD 做并发守卫，但要自写文件同步、合并与确认逻辑 |
| 权限 | 应用可设计读/写/重置范围及设备撤销 | 可用仓库 Contents 读/写权限；若自行签发更细权限，需要额外服务 |
| 隐私撤回 | 可控制在线记录和应用保留期，仍需说明数据库备份与离线副本 | 删除当前文件不自动清除旧提交中的内容，需要额外处理历史 |
| 持续维护 | Worker、数据库迁移、会话和额度 | API token、仓库历史、文件大小及应用冲突规则 |
| 后端迁移 | HTTP 协议可替换，数据/凭据仍需迁移 | 不能无成本套进现有 push/pull 后端，需要单独 GitHub 文件存储适配器 |

GitHub 更新已有文件需要当前 blob SHA；Contents API 并发创建/更新与删除可能冲突。细粒度 token 可限制到指定仓库及 Contents 权限，但不能因此假设只授权了某一个数据文件。[Contents API](https://docs.github.com/en/rest/repos/contents)

GitHub 私库历史适合找回旧版本，同时也意味着“把一个文件删掉”并不等于历史内容消失。[清除仓库历史中的敏感数据](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)

## 免费额度与成本

- Cloudflare Workers Free 的动态请求额度为每日 100,000 次，HTTP CPU 每次 10ms。应以真实鉴权、JSON 校验和最大数据量压测，不承诺个人使用永远免费。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- D1 Free：每日 500 万行读取、10 万行写入；账号总存储 5GB，但**免费单库上限是 500MB**，不能混为一个数字。索引和扫描方式会影响计费行数。[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)
- GitHub Free 支持私有仓库；普通用户授权 REST 请求通常为每小时 5,000 次，另有二级限流。对个人低频备份，额度往往不是主要矛盾；文件同步语义、凭据使用体验和历史保留更关键。[GitHub 套餐](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)、[API 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- 无论用哪家，国内目标网络的可达性需要实测最终域名/API；本次没有做网络稳定性或手机实测，不给出哪家在所有网络都更快的结论。

## “用自己的 Cloudflare”应怎样做

### 部署与运行时配置分开

**部署阶段**：用户在自己的 Cloudflare 账号创建 Worker、D1 和应用密钥。提供官方 Deploy to Cloudflare 按钮和 Wrangler 手动部署说明两条路径。

当前官方部署按钮支持从公开 GitHub/GitLab 仓库启动部署，并按 Wrangler 配置创建包括 D1 在内的资源。项目仍需提供正确绑定、迁移命令、初始化凭据和升级说明，不能把“平台支持自动创建”当成项目已实现一键交付。[官方部署按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

**拾页运行阶段**：用户只配置自己的后端地址，并通过应用配对或应用访问凭据登录。Cloudflare 账号管理 token、D1 数据库 ID 和绑定凭据属于部署管理配置，不应作为收藏同步的日常登录材料。

| 配置 | 放在哪里 |
| --- | --- |
| 后端 HTTPS 地址 | 拾页连接设置 |
| 协议版本、serverId、libraryId、epoch | 连接测试/配对握手返回，绑定到连接配置 |
| 应用写入/只读凭据 | 各设备可信上下文，按权限分开；不进入导出或公开页面 |
| Worker 名称、Cloudflare account ID、D1 绑定 | 部署配置 |
| 服务端认证密钥、初始化密钥 | 用户自己的 Worker secrets；不提交到代码仓库 |
| Cloudflare 部署授权 | 用户自己的部署流程/凭据环境，不进入拾页运行时 |

Worker secrets 可由用户在其部署环境配置。[官方 Secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)

### 建议的连接流程

1. 选择“仅本地”或“连接自有后端”。不配置时保留现有全部本地功能。
2. 填后端地址，测试 HTTPS、协议版本及服务身份；测试请求不携带收藏。
3. 配对/登录，显示库身份、设备权限及数据将上传到的域名。
4. 明确确认首次发布或首次拉取；不能连接测试一成功就静默上传全库。
5. 显示上次成功时间、待上传数、错误原因，支持暂停、断开和撤销设备。
6. 手机使用同一套用户自有服务下的只读页面和只读凭据。

### 切换服务器必须是显式迁移

同步 cursor、服务端版本、outbox 确认信息必须绑定 `(serverId, libraryId, epoch)`。用户修改 baseUrl 后，重新握手并核对服务身份；同域名也可能已经换库，不能只按 URL 认库。

旧凭据不能自动发给新域名，旧 outbox 不能自动重放到新库。提供“保持本地数据”“从新服务拉取”“明确迁移并上传”的选择，迁移前保留备份。本地专用数据继续留在设备，不能为了全量搬迁而默认扩大上传范围。

凭据不得进入普通备份、快照、URL 或日志。日常访问只使用应用级权限；不要求用户把 Cloudflare 账号管理 token 填进扩展。

## 如果决定只用 GitHub，最小可行范围

可以另立一个低成本的 GitHub 备份/镜像方案：

1. 每位用户配置一个**专门的私有数据仓库**，与拾页公开源码仓库分开。
2. 桌面作为唯一发布端，生成过滤后的数据 JSON，写入时检查文件 SHA；冲突或状态不确定时不强制覆盖。
3. 手机应用凭用户只读授权，通过 Contents API 读取同一已提交版本；静态界面不内嵌个人数据或 token。
4. 不承诺即时双向编辑；有编辑需求时重新设计 GitHub 存储适配器。
5. 明确历史保留行为；若增加客户端加密备份，还需独立设计密钥保存与恢复，不能只把文件改名为“加密备份”。

这一方案适合“存一份备份、偶尔跨设备看”。它确实可以不用 Cloudflare，但并不会自动省掉客户端授权、手机界面、隐私撤回和冲突处理。

## 对当前项目的建议范围

先完成可配置的自有 HTTP 后端，并交付 Cloudflare 部署模板；首期不同时实现两套不同同步协议。GitHub 继续承担源码和部署入口，私库备份保留接口但不写成已支持。若用户最终只需要低频备份，再选择 GitHub 方案即可。

这是需求约束与调研结论，不是部署授权，也不代表后端、配置页或 GitHub 备份功能已经实现。
