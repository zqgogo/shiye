# 拾页下一阶段实施说明：自有 Cloudflare 后端与自配 AI

版本：1.1。日期：2026-10-30。补充：Safari 正式支持要求。

**用途：交给开发 AI 的需求、架构、实施顺序和验收依据。当前交付仅为文档，未实现后端或模型接入，未部署资源、未使用真实 Key。**

## 0. 直接给开发 AI 的任务

在当前拾页项目上补齐两项可选能力：

1. 用户自行部署 Cloudflare Workers + D1，并在拾页配置自己的服务地址，用于私有记录镜像及后续双向记录同步。
2. 用户自行配置 AI 服务地址、模型和 API Key；优先支持 DeepSeek，兼容经验证的 Chat Completions 服务，实现直接提问与整理建议。

本地记录操作始终可用；两项功能独立启停。AI 不依赖 Cloudflare，Cloudflare 不代理 AI，不持有模型 Key。保留现有手动 AI 交接、备份与只读 HTML 功能。

**浏览器范围增加 Safari：macOS Safari Web Extension 与 Chrome / Edge 同属正式交付目标，不能只交 Chromium 构建。iPhone/iPad 的 Safari 至少完成私有只读网页的真机兼容；iOS/iPadOS 原生扩展安装包与移动端编辑器另列任务，不以网页可打开冒充扩展已支持。**

先实现 P7，再实现后端 S1，最后完成 S2 双向同步。每阶段单独验收。**S1 仅手机只读，不能据此宣称双向同步已完成。最终双向交付须 S2 通过。**

开发前检查 Git 状态及适用 AGENTS.md，保护其他任务的改动。现有参考：

- [原始同步草稿](v1b-sync-design.md)
- [同步设计评审与必须修正的问题](verification/v1b-sync-design-review-2026-10-30.md)
- [自有后端配置与平台选型](cloudflare-vs-github-2026-10-30.md)
- [最近一次本地数据安全复核](verification/independent-recheck-round4-2026-10-30.md)

本文件记录用户最新决定；与旧文档“未选 AI 供应商”“AI 与后端尚未确定”的表述冲突时，以本文件为本阶段需求依据。旧同步草稿中的恢复复用、epoch reset 等问题，必须依照设计评审修正，不能原样照搬。功能进度仍只维护 `docs/ROADMAP.md`，本文件不是第二份进度表。

## 1. 产品边界与真实的数据流

```text
收藏、待看、分类、标签、搜索、编辑、备份
                   │
                   ▼
        扩展 origin 下的本地 IndexedDB
          │                         │
          │ 用户启用记录同步          │ 用户确认一次 AI 操作
          ▼                         ▼
 同步字段白名单投影             本地筛选、隐私过滤、材料快照
          │                         │
          ▼                         ▼
 用户自己的 Workers + D1       DeepSeek / 用户配置的兼容 API
          │                         │
          ▼                         ▼
 手机私有只读页面 / 其他设备     本地显示回答 / 校验并预览建议
                                    │ 用户确认应用
                                    ▼
                              本地事务写入、可撤销
```

| 能力 | 是否联网 | 发往哪里 | 是否默认开启 |
| --- | --- | --- | --- |
| 收藏与待看编辑、搜索、导入 | 否 | 无 | 本地能力始终可用 |
| 完整 JSON、手机 HTML 导出 | 否 | 本地文件 | 用户主动导出 |
| 记录同步/镜像 | 是 | 用户配置的 Cloudflare 后端 | 否 |
| AI 连接测试 | 是 | 当前配置的模型 API | 用户点击后，仅发合成测试文本 |
| AI 提问/整理 | 是 | 当前配置的模型 API | 用户确认后，仅发本次材料 |
| 自动网页正文抓取、链接巡检、联网搜索 | 不实现 | 无 | 无 |
| AI 对话、Key、任务材料、备份文件同步 | 不实现 | 无 | 无 |

“本地优先”和“用户自有账号”能够减少集中托管，但**不等于零安全风险或 AI 完全离线**。AI 请求中的问题、标题、链接及被选择的备注/摘录会被服务商接收；Cloudflare 接收共享记录。服务商保留策略与离线设备副本不由拾页控制。产品介绍和设置页必须据实说明。

## 2. 已确定的功能范围

### 2.1 AI

- 直接提问：本地检索和资料选择 → 查看本次发送内容 → 提交 → 在工作台显示回答与来源编号。
- 直接整理：选择范围 → 本地规划完整批次 → 查看发送材料和批次数 → 提交 → 严格校验回复 → 逐条预览 → 用户应用 → 受版本保护的撤销。
- 保留手动提问包和手动整理通道，二者与直接通道复用材料、隐私和应用规则。
- 不增加网页工具、模型联网搜索、Agent、任意函数调用、自动删除、自动改隐私或后台全库分析。
- 第一期只处理用户明确选择的本地记录；没有保存正文时，不得声称模型已经读过原网页。

### 2.2 后端

- 默认部署到用户自己的 Cloudflare 账号：Worker、D1、认证密钥和数据均归用户管理。
- S1：电脑发布记录镜像，手机经授权只读查看与搜索。
- S2：电脑/扩展设备间双向记录同步，含明确的冲突裁决；此阶段单独通过验收后启用。
- 手机在线编辑及离线编辑队列后续再做；S2 不自动包含手机版编辑器。
- GitHub 保存源码与部署模板；本期不再实现 GitHub 私库同步或备份后端。

### 2.3 Safari 与跨浏览器要求

1. **macOS Safari 扩展是必需项**：本地收藏/待看、收集、导入导出、记录后端连接和 P7 自配 AI 均须与 Chrome/Edge 对应能力一致。UI 使用 Safari Web Extension 的扩展页面，不另开一套普通网站当本地主库。
2. **iOS/iPadOS Safari 网页**：S1 私有只读页面、登录、搜索、分类、来源链接及退出登录必须真机可用。保留原先“不在首期实现手机 AI Key 管理、手机在线编辑器”的边界；若后续增加 iOS/iPadOS Web Extension，须交付独立包、权限流程与设备证据。
3. 平台工作包先产出能力矩阵：记录最低支持的 Safari/macOS 组合、当前稳定版本及实际测试版本；不在未验证时承诺“任意 Safari 均兼容”。最低版本由关键 API POC 决定并写入发布说明。
4. 核心规则、仓储用例与供应商协议共用；新增平台适配层封装 `browser`/`chrome` 命名空间、Promise/回调差异、runtime/tabs/action、收集菜单、scripting、权限、下载与凭据 API。页面和领域层不得新增零散的 `if Safari` 分支。
5. manifest 和构建输出按平台生成；Chromium 的最低版本、后台入口和 API 声明不能直接当 Safari 兼容结论。转换工具只用于包装与兼容检查，不能替代适配和测试。
6. popup、工作台、后台上下文在**同一个已安装 Safari 扩展**中访问同一份可编辑库；验证 IndexedDB/Dexie 的并发、事务回滚、重启和升级持久化。Chrome 与 Safari 的本地数据库彼此独立，不声称 iCloud/浏览器账号会自动同步记录；跨浏览器通过显式备份迁移或本项目记录同步。
7. Safari 后台休眠、页面切换和移动端挂起不得导致假成功或无限重试。前台 AI 的取消/结果未知语义不变，后台同步沿用持久 outbox 与可重入调度，不能假设后台长期驻留。
8. 网站访问授权按 Safari 的真实 UI 验证：收集网页权限与模型/后端网络权限分别处理，拒绝、仅临时授权、撤销后给出明确提示。不得为绕过差异默认要求所有网站访问或改走 Cloudflare AI 代理。
9. macOS 的文件导入、JSON/HTML 下载、再次保存安全副本需确认**实际文件落盘**。API 不同由平台适配器提供可验证替代操作，不以弹出窗口或点击成功当作保存成功。
10. 开发阶段提供 Safari 可复现构建/安装说明；发布阶段提供 Apple 官方支持的包装、签名与分发路径，并区分临时加载、开发包和正式安装包。当前 Apple 官方支持 Xcode 工程及相应打包工具/服务，具体选用方式按实施时工具链验证，不要求用户为连接自己的 Cloudflare 再自行编译扩展。

Safari 支持要成为验收项，而不是只在 README 加一个浏览器名称；未具备设备、签名或发布条件时分项写“未验证/未发布”，不能将整个 Safari 支持标为完成。

## 3. 两组配置与凭据隔离

### 3.1 记录后端设置

用户看到：启用开关、后端 HTTPS 地址、配对/登录入口、测试连接、当前库、设备权限、同步状态、暂停、断开和设备撤销。

运行时连接配置包括：`baseUrl`、`serverId`、`libraryId`、`epoch`、协议版本、凭据引用、设备 ID。cursor 和服务端版本必须绑定这份服务身份。

- 不要求用户在拾页填写 Cloudflare 账号管理 API token、D1 数据库 ID 或 Cloudflare 管理密钥。
- 这些属于用户部署阶段的 Wrangler 配置和授权；应用登录只使用应用级会话/设备凭据。
- 手机只读权限、桌面读写权限、重置云库权限由服务端区分。
- 测试连接不发送收藏；首次上传另行明确确认。
- 换地址或换库先暂停旧队列，重新握手核对身份；旧凭据不自动发送给新域名，旧操作不自动重放。

### 3.2 AI 设置

| 项目 | 要求 |
| --- | --- |
| 服务预设 | DeepSeek / 自定义 Chat Completions 兼容服务 |
| API Base URL | DeepSeek 预填 `https://api.deepseek.com`；其他地址用户自填 |
| 模型 | 支持“读取模型列表”和手填 ID；不锁死名称 |
| API Key | 用户输入，遮罩显示；不写进 AiConfig/主库记录正文 |
| 凭据保存 | 首期默认仅浏览器会话，重启/扩展重载后重新输入；Safari 经统一 CredentialVault 适配 |
| 功能测试 | 文本问答测试；整理所需 JSON 能力单独测试 |
| 输入/输出预算 | 按模型配置并有保守默认；显示估算，不能把字符数伪称精确 token 数 |
| 启用 | 默认关闭；同一配置测试通过后由用户主动开启 |
| 清理 | 清除 Key、关闭通道、取消在途请求；不删除已有收藏 |

模型列表接口不可用不等于聊天接口不可用：允许手填后实际测试。仅拿到模型列表不算测试通过。

配置改变时递增 `credentialVersion` 或对应配置版本。规范化端点、模型、供应商类型、Key 版本及影响请求的能力配置共同生成 fingerprint；不对明文 Key 做日志或展示。任何相关变更使测试失效，禁用发送，旧配置的迟到结果不能更新新配置的测试状态。

跨重启“记住 Key”是独立可选任务：若实施，应有用户口令派生密钥的本地加密存储与解锁流程，明文 Key 和解密口令不一起持久化。未完成前不显示假的记住开关，不把 `chrome.storage.local` 明文存储宣传成安全保险箱。

## 4. 凭据与网络执行位置

1. AI 网络请求从可信扩展工作台页面执行；首期不依赖 service worker 长时间保活。关闭页面应尽力取消请求，重新打开后把未完成任务显示为中断/结果未知，不自动再次计费请求。
2. Key 只经 `CredentialVault` 访问。Chrome/Edge 首期使用 `chrome.storage.session` 的独立凭据空间，显式限制 `TRUSTED_CONTEXTS`；Safari 先探测并验证等效 session 存储与可信上下文隔离。API 不具备相同语义时，首期降级为当前可信工作台页面的内存凭据，关闭页面重新输入并在 UI 说明；不通过明文持久化降低安全要求。不使用 `storage.sync`/iCloud 同步凭据。内容脚本不能取得 Key，也不能发起任意 URL/请求头的代请求。
3. 各平台 manifest 增加实际使用所需的 `storage` 等权限；模型和自有后端域名通过用户手势按 origin 申请可选主机权限，并实现 Safari 的授予/撤销反馈。现有 `https://*/*` 仅是可申请范围，不等于默认授予所有域名访问。
4. 使用扩展可信上下文 fetch；普通手机网页只读后端数据，不要求其持有模型 Key。本期手机不直接提供 AI 功能。
5. 默认 HTTPS；拒绝 URL 内嵌账号密码、认证查询参数和跨 origin 重定向。Base URL 保留用户指定路径前缀，只拼接一次 endpoint，不盲目补 `/v1`，不拼出 `/v1/v1`。
6. 自定义服务请求使用固定受控头及 Bearer 认证。首期不提供任意请求头/脚本编辑器，也不允许模型回复改写端点或请求其他主机。
7. 本地 HTTP 模型不在首期承诺；后续支持时需独立的 localhost 例外、权限和验证，不默认放开局域网明文地址。
8. 错误日志仅包含任务 ID、脱敏错误码、耗时与必要计数；不记录请求头、问题全文、材料全文、Key 或未脱敏供应商响应。

Chrome session 存储的生命周期和访问控制依据见附录 B；不能把其全部 API 和生命周期直接假定为 Safari 行为。它是扩展会话内存存储，不是操作系统钥匙串。Key 不进入普通 JSON、手机 HTML、云端 D1、AI 材料包、URL、content script 或 Git 仓库。

## 5. AI 适配器契约与兼容层

### 5.1 分层

```text
workspace UI
  → application：材料快照、授权、任务与结果应用
    → AiProvider / CredentialVault / NetworkTransport 端口
      → adapters/ai：DeepSeekPreset + ChatCompletionsAdapter

core：纯材料构造、预算规则、schema、隐私与回复校验
storage：本地记录、任务元数据、应用日志
Cloudflare Worker：记录服务；不实现任何 AI 代理路由
```

`packages/adapters/ai/` 当前只有 package.json；不得误认为已有适配器可直接启用。优先补端口及可替换的 fetch transport，而不是把供应商请求散落到 React。

建议的能力描述至少包括：文本聊天、模型列表、JSON object、流式输出、思考参数、输出 token 参数名、输入预算。能力测试的结果绑定配置 fingerprint，不按“兼容”二字假设全支持。

统一的模型结果至少含：最终文本、规范化 finishReason、可选 usage、可选供应商请求 ID、是否完整结束。不要把供应商原始响应作为可同步领域对象。

### 5.2 DeepSeek 预设

- 使用官方 Base URL，调用 `POST /chat/completions`，模型列表走 `GET /models`；API Key 使用 Bearer 认证。
- 模型名以用户账号实际返回和真实测试为准。2026-10-30 官方入门示例使用 `deepseek-flash`；这是当日示例，不是永久保证，不再硬编码历史模型名或价格。
- 首期提问与整理都采用非思考模式；DeepSeek 预设按官方接口显式发送 `thinking: { type: "disabled" }`。不要把这个参数发送给其他不支持它的供应商。
- 整理优先使用能力测试通过的 `response_format: { type: "json_object" }`，同时提示词明确要求 JSON 及所需结构。有效 JSON 不代表业务合法，仍走本地 Zod 校验。
- 只读取最终 `message.content`/`delta.content` 作为答案。`reasoning_content` 不当作 JSON 或最终回答，不保存或同步推理过程。
- 不启用 tools、搜索、文件上传等服务商扩展功能。

### 5.3 通用兼容服务

- 首期兼容目标是通过实际测试的文本 Chat Completions 接口，不承诺所有服务商/全部模型/所有 API 协议。
- 自定义 Base URL + 模型 ID + Key；按能力发可选参数。输出长度参数由 profile 控制，不能同时盲发多个互斥参数。
- 只有文本测试通过时可以启用问答；整理需 JSON 输出或严格文本 JSON 路径通过合成结构测试。
- 不支持 JSON object 的服务，可显式选择严格文本 JSON 模式；仍拒绝解释文字、未知字段及非法建议。模式切换需重新测试，不通过静默重试真实材料探测能力。
- 思考、temperature、usage、模型发现和 streaming 的差异逐项适配；缺失 usage 时显示“未提供”，不伪造费用。
- Anthropic 原生、Responses 等不同协议不在首期“通用兼容”的含义内；以后增加独立 adapter，不污染核心用例。

## 6. 连接测试、任务状态与错误

### 6.1 连接测试

用户点击后，先申请目标域权限，再发固定合成短文本。测试按钮说明“会产生一次少量 API 调用，可能计费”。不得携带真实收藏、分类名、标签名、策略、备注或问题。

分别测试文本完成、整理输出结构；流式功能若实现，单独验证。配置变化立即失效；测试进行中换模型或 Key，迟到响应不得把新配置标为通过。

### 6.2 执行状态

`准备材料 → 等待用户确认 → 请求中 → 响应完成 → 本地校验 → 可预览/可应用 → 完成`，另外包含失败、取消、超时、输出截断和结果未知。

- 本地保存任务 ID、操作类型、配置 fingerprint、libraryId、policyVersion、材料快照映射和最小状态；这些任务数据不云同步，不进入普通备份。
- 任务完成与最终写入分开。请求成功不代表建议已应用；同步成功不代表 AI 成功。
- Key/权限缺失时返回明确错误，页面始终能退出 busy 状态，保留问题和选择，允许手动交接。
- 401/403 提示凭据/权限，402/额度不足提示账户状态，429 提示限流，400 提示模型/参数/预算，5xx/网络错误提示服务暂不可用；不展示可能回显 Key 的原始错误 body。
- 用户取消用 AbortController；取消不保证供应商停止计费。网络超时/丢响应可能已经计费，默认不自动重发、不自动换供应商；用户明确重试前说明这一点。
- 输出 `length`、空 content、缺少终止信号或拒绝回答都不是可应用成功。整理不能把截断 JSON 修补后写库。

### 6.3 流式实现边界

先交付稳定非流式问答和整理即可；流式问答是独立体验任务。若实现，必须正确处理跨网络块 UTF-8/SSE、空 choices、usage-only 事件、`[DONE]`、思考片段、错误事件及中途取消。中断答案显示“未完成”，不得作为整理结果或完整回答缓存。

## 7. 发送前材料与隐私规则

### 7.1 AI 材料

所有 AI 通道在发送瞬间重新读取并过滤：删除、localOnly、aiBlocked 一律不发。选择器排除只是 UI 提前提示，不能替代用例层的最终检查。

- 本次可发送的字段：标题、规范化 URL、来源描述、必要分类/标签信息；人工备注与主动摘录由用户在发送预览中单独选择，默认关闭。
- 问题与整理策略也属于对外发送内容，预览应包含它们；分类/标签字典也算材料，不能假称“只发选中收藏”却额外发送全库字典。
- 目标字典只发送用户明确允许的范围；私密记录专属的分类、标签、策略示例及关联信息不得因字典/示例绕过隐私过滤。
- 不发送本机路径、历史记录、备份、Key、设备认证信息、同步冲突全文和派生索引。
- 云端记录存在不等于授权 AI 使用；切换供应商或增大发送范围需要重新确认。
- URL 原样可能含敏感查询信息，发送预览必须可见；不自动访问它抓正文。

现有 `buildAiItem`/`buildAskMaterial` 会带备注与摘录。实施时需增加明确的字段选择投影，随后手动与直接通道复用它；材料 inputHash 必须覆盖实际发送内容和相关人工状态，不能让预览与请求使用两套材料。

### 7.2 云同步记录投影

| 数据 | 默认同步规则 |
| --- | --- |
| 非私密收藏的标题、URL、来源描述、分类、标签、未读与置顶 | 可同步 |
| 相关分类/标签名称、共享字段锁定、aiBlocked | 随共享记录同步，保证另一设备仍尊重人工 AI 限制 |
| 待看标题、URL、状态与完成时间 | 可同步；关联或同网址命中本地专用时排除 |
| 人工备注、摘录 | 默认不上传，用户可在同步范围中主动启用；与 AI 发送开关独立 |
| localOnly 收藏及其衍生待看、可识别私密的删除信息 | 不上传；已上传后转私密按撤回协议处理 |
| 本机最近打开、设备设置、凭据、AI 会话/任务/材料、备份文件、网页全文 | 不同步 |
| 整理策略与示例 | 首期仅本地，不默认为同步记录；后续若开放需独立范围与隐私过滤 |

aiBlocked 的含义确定为“禁止发送 AI”，不是“禁止记录同步”；localOnly 同时禁止云同步与 AI。修正旧文档将两者混用的说明。

字段未包含与显式清空必须有不同语义：远端投影没有备注字段时，不能把本机备注清空。关闭某个共享字段后，要撤回云端旧字段，而不是停止更新却永久保留旧值。

## 8. 问答与整理的结果处理

### 8.1 问答

- 回答只依赖本次快照；来源编号映射回真实选中记录。未知编号标为无效来源，不编造收藏。
- 只展示当次快照中的安全链接；回答文本不能引导程序自动访问新网址。
- Markdown 不执行 HTML/脚本，不自动加载远程图片或嵌入；来源点击属于用户主动行为。
- 问答页面不出现直接应用分类的入口，不把自然语言回答当整理 patch。
- 首期历史只在当前页面会话保留，不自动入主库/云端；以后若提供保存，需独立显式操作。

### 8.2 整理与大范围分批

- 当前 `LIMITS.aiItemsPerPart` 为 20，属于单批本地默认容量，不是用户总选择上限，也不是模型上下文容量保证。
- 所有选中匹配项先完成完整批次规划，按条数及字符/token 预算拆分；列出总数、排除数、批次数和每批范围。不能继续“只取前 20 条，剩下让用户自己想办法”。
- 明确 `batchId + part + n` 映射与材料指纹。每批保存不可变快照，重开可核对已完成/待发送/结果未知部分；重试不得把编号映射到另一条。
- 收到完整回复后复用并加强现有 `validateAiReply`；核对协议、batch/part、编号、重复、类型、长度、分类/标签引用和字段白名单。
- 只允许 `categoryId`、`tagIds`、`aiPurpose`；不得修改 URL、人工备注、摘录、未读、待看、隐私、锁定或删除，不自行创建分类。
- 先展示建议和拒绝原因，默认仍需用户点击应用。AI 可以无建议或 needsReview，不要求为了凑数修改数据。
- 每条应用事务复核当前 libraryId、policyVersion、批次状态、localRevision、隐私、锁定与引用，再写记录和日志；hash 计算与网络在事务外，使用预期版本保证校验与提交一致。
- 内置与手动通道共享同一条写入链路和撤销逻辑；云端拉取或人工编辑后旧建议不得覆盖新内容。
- 成功与失败逐条展示，部分成功只重试未确认部分；请求响应未知不自动当成“可安全重新请求”。

## 9. Cloudflare S1：用户自有的私有记录镜像

### 9.1 部署

提供 `apps/worker/`、Wrangler 模板、D1 migrations、`.env.example`、本地开发说明和升级/回滚说明。不提交任何真实密钥。

推荐同一 Worker 同时提供私有 API 与手机静态界面；手机页面本身不内嵌个人数据。用户从 GitHub 模板部署到自己的 Cloudflare 账号，平台可自动创建 D1，但迁移、初始化、凭据生成与权限验收必须作为实际部署步骤。

初始化仅首次使用，结束后不能被匿名访问重新接管；提供撤销设备/凭据轮换。服务端从身份推导 library，不信任请求指定任意库。私有 API/HTML 数据响应明确禁止公共缓存。

### 9.2 镜像发布协议

完整协议在实施 A0 固定 JSON schema，至少有：服务信息、设备配对、创建 staging generation、上传分片、发布、读取已发布 manifest/分片、撤回与设备撤销。

- 一台指定设备作为发布者；本机多个上下文共享持久发布任务，不同时各发一套旧快照。
- 在一致本地快照中生成同步投影，分片必须有唯一编号、计数与完整性校验；重复上传同一分片不得重复计入。
- staging 上传中断，手机继续看到旧 generation；全部校验通过后原子切换 active generation。
- 手机跨页读取固定 generation，不能半路切到新版本；旧 generation 的权限与保留期明确。
- 普通记录变私密或关闭共享字段时，要推进撤回状态，处理在线旧 generation；不能只让下一次完整上传时“顺便覆盖”。发布失败时应显示撤回尚未完成。
- 不接收 AI Key、聊天材料或普通完整备份；不建 `/ai/proxy` 等转发入口。

## 10. Cloudflare S2：双向记录同步的必需契约

### 10.1 协议与字段

`protocolVersion`、`schemaVersion`、`serverId`、`libraryId`、`epoch` 必须区分。实体至少覆盖 bookmark、readingItem、category、tag；删除由同一实体 `deleted=true` 表达，不再额外创建第二套权威 tombstone 实体。

push 每操作有稳定 `opId`、entityType、entityId、baseVersion、不可变 payload 与本地操作序号；响应按 opId 对应 applied/unchanged/conflict/rejected。记录的 serverVersion 可以直接使用全库唯一的 change sequence，但不能对每行独立 +1 后又当作全局游标。

拉取接受期望 epoch 与 cursor，返回有序记录、实际落到的 nextCursor 与 hasMore。epoch 变化整请求拒绝，不能同一批部分用旧历史、部分用新历史。

### 10.2 两端事务

- 本地记录变更与 outbox 同事务；所有入口都覆盖，包括 service worker、批量导入、分类迁移、AI 应用、待看历史清理。
- ACK 只确认发送时的操作版本，不能按 entityId 清掉用户后续编辑。
- 服务端 epoch 守卫、全局版本分配、CAS、操作回执同事务；版本按提交可见顺序推进，不能在 Worker 外分配后再分开写。
- 应用 pull 时，远端 shadow、干净记录更新/冲突保存与 cursor 同事务；远端写入不再次当作本机新编辑入队。
- 有本地新编辑时保存双方；没有脏改动的记录接受远端更新或删除。不得调用现有“只新增、保留本机”的 backup merge 来实现同步。
- 移除分类/迁移引用、待看转收藏等操作明确依赖/操作组；分页未到的分类引用先暂存，不能直接清空。
- 多上下文只允许一个同步执行者；任务与租约持久化，崩溃/关闭后可重入。

### 10.3 重试、冲突与隐私

- opId 回执解决成功丢响应后的核对，旧请求重放不能覆盖后来的编辑；冲突后用户明确选择本机/远端，再基于新版本提交。
- 本地 localRevision 不由远端覆盖，AI 建议和草稿版本保护继续有效。
- 同网址不同 ID 必须与当前去重/删除规则协调；不允许普通同步绕过墓碑复活。
- 删除保留最小墓碑；GC 需要设备游标/保留期与失效重建协议，否则先不做物理回收。
- 记录转 localOnly 后，本机正文保留，云端发最小撤回；其他设备不得把旧副本再次自动上传。维护远端标记与本地私密状态，不能通过“删除自己记录”实现撤回。
- 冲突日志不保存无界全文；私密撤回覆盖云端冲突副本，访问/备份保留期说明真实范围。
- 本地恢复、重新连接和明确替换云库是三种操作。单台设备恢复 JSON 不自动 reset 全库 epoch；替换云库需独立权限、expectedEpoch、幂等操作 ID 与原子发布。

### 10.4 实施前真实 D1 POC

先提交可运行的 migration、SQL batch、并发测试和故障注入报告，验证：两个并发 push 不丢更新；reset 与旧 push 不交错成功；丢响应重试可核对；分页不漏记录。不要把示意 SQL 或内存 transport 的通过当成真实 D1 通过。

可以保留 latest-record 表，不强制引入完整 changes 历史；但 opId 回执、墓碑、cursor/epoch 和明确保留策略不能省。若使用读副本，需维护 D1 Sessions 一致性；首期可以直接走主库。

## 11. 实施任务与交付物

以下编号是工作包，不在此文维护完成勾选；执行时映射进 ROADMAP 并记录证据。

| 顺序 | 工作包 | 必须交付 |
| --- | --- | --- |
| A0 | 固定边界与端口 | AI/同步独立配置 schema、凭据端口、领域投影、测试 fingerprint、S1/S2 协议；列出与旧文档差异 |
| A0-Safari | 必需的平台 POC | Safari 平台适配与 manifest/构建方案；同扩展主库持久化、凭据隔离、收集/文件操作、按域授权和可信上下文直连模型/后端；实际版本矩阵 |
| A1 | AI 设置与 DeepSeek 适配 | DeepSeek 预设、通用 Chat Completions adapter、模型发现/手填、会话凭据、按域授权、合成测试、错误和取消 |
| A2 | 直接提问 | 发送预览、字段开关、本地选资料、真实回答与来源映射、失败保留输入；手动通道可用 |
| A3 | 直接整理 | 完整分批、实际输入快照、严格校验、逐条应用/撤销、迟到/冲突处理；补齐 P7 |
| B0 | 自有后端模板 | Worker + D1 migration、初始化、设备 scope、部署/升级/撤销说明、端点测试，不含 AI 代理 |
| B1 | 私有镜像 S1 | 桌面 staging/原子发布、手机授权查看搜索、撤回与失败提示；明确标注只读 |
| B2 | 双向协议 POC | 真实 D1 原子版本/epoch/CAS/回执证明；schema 与 API fixtures；通过后才接客户端 |
| B3 | 双向记录同步 S2 | 本地 outbox/shadow/cursor、所有写入口迁移、冲突 UI、隐私撤回、设备重连/换服务/恢复边界 |
| C | 集成验收 | Chrome/Edge/macOS Safari 的本地/AI/同步矩阵；iPhone/iPad Safari 私有网页真机；凭据隔离、真实服务、安装包与未验证项 |

建议目录：

```text
packages/core/src/ai/           纯材料、预算、schema 与指纹
packages/application/src/ai/    AI 用例与端口
packages/adapters/ai/src/       DeepSeek preset、兼容 transport、响应/错误规范化
packages/sync/                 协议、纯裁决、客户端与端口，Worker 只引用纯协议入口
packages/storage/src/          数据迁移、同步 outbox/shadow 与事务实现
apps/workspace/src/            两组设置、问答、整理和冲突 UI
apps/extension/                最小权限、可信凭据接线；不加任意代理
packages/platform/             跨浏览器端口及 Chromium/Safari 实现（可用等效模块划分）
apps/safari/                   Safari 包装/构建配置或 Xcode 工程；复用公共 WebExtension 资源
apps/worker/                   自有 Worker、D1、手机私有界面接线
docs/verification/             新增各阶段真实证据
```

现有 task/config 类型不够时显式扩展及迁移；不得把 Key 塞进 `AppSettings`、BackupDocument 或通用 settings 对象。新增同步表与设备状态只保留本地必要数据；所有普通导出仍用显式字段构造，不能全库 dump。

## 12. 验收清单

### 12.1 本地与配置

1. AI/同步均关闭时，所有现有本地能力可用且没有相关外部请求。
2. 只开 AI、只开同步、两者均开、断网四种组合均能正常本地读写。
3. 更换模型/地址/Key 后旧测试失效；迟到测试不能重新启用新配置。
4. 清除 Key、拒绝 host 权限、401、额度不足、429、超时、取消，页面均结束 busy 并保留输入。
5. 用测试 canary Key 检查日志、备份、HTML、D1、请求 URL、content script；均不得包含 Key。会话重启后 Key 消失符合说明。

### 12.2 AI

6. DeepSeek 实际文本请求成功；模型 ID 与日期、请求模式有脱敏记录。未执行则明确记“真实服务未验证”。
7. 至少两种非 DeepSeek mock profile 验证路径前缀、无模型列表、无 JSON object、可选 usage 与不同输出预算参数；真实其他服务只按实际验证列出兼容，不能宣称全兼容。
8. 连接测试抓包只含合成材料，不含任何真实或 fixture 收藏名；首次真实材料发送必须用户主动确认。
9. localOnly、aiBlocked、已删除记录及私密字典/示例不可绕过过滤；预览后改隐私，发送时重新拒绝。
10. 500 条选择全部进入计划，不因当前可见项或前 20 条限制丢失；超预算明确拆批/拒绝，不静默截断。
11. 非法 JSON、未知/重复编号、part 不匹配、未知字段、伪造分类/标签、提示注入、思考文本、截断输出均不能越权应用。
12. 预览后改策略/隐私/分类/锁定/主库/记录版本，应用事务拒绝旧建议；应用与撤销不覆盖后续人工或同步修改。
13. 回答引用只指向本次快照；恶意 HTML/链接/图片不执行或自动请求；没有保存正文时不声称已读网页。
14. 请求中关闭工作台后不自动重发；重新打开明确标记中断/未知，不重复应用。模型失败时可继续使用手动材料包。

### 12.3 后端与同步

15. 用户按文档在自己的 Cloudflare 账号部署成功，D1 初始化、升级和权限撤销可复现。
16. 手机只读 token 无法 push/reset，未登录不可读记录，账号/库 A 不能访问 B；私有数据不被公共缓存。
17. 镜像分片中断不会发布半份数据；手机完整读取一个 generation；变私密后旧在线内容按协议撤回。
18. 双向同步中修改与删除确实能到达已持有同 ID 的另一设备，不能只验证首次新增。
19. 本地写入与 outbox、ACK 与版本确认、pull 与 cursor、服务器 CAS 与 epoch 均有事务失败注入，不能出现半成功丢写。
20. 发送后用户再改，旧 ACK 不清新 dirty；成功丢响应后重试不重复应用，也不把旧内容覆盖到别人的新编辑。
21. 同网址异 ID、删除与修改冲突、分类引用跨页、待看完成历史清理、转收藏和 AI 应用均保持正确语义。
22. 已上传后改私密、关闭共享备注/摘录、离线待撤回、冲突日志、换服务与本地恢复都不扩大上传范围。
23. 两个扩展上下文并发同步、worker 中止、网络重连和 epoch 变化可恢复；旧队列不盲重放。
24. 云端请求断言只包含记录协议和应用认证，不包含 AI Key、对话、任务材料、备份文件或自动抓取的网页正文。

### 12.4 交付证据

- 保留并执行现有 `npm run verify` 与适用浏览器回归，不降低或删除已有数据安全断言。
- AI 测试用脱敏 fixture 与模拟服务；新增请求体、凭据隔离、错误/取消和供应商能力测试。
- 后端有内存协议测试、本地 Worker/D1 测试、真实 D1 并发/鉴权测试，三者分开报告。
- 真实 DeepSeek 测试须由用户在设置中输入 Key 并点击，不要求将 Key 发进聊天或仓库。开发阶段不得自行寻找本机其他应用的凭据。
- 更新安装、配置、部署、费用和隐私说明；保存版本、命令、时间、实际断言与未测范围。缺少真实服务测试不能用 mock 通过替代。

### 12.5 Safari 专项验收（必需）

25. macOS Safari 实际安装并启用扩展，popup 收集后工作台即时可见；重启 Safari 和更新扩展后数据仍在。临时扩展被系统移除的行为单独说明，不能当正式持久化验收。
26. Safari 验证同扩展内多上下文写库、URL 去重、版本冲突、快照与替换同事务、回滚和私密墓碑过滤；跨浏览器迁移不覆盖本地专用内容。
27. Safari 的 JSON/书签导入、JSON/HTML 导出、安全副本再次保存有实际文件证据；数据与交互语义不因平台变化缩减。
28. Safari 中真实授予、拒绝和撤销网页/模型/后端权限；未授权不发送，拒绝后不永久 busy，不要求访问全部网页才能使用无关本地功能。
29. Safari 真实 DeepSeek 合成测试及用户授权的提问/整理可用；不经过 Cloudflare。内容脚本读不到 Key，退出/清理后的凭据生命周期与 UI 一致。
30. Safari 中验证策略/隐私/同步变更使旧 AI 建议失效；前台页面关闭、后台休眠/唤醒后不丢队列、不重复应用或自动重新计费。
31. iPhone 与 iPad 的 Safari 私有只读网页：登录/退出、分类与关键词组合筛选、触控滚动、虚拟键盘、安全区和打开原网页；桌面模拟移动视口不代替真机。
32. 提供 Safari 构建/安装/启用/升级/卸载数据影响说明，列出实际 OS、Safari 版本、安装包类型、签名/分发状态。Chrome Puppeteer 或通用 WebKit 测试只能作为辅助，不能替代 Apple Safari Web Extension 真机证据。

最终浏览器支持表必须按 Chrome、Edge、macOS Safari 扩展、iOS Safari 网页、iPadOS Safari 网页逐项列出状态；未做 iOS/iPadOS 扩展时明确写“不在本阶段”，不得混写为移动扩展已支持。

## 13. 用户界面文案基线

- 本地模式：“收藏保存在本机；未启用同步和内置 AI。”
- 同步设置：“将你选定范围的记录发送到你配置的服务。API Key 和 AI 对话不会随记录同步。”
- AI 发送：“本次将向〔服务域名〕的〔模型〕发送问题及 N 条材料。查看发送内容。可能产生 API 费用。”
- 本地专用：“仅保存在本设备，不同步，也不发送 AI。”
- 禁止 AI：“可按同步设置共享记录，但不会作为 AI 材料发送。”
- 云端撤回中：“本机已设为本地专用，云端撤回尚未完成；连接恢复后继续处理。”

不要使用“绝对安全”“完全离线 AI”“配置自己的 Key 就不会泄露”“网页已被模型完整阅读”等不实承诺。

## 附录 A：本阶段明确不做

中央托管账号/Key、多用户协作、公开分享收藏、自动全文抓取、向量数据库/RAG 服务、模型工具调用、自动后台全库 AI、AI 云代理、手机 AI Key 管理、GitHub 同步、默认遥测、任意第三方插件脚本。

## 附录 B：实现时核对的官方依据

以下按 2026-10-30 官方文档核对，实施时重新验证模型和能力；不把当日模型名、限制或参数当永久事实。

- DeepSeek 的 Base URL、Bearer 与 Chat Completions 格式、当日示例模型：[Your First API Call](https://api-docs.deepseek.com/)。
- 通过账号实际模型列表发现模型和可用元信息：[Lists Models](https://api-docs.deepseek.com/api/list-models/)。
- 思考开关及模式差异：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。首期选择禁用思考是本项目的范围决定。
- JSON object 能力、提示 JSON 与空输出/截断处理：[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。
- 最终 content、reasoning_content、finish_reason、usage 及 SSE 格式：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。
- 错误类型：[Error Codes](https://api-docs.deepseek.com/quick_start/error_codes/)。
- Chrome session 存储、可信上下文及生命周期：[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。
- 扩展跨域请求与 host 权限：[Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)。
- 用户自有账号部署及 D1 资源创建：[Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。
- D1 事务 batch：[D1 Database](https://developers.cloudflare.com/d1/worker-api/d1-database/)。
- Cloudflare 容量/费用和读一致性继续参照前一份选型与设计评审中的官方来源；本文件不硬编码供应商价格或承诺免费。
- Safari 跨平台扩展、转换和当前官方打包途径：[Safari Extensions](https://developer.apple.com/safari/extensions/)。
- Safari API 兼容评估：[Assessing browser compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)。
- Safari 开发安装及临时扩展的生命周期：[Running your Safari web extension](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension)。
- Safari 网站与扩展权限：[Managing permissions](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)。
