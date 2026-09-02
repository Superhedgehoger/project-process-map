# Phase 0 状态

更新日期：2026-09-02

| 任务 | 状态 | 当前证据 | 下一闸门 |
|---|---|---|---|
| P0-01 Huly 基线 | 完成 | ADR-001 Accepted；源码/镜像 SBOM、ARM64 digest、许可证风险清单已审阅并获项目负责人批准 | 版本或架构变化时重开验证 |
| P0-02 自托管环境 | 完成 | 两个隔离实例均以 14 个 digest 镜像启动并返回 HTTP 200；登录页完成真实浏览器渲染 | 后续集成使用相同锁定基线 |
| P0-03 API/Worker/Adapter | 完成 | API `/health`、Worker、内存 Adapter、契约测试 | P0-04 注册 Huly Shell 页面 |
| P0-04 Huly Shell 与 Node 原型 | 进行中 | 已确认静态插件接入点，不修改 Workbench 内核 | 建立独立插件包和可审计 composition 补丁 |
| P0-06 事件与 Outbox 原子写 | 完成 | 完整事件信封、四个原子回滚断点、幂等重放/冲突、聚合版本与项目序列共 9 项测试 | 物理存储确定后补并发竞争测试 |

## 启动条件

- [x] 已登记 Huly Platform 与 Selfhost 完整 commit 候选
- [x] 可重复的 Huly 自托管部署说明与 ARM64 镜像锁
- [ ] 普通成员、无敏感权限成员两组测试身份
- [x] 200 节点、300 关系、2,000 任务的脱敏数据生成器
- [x] 最小签字模板 fixture
- [x] 源码仓库、工作约定与验证命令
- [x] GitHub Actions CI 入口

P0-01 至 P0-03 已按依赖顺序通过。P0-06 的内存实现证明逻辑契约，不预先决定生产物理存储。

P0-01 风险详见 `docs/reports/P0-01-source-audit.md`；部署复跑见 `docs/reports/P0-02-selfhost-replay.md`；事件原子性见 `docs/reports/P0-06a-local-event-outbox.md`。
