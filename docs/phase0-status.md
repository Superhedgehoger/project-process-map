# Phase 0 状态

更新日期：2026-09-04

| 任务 | 状态 | 当前证据 | 下一闸门 |
|---|---|---|---|
| P0-01 Huly 基线 | 完成 | ADR-001 Accepted；源码/镜像 SBOM、ARM64 digest、许可证风险清单已审阅并获项目负责人批准 | 版本或架构变化时重开验证 |
| P0-02 自托管环境 | 完成 | 两个隔离实例均以 14 个 digest 镜像启动并返回 HTTP 200；登录页完成真实浏览器渲染 | 后续集成使用相同锁定基线 |
| P0-03 API/Worker/Adapter | 完成 | API `/health`、独立 Worker、应用层端口、SQLite/文件持久适配器、持久身份映射与契约测试 | 作为后续纵向链路的稳定接入边界 |
| P0-04 Huly Shell 与 Node 原型 | 完成 | 四个独立插件包、五处可审计 composition 接入；Front/Transactor/Workspace 三镜像真实运行；Shell 内入口、六节点页面和 N-04 详情切换通过浏览器验收 | P0-05 Node → Task → File 纵向链路 |
| P0-05 Node → Product Task/Asset → Huly 投影 | 完成 | Product Task/Asset 为权威事实；Huly 作为异步投影；确定性请求、超时回查、部分成功续跑、死信恢复与真实 wire envelope 均有契约测试 | P0-05A 任务验收与交付物守卫；P0-07 敏感 ACL |
| P0-06 事件与 Outbox 原子写 | 完成 | SQLite 在同一事务写领域状态、事件、Outbox、Job 与幂等回执；覆盖租户隔离、重启、并发领取、租约、重放、冲突及故障断点 | PostgreSQL 多副本实施前复用同一行为契约 |
| P0-07 敏感 ACL | 进行中 | `TC-SEC-001` 空叶节点转换：首个 SecurityDomain、首名 `manage_access`、节点、事件、Outbox 与回执原子提交；无权身份 404；旧域兼容不提权；75 项测试通过 | 成员/Grant 管理审计、最后管理员保护、嵌套域及非空子树迁移、固定身份矩阵和全通道 ACL |
| P0-ND-01 无 Docker 原生发行可行性 | 完成 | 自包含浏览器入口、Product API 与 Worker 原生启动；版本化 Node 24 tarball、SHA-256；临时目录冒烟确认未调用 Docker，并完成页面 → 节点 → 任务 → Asset → 重启回读 | P0-ND-02 干净 Linux、备份恢复与升级/回滚 |
| ARCH-GATE-01 架构修正 | 完成 | CR-003、ADR-003～ADR-008；42 项行为/故障测试；无 Docker 原生发行与重启恢复冒烟通过 | 恢复按单条纵向切片开发，从 P0-05A 开始 |
| P0-05A 任务验收与交付物守卫 | 进行中 | `T1a` 已完成显式验收人快照、两轮验收、最小持久成员/安全域授权、负责人/验收人改派、旧库回放兼容、事件/Outbox 和 SQLite 重启恢复；57 项测试通过 | 补 P0-07 成员配置与角色槽位解析，再进入 Deliverable 与节点完成守卫 |

## 启动条件

- [x] 已登记 Huly Platform 与 Selfhost 完整 commit 候选
- [x] 可重复的 Huly 自托管部署说明与 ARM64 镜像锁
- [ ] 普通成员、无敏感权限成员两组测试身份
- [x] 200 节点、300 关系、2,000 任务的脱敏数据生成器
- [x] 最小签字模板 fixture
- [x] 源码仓库、工作约定与验证命令
- [x] GitHub Actions CI 入口
- [x] 不调用 Docker 的产品发行包构建与临时目录冒烟入口

P0-01 至 P0-06 已按依赖顺序通过。产品运行骨架当前使用 SQLite 与文件目录持久化，Task/Asset 由产品域权威持有，Huly 仅作为可恢复的异步协作投影；内存实现只用于测试。CR-002 后，P0-02、P0-04、早期 P0-05 的 Docker 结果只保留为 Huly 开发验证证据；正式部署仍必须通过 P0-ND-02 的无 Docker clean-machine 闸门。

CR-003 架构修正闸门已于 2026-09-04 通过。被否决的内存生产 Store、Huly Task 权威、同步跨系统事务和进程内 Saga 已从当前骨架移除；现在可以恢复 P0-05A，但仍须一次只实现一条小型纵向切片。

P0-05A 是依赖 P0-07 的复合项，不能因 `T1a` 通过而整体关闭。`T1a` 覆盖显式验收人的核心周期、最小持久成员/安全域授权和项目经理改派；模板角色槽位、节点负责人回退、正式成员管理与授权审计、全通道敏感 ACL、验收 UI、Deliverable/Evidence 与节点完成守卫仍待后续切片。安全域迁移期间当前 API 整体冻结，待 P0-07 实现旧域与新域权限交集。详见 `docs/reports/P0-05A-T1a-task-review.md`。

P0-07 的 `TC-SEC-001` 子切片已经建立正式 SecurityDomain/SecurityGrant 与首管理员原子创建链路，但 P0-07 总项保持进行中。为避免非空子树在迁移前泄漏，本期只接受空叶节点；创建后 Task/Asset 继承安全域，并拒绝创建可能保持公开的普通后代。v3 遗留域只保留查看兼容，且旧对象引用过的域 ID 不可被新正式域复用。详见 `docs/reports/P0-07-TC-SEC-001-first-security-root.md`。

P0-01 风险详见 `docs/reports/P0-01-source-audit.md`；Docker 开发环境复跑见 `docs/reports/P0-02-selfhost-replay.md`；Shell 验收见 `docs/reports/P0-04-huly-shell.md`；纵向链路见 `docs/reports/P0-05-node-task-file.md`；任务验收见 `docs/reports/P0-05A-T1a-task-review.md`；敏感根见 `docs/reports/P0-07-TC-SEC-001-first-security-root.md`；事件原子性见 `docs/reports/P0-06a-local-event-outbox.md`；架构修正验收见 `docs/reports/ARCH-GATE-01-architecture-correction.md`；无 Docker 交付边界见 `docs/change-records/CR-002-docker-free-saas.md` 与 `docs/adr/ADR-002-docker-free-runtime.md`。
