# Phase 0 状态

更新日期：2026-09-02

| 任务 | 状态 | 当前证据 | 下一闸门 |
|---|---|---|---|
| P0-01 Huly 基线 | 进行中 | Platform `v0.7.426` 与 Platform/Selfhost 完整 SHA 已登记 | 克隆锁定源码、生成 SBOM、完成许可证与部署复核 |
| P0-02 自托管环境 | 未开始 | 无 | P0-01 通过后从干净环境部署 |
| P0-03 API/Worker/Adapter | 预备骨架已验证 | API `/health`、Worker、内存 Adapter、5 项测试 | P0-02 后连接真实 Huly 环境复验 |

## 启动条件

- [x] 已登记 Huly Platform 与 Selfhost 完整 commit 候选
- [ ] 可重复的 Huly 构建与部署说明
- [ ] 普通成员、无敏感权限成员两组测试身份
- [x] 200 节点、300 关系、2,000 任务的脱敏数据生成器
- [x] 最小签字模板 fixture
- [x] 源码仓库、工作约定与验证命令
- [x] GitHub Actions CI 入口

P0-03 的代码当前只是无外部依赖的预备骨架，不能绕过 P0-01/P0-02 宣称技术闸门通过。
