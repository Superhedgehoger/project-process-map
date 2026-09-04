# CR-003：架构修正闸门

状态：Approved

批准日期：2026-09-03

批准来源：项目负责人要求先修复架构审查发现的问题，完成后才能继续功能开发。

## 决定

1. 暂停 `P0-05A` 以及所有新的业务功能切片；既有 Phase 0 证据保留，但不得继续把内存原型当成生产骨架扩展。
2. 产品内部以 `TenantId` 和 `PrincipalId` 作为租户与身份主键。Huly workspace、账号、邮箱或其他提供方标识只能通过外部身份映射关联，不得成为领域外键。
3. Task 的产品生命周期由产品域权威持有；Huly Issue 是可选协作投影。投影失败不得回滚已经提交的产品事实，必须通过持久化集成操作重试或人工恢复。
4. 项目树以 `ProjectNode.parentId` 为唯一写模型权威；`parent-child` Relation 只能作为派生查询投影，不得双写。
5. 安全域移动采用可恢复迁移记录与权限 epoch。迁移期间读取权限取旧域与新域的交集；迁移完成并经审计后才切换到新域。
6. 文件进入独立 Asset/Evidence 边界；外部引用采用版本化稳定标识，不再把扫描状态或嵌套外部引用编码进字符串。
7. 应用层拥有 Adapter、Repository、Unit of Work、Outbox 和 Job 端口；Domain/Application 不得依赖基础设施实现或 Huly SDK 类型。
8. 正式运行必须使用可跨进程、跨重启的持久存储。内存实现只保留在单元测试和明确的演示模式中。

## 恢复功能开发的硬门槛

- API 与 Worker 通过同一持久存储交换 Outbox/Job；独立进程重启后仍可恢复。
- 事务键均包含租户；事件唯一键至少包含 `(tenant, aggregate_type, aggregate_id, version)`，项目序列包含 `(tenant, project)`。
- Outbox/Job 支持 claim、lease、ack、retry、dead-letter，重复领取和租约过期不会重复提交领域事实。
- 幂等记录可跨进程、跨重启回放；同键不同载荷被拒绝。
- Huly/外部 API 有 deadline、可分类错误、确定性请求标识和条件补偿；补偿失败有恢复入口。
- Product Task 与 Huly 状态类型分离；验收状态机不依赖 Huly 自定义状态。
- Tenant 隔离、重启恢复、并发重复、请求超时、外部成功后响应丢失、局部提交失败均有自动化测试。
- `pnpm check` 与无 Docker 原生发行冒烟均通过。

## 非本次范围

- 不实现支付。未来付费 SaaS 必须建立独立 Billing/Entitlement 边界。
- 不实现产品内 AI Agent。未来如立项，应建立 `AgentRun/Step/ToolInvocation/Approval/Artifact/SecretReference` 边界，并只通过正式应用命令修改领域状态。
- 不因此复刻 Huly UI，也不把 Huly 身份或 Task 再次提升为产品权威源。

## 实施收口

收口日期：2026-09-04

- [x] Product Task/Asset 与 Huly 协作投影解除双权威。
- [x] API 与 Worker 通过 SQLite Outbox/Job 跨进程、跨重启恢复。
- [x] 租户、内部身份、外部身份映射与安全域迁移持久化并带版本控制。
- [x] 外部成功后响应丢失、部分成功、超时、重复调用、死信与人工恢复均有明确路径。
- [x] HTTP 路由、应用端口、领域状态机和基础设施依赖方向完成拆分。
- [x] `pnpm check` 的 42 项行为/故障测试、原生构建及无 Docker 重启恢复冒烟通过。

验收证据见 [ARCH-GATE-01 架构修正验收](../reports/ARCH-GATE-01-architecture-correction.md)。本变更记录解除“暂停新增业务功能”的临时闸门，但后续仍须遵守一次一条小型纵向切片和 P0-ND-02/P0-07 等发布前闸门。
