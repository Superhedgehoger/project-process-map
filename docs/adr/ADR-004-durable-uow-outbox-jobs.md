# ADR-004：持久工作单元、Outbox 与集成任务

- 状态：Accepted
- 日期：2026-09-03
- 关联：CR-003、P0-ND-02、FND-04～FND-08

## 背景

现有 `InMemoryTransactionalStore` 同时承担 ProjectNode 仓库、Event Store、投影、幂等与 Outbox，且暴露同步事务。独立 API 与 Worker 会创建互不可见的实例，无法支持 SaaS 重启、扩容或失败恢复。

## 决定

- Application 定义异步 `UnitOfWork` 及窄 Repository/Outbox/Job 端口；基础设施实现这些端口。Domain 只保留实体、值对象、状态机和纯规则。
- 单个本地命令在同一数据库事务写入：领域状态、最小领域事件、Outbox、幂等结果，以及需要的 Integration Operation/Job。
- 所有唯一键包含 tenant。事件版本唯一键为 `(tenant_id, aggregate_type, aggregate_id, aggregate_version)`；项目序列唯一键为 `(tenant_id, project_id, project_sequence)`。
- Outbox/Job 采用数据库租约：claim 写入 owner 与 deadline；ack 只允许当前 owner；失败增加 attempt 并计算 next attempt；超过上限进入 dead letter；租约到期可被其他 Worker 重领。
- Integration Operation 保存判别式 operation type、逐步尝试、确定性外部 request ID、deadline、同步水位、条件补偿与人工恢复说明，禁止用一组可选字段表达所有 Saga。
- SQLite 是无 Docker 单机发行与 P0-ND-02 的首个持久适配器，使用 WAL、foreign keys 和 busy timeout。接口不得泄露 SQLite 类型；生产 SaaS 水平扩展前必须以同一契约增加 PostgreSQL 适配器并完成多副本测试。
- Worker 不持有用户明文令牌。后台调用只能使用可撤销的服务身份或受限委托引用，Secret 由部署环境/密钥服务解析，持久层只保存 `SecretReference`。

## 失败语义

- 客户端超时后重试：以 `(tenant, principal, operation, idempotency_key)` 回放已提交结果。
- 外部成功但响应丢失：以确定性 request ID 回查，不重复创建。
- 外部成功、本地失败：记录可恢复步骤；只有同步水位仍匹配且对象未被外部采用时才执行条件补偿。
- 部分成功：从最后确认步骤继续；自动重试耗尽后进入 dead letter，而不是无限循环或静默遗留。
- Worker 崩溃：租约到期后重领；消费者以 message ID 去重，因此至少一次投递不等于重复业务提交。

## 结果

API 与 Worker 可以作为独立原生进程使用同一持久数据，不依赖 Docker。SQLite 解决单机发行与开发验收，PostgreSQL 解决后续多副本 SaaS；两者共享应用端口和行为测试。

