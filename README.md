# 拾页 Shiye

一个安放待看与收藏的个人工作台。先收下，慢慢看。

## 当前状态

此仓库目前只有工程骨架，尚无可安装扩展或可运行功能。产品与技术依据位于仓库同级的 `../resource/拾页_UI与完整开发交付包_v2_1/拾页开发交付包_v2_1/`。开发前先阅读其中的 `00_先读我.md`、`02_产品与技术实现说明_v2_1.md` 和 `03_AI开发任务书_v2_1.md`。`resource` 不纳入仓库，避免把原型和参考文件误认为正式代码。

## 方向

- v1a：Chrome / Edge MV3 扩展；React + TypeScript 工作台；Dexie / IndexedDB 为唯一可编辑主库。
- 按资料包的 P0 → P6 阶段开发。先做浏览器能力和数据持久化验证，再实施业务功能。
- v1b Worker + D1 同步是独立可选阶段，当前不建云端工程。

## 目录

```text
apps/workspace/          扩展工作台页面
apps/extension/          弹窗、service worker、manifest 与受控消息
packages/core/          领域类型与纯规则
packages/application/   用例与仓库接口
packages/storage/       IndexedDB / Dexie 实现
packages/adapters/ai/   AI 服务适配器
fixtures/               后续存放脱敏测试样例
docs/                   工程决策与验证记录
```

根目录使用 npm workspaces。依赖、构建脚本和锁文件将在 P0 验证时确定并加入；目前没有可运行命令，也没有通过任何浏览器验证。

## 下一步

按 [P0 准备清单](docs/P0.md) 验证扩展安装、同 origin 数据读写、关闭重开后的持久化、书签文件解析和手机只读快照，再确认具体依赖版本与工程脚本。
