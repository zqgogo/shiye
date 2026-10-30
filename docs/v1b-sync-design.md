# v1b 同步设计方案（草稿）

状态：**方案讨论稿，未立项、未写代码**。本文只定边界与契约，供确认后再实施。
范围：多设备同步收藏与待看。**不含 AI**（继续用手动交接），**不含附件/快照同步**，**不含多人协作**。

## 1. 设计目标

1. 数据仍然以本地 IndexedDB 为唯一可编辑主库；断网、未登录、服务端挂掉都必须能完整使用。
2. 后端只做三件事：**鉴权、版本守卫、存储**。不做业务裁决，不含隐私判断，不含合并策略。
3. 后端可替换：Cloudflare 只是第一个适配器，换到自建 Node/Postgres 时**协议不变、客户端不改**。
4. 同步的拉取合并**复用恢复流程已有的裁决**（墓碑优先、只增不复活），不另写一套语义。

## 2. 分层与依赖方向

依赖只能从上往下，反向依赖一律禁止：

```
apps/workspace  ──►  packages/sync  ──►  packages/core / storage（本地库）
      │                   ▲
      │                   │ 只依赖接口
      └──► SyncTransport ─┘
                           ▲
apps/worker (Cloudflare) ──┘ 实现 HTTP + D1
```

| 层 | 位置（新增） | 职责 | 不允许出现 |
| --- | --- | --- | --- |
| 协议 | `packages/sync/src/protocol.ts` | 请求/响应 zod schema、版本号语义 | 任何 `fetch`、任何云厂商 SDK |
| 裁决 | `packages/sync/src/merge.ts` | 纯函数：给定本地记录与服务端记录，返回合并结果或冲突 | IO、数据库、React |
| 客户端 | `packages/sync/src/client.ts` | push/pull 调度、游标推进、脏队列管理 | 直接引用 `apps/worker` |
| 端口 | `packages/sync/src/ports.ts` | `SyncTransport` 接口 | 具体实现 |
| 适配器 | `apps/worker/` | Worker 入口、D1 实现、鉴权 | 任何业务规则 |
| 接线 | `apps/workspace/src/sync.ts` | 把端口指向某个 baseUrl | 协议细节 |

关键约束：`packages/sync` **不 import 任何 `@cloudflare/*` 或 `fetch`**。传输由端口注入，这样单测能在内存里跑完整同步往返，不需要起服务。

## 3. 接口契约（HTTP + JSON，与运行时无关）

任何语言实现这三个接口即可成为合法后端。

### 3.1 `POST /v1/push`

```jsonc
// 请求
{
  "epoch": "b3f1c2...",          // 客户端记住的主库纪元
  "ops": [
    {
      "entityType": "bookmark",   // bookmark | reading | category | tag | tombstone | settings | policy
      "id": "01J...",
      "baseVersion": 12,          // 客户端上次见到的服务端版本；新建为 0
      "deleted": false,
      "payload": { }              // 白名单字段，不含 localOnly 条目
    }
  ]
}
// 响应
{
  "epoch": "b3f1c2...",
  "results": [
    { "id": "01J...", "status": "ok",         "version": 13 },
    { "id": "01K...", "status": "conflict",   "version": 15, "server": { } },
    { "id": "01M...", "status": "epoch_mismatch" }
  ]
}
```

- 单次最多 50 条，超出由客户端分批；这是为了躲开 Workers 免费版 CPU 时限，也避免长事务。
- `status: conflict` 必须带服务端当前记录，客户端才能裁决并给用户看。
- 部分成功是允许的：冲突的条目跳过，其余照常写入。

### 3.2 `GET /v1/pull?cursor=<n>&limit=500`

```jsonc
{
  "epoch": "b3f1c2...",
  "items": [
    { "entityType": "bookmark", "id": "01J...", "version": 13, "deleted": false, "payload": { } }
  ],
  "nextCursor": 13,
  "hasMore": false
}
```

- `items` 按 `version` 升序；`nextCursor` 只在**成功落本地之后**才推进（先落库、后推进，顺序反了会静默丢数据）。
- 游标语义是「已收到并已落本地的最大版本」，不是「服务端最大版本」。

### 3.3 `POST /v1/epoch/reset`

用户清库、替换恢复、或从旧备份重建之后调用：服务端换一个新 epoch，所有旧客户端的 push 都会被 `epoch_mismatch` 拒绝。**不自动重放旧写入**，客户端收到后暂停同步并提示人工核对。

## 4. 数据模型（D1 / SQLite）

```sql
-- 一个用户一个 library；个人版就是一条记录
CREATE TABLE libraries (
  id            TEXT PRIMARY KEY,
  epoch         TEXT NOT NULL,
  next_version  INTEGER NOT NULL DEFAULT 1,   -- 单调递增，全局游标
  created_at    TEXT NOT NULL
);

-- 所有实体统一存一行：换库时最容易移植，等价于 Postgres 的 jsonb
CREATE TABLE records (
  library_id     TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  version        INTEGER NOT NULL,            -- 服务端版本，单调
  deleted        INTEGER NOT NULL DEFAULT 0,  -- 墓碑也是一条记录
  payload        TEXT NOT NULL,               -- 白名单 JSON
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (library_id, entity_type, entity_id)
);
CREATE INDEX records_cursor ON records (library_id, version);

-- 会话：只存 token 哈希，不存明文
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- 冲突留痕：用于「同步历史」页面和排障，不参与裁决
CREATE TABLE conflicts (
  id          TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  local       TEXT NOT NULL,
  remote      TEXT NOT NULL,
  resolved_at TEXT
);
```

不建 `changes` 流水表：`records.version` 本身就是增量游标，删除态也在同一行上，一张表够用。

## 5. 同步算法

### 5.1 push（版本守卫）

每条 op 在同一个 batch 里执行条件更新，靠 `changes` 判断成败：

```sql
-- 新记录（baseVersion = 0）
INSERT INTO records (library_id, entity_type, entity_id, version, deleted, payload, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING;

-- 更新（CAS：版本必须对得上才写）
UPDATE records
SET version = ?, deleted = ?, payload = ?, updated_at = ?
WHERE library_id = ? AND entity_type = ? AND entity_id = ? AND version = ?;
```

`changes === 0` 说明版本对不上（或并发被抢先），读回当前行返回 `conflict`。**绝不允许无条件覆盖**——那正是本地已经修过三次的那类 bug。

### 5.2 pull（增量）

```sql
SELECT entity_type, entity_id, version, deleted, payload
FROM records
WHERE library_id = ? AND version > ?
ORDER BY version ASC
LIMIT ?;
```

### 5.3 客户端循环

```
本地写入成功 → 写 dirty 队列（含 baseVersion） → 广播
定时/手动/上线时：
  1. push(dirty)  → ok 的条目出队、更新 baseVersion
                 → conflict 的进入待裁决队列（不自动重试）
  2. pull(cursor) → 逐条应用 merge.ts 的裁决 → 落库 → 推进游标
  3. 若 merge 判定「本地更新」→ 该条重新进 dirty（下一轮推上去）
```

## 6. 冲突矩阵

`B` = 客户端 baseVersion，`S` = 服务端当前 version，`C` = 客户端要写的记录。

| 情形 | 判定 | 结果 |
| --- | --- | --- |
| 服务端无此记录（S=0） | 插入 | 直接写 |
| B = S | 无冲突 | 直接写，version+1 |
| B < S，C 删除、S 活跃 | 删除优先 | 写入墓碑，记 `conflicts` |
| B < S，C 活跃、S 已删除 | **不复活** | 拒绝写入，本地标 `needsReview`，提示「这条在另一台设备已删除」 |
| B < S，双方都活跃且字段不同 | 可字段级合并（S2 再做） | MVP：一律按冲突处理 |
| B < S，双方都活跃且同字段 | 人工裁决 | 本地保留，标 `needsReview`，界面给「用本机／用云端」两个按钮 |
| epoch 不匹配 | 整个请求拒绝 | 客户端暂停同步，提示重新初始化，不自动重放 |

MVP 原则：**宁可停下来问人，也不猜**。自动合并留到 S2，且只在有字段级 `updatedFields` 时才做。

## 7. 隐私边界的变化

- `localOnly` 记录**根本不进 push 队列**，服务端 schema 里也没有这个字段——不是"存了但标记不上传"，是压根没有。
- 后果必须写进界面：另一台设备看到的是**残缺库**。列表里对"本机有、云端没有"的条目要有明确标识，否则用户会以为数据丢了。
- 备份文件仍含全量（本地导出），与同步无关。
- `open-issues.md` 里「内容不出本机」的口径要改成「收藏与待看会同步到你的私有库；本地专用条目除外」，并重验验收清单第 16 条。

## 8. 换服务器要改什么

换掉 Cloudflare 时，只动 `apps/worker` 一个目录：

| 要重写 | 不用动 |
| --- | --- |
| 一个 `SyncStore` 实现（约 6 个方法） | 协议 schema、冲突矩阵、客户端循环 |
| 一个 HTTP 入口（Express/Fastify/Go/Python 均可） | 本地库结构、恢复流程、备份格式 |
| SQL 方言（`ON CONFLICT` → `ON DUPLICATE KEY` 等） | 扩展的打包与权限 |
| 鉴权实现 | 所有单测与浏览器回归脚本 |

为降低迁移成本，有两条硬约束：

1. **不在核心路径用 Cloudflare 专有能力**（Durable Objects、Queues、Cron），Worker 只做薄封装。
2. **协议只依赖 HTTP + JSON**，不依赖特定 header 或 CDN 行为。

Postgres 版对照：`records` 表结构不变，`payload TEXT` 换 `jsonb`，`next_version` 用 `UPDATE ... RETURNING` 或序列，CAS 用 `WHERE version = ?` 同样成立。

## 9. 分期

| 阶段 | 内容 | 冲突面 |
| --- | --- | --- |
| S1 只读镜像 | 一端上传全量快照，另一端只读查看（可搜索） | 零，只有一个写入方 |
| S2 双向同步 | push/pull + 冲突矩阵 + 人工裁决界面 | 全部 |
| S3 自动合并 | 字段级 rebase，仅在同记录不同字段时 | 收窄 |

建议先做 S1：手机随时能看能搜，写入仍在电脑端，已经覆盖大部分真实需求，而且能把鉴权、游标、墓碑传输这些基础件先跑通。

## 10. 验收项（实施后按此验收）

1. 双设备：A 新建 → B pull 后可见，条数与字段一致。
2. A 删除 → B pull 后不复活，墓碑同步到 B。
3. 同时改同一条 → 服务端拒绝覆盖，双方数据都不丢，界面出现裁决入口。
4. A 删、B 改 → B 的修改被拦下并标 `needsReview`，不产生「已删又在库」。
5. 恢复旧备份 → epoch 变更 → 旧客户端 push 被拒，且不自动重放。
6. `localOnly` 条目在服务端**不存在**（直接查库断言，不只看接口返回）。
7. 断网 → 本地照常读写；恢复网络后补齐，不重复写入。
8. 服务端 500 / 超时 → 客户端不卡死、不丢 dirty 队列，重试幂等。
9. 换一个后端实现（内存版）跑同一套协议测试，全部通过。
10. 卸载扩展重装（ID 变化）→ 用同一账号拉回全部数据。

## 11. 待决问题

1. **账号形态**：邮箱 OTP、GitHub/Google OAuth，还是先给个人用的预共享 token？决定 Worker 的鉴权代码量。
2. **国内访问**：Workers/D1 走境外节点，延迟与稳定性自己测；如果不可接受，S1 就要考虑换国内云。
3. **S1 是否够用**：如果只读镜像能满足「手机看」，就先不做 S2，避免为不存在的需求背冲突逻辑。
4. **同步频率**：手动触发、打开工作台时拉取、还是 chrome.alarms 定时？定时会带来后台唤醒与请求量。

## 12. 用户自有后端与可配置连接（新增要求）

用户要求 v1b 可以连接**使用者自己部署的 Cloudflare 后端**，不把开发者的固定域名或共享账号作为使用前提。

- 默认仅本地；用户主动配置自己的后端 HTTPS 地址并完成应用级配对/登录后才启用云功能。连接测试不上传收藏，首次上传单独确认。
- Worker、D1、服务端密钥部署在用户自己的 Cloudflare 账号中，提供部署模板和初始化/升级说明；研究使用官方 Deploy to Cloudflare 按钮简化流程。
- 拾页运行时只使用后端地址和应用凭据，**不要求填写 Cloudflare 账号管理 API token**；账号 ID、D1 绑定和部署凭据属于部署流程。
- 手机只读与桌面写入分别授权；应用凭据不得进入 URL、代码仓库、备份、快照或日志。
- 连接握手返回 serverId、libraryId、epoch、协议版本；游标、版本和待确认操作绑定服务身份，换服务器不自动发送旧凭据或重放旧队列。
- 配置页支持测试、暂停、断开及重新连接；更换地址/库需明确选择迁移方式，保留本地专用数据。

当前建议：**Cloudflare Workers + D1 作为首个自有后端；GitHub 用于源码、部署入口和可选的后续私库备份。** GitHub Pages 仅作静态界面不能替代同步 API；私有仓库 + API 能另做低频备份或单写端镜像，但本期不因此自动承诺第二套双向同步。

详细平台能力、限制、成本依据和配置建议见 [自有后端配置与 Cloudflare / GitHub 选型](cloudflare-vs-github-2026-10-30.md)。本节只增加部署归属与配置要求，前文同步协议仍需按 [设计评审](verification/v1b-sync-design-review-2026-10-30.md) 补齐，不能视作已可实施或已实现。
