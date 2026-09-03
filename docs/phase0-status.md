# Phase 0 状态

更新日期：2026-09-03

| 任务 | 状态 | 当前证据 | 下一闸门 |
|---|---|---|---|
| P0-01 Huly 基线 | 完成 | ADR-001 Accepted；源码/镜像 SBOM、ARM64 digest、许可证风险清单已审阅并获项目负责人批准 | 版本或架构变化时重开验证 |
| P0-02 自托管环境 | 完成 | 两个隔离实例均以 14 个 digest 镜像启动并返回 HTTP 200；登录页完成真实浏览器渲染 | 后续集成使用相同锁定基线 |
| P0-03 API/Worker/Adapter | 完成 | API `/health`、Worker、内存 Adapter、契约测试 | 作为 P0-05 纵向链路的接入边界 |
| P0-04 Huly Shell 与 Node 原型 | 完成 | 四个独立插件包、五处可审计 composition 接入；Front/Transactor/Workspace 三镜像真实运行；Shell 内入口、六节点页面和 N-04 详情切换通过浏览器验收 | P0-05 Node → Task → File 纵向链路 |
| P0-05 Node → Huly Task → File | 完成 | 当前 Huly 操作者经 Product API 创建真实 `TSK-1`；图谱与 Tracker 均回查同一任务和 107B 附件；幂等、回滚、补偿、API 与真实 wire envelope 共 9 组契约测试 | P0-05A 任务验收与交付物守卫；P0-07 敏感 ACL |
| P0-06 事件与 Outbox 原子写 | 完成 | 完整事件信封、四个原子回滚断点、幂等重放/冲突、聚合版本与项目序列共 9 项测试 | 物理存储确定后补并发竞争测试 |
| P0-ND-01 无 Docker 原生发行可行性 | 完成 | 自包含浏览器入口、Product API 与 Worker 原生启动；版本化 Node 24 tarball、SHA-256；临时目录冒烟确认未调用 Docker并完成页面 → 节点 → 任务 | P0-ND-02 干净 Linux、持久化、完整纵向链路与升级/回滚 |

## 启动条件

- [x] 已登记 Huly Platform 与 Selfhost 完整 commit 候选
- [x] 可重复的 Huly 自托管部署说明与 ARM64 镜像锁
- [ ] 普通成员、无敏感权限成员两组测试身份
- [x] 200 节点、300 关系、2,000 任务的脱敏数据生成器
- [x] 最小签字模板 fixture
- [x] 源码仓库、工作约定与验证命令
- [x] GitHub Actions CI 入口
- [x] 不调用 Docker 的产品发行包构建与临时目录冒烟入口

P0-01 至 P0-05 已按依赖顺序通过。P0-05 与 P0-06 的内存实现证明逻辑契约，不预先决定生产物理存储、Task 权威或敏感 ACL。CR-002 后，P0-02、P0-04、P0-05 的 Docker 结果只保留为 Huly 开发验证证据；正式部署必须通过 P0-ND-02 的无 Docker clean-machine 闸门。

P0-01 风险详见 `docs/reports/P0-01-source-audit.md`；Docker 开发环境复跑见 `docs/reports/P0-02-selfhost-replay.md`；Shell 验收见 `docs/reports/P0-04-huly-shell.md`；纵向链路见 `docs/reports/P0-05-node-task-file.md`；事件原子性见 `docs/reports/P0-06a-local-event-outbox.md`；无 Docker 交付边界见 `docs/change-records/CR-002-docker-free-saas.md` 与 `docs/adr/ADR-002-docker-free-runtime.md`。
