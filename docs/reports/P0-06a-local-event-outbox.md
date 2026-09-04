# P0-06a 本地事件与 Outbox 探索证据

> 历史证据说明：本报告中的 `InMemoryTransactionalStore` 已被删除。当前权威实现为 application-owned `Persistence` 端口及 Memory/SQLite 适配器；正式原生运行使用 SQLite，并以租约处理 Outbox/Job。以下内容仅保留原始探索背景。

- 验证日期：2026-09-02
- 范围：仅内存实现，不连接、修改或分发 Huly
- 目的：在许可证闸门等待人工审查期间，提前验证本地事务契约
- 结论：探索验收通过；P0-01 至 P0-03 获批后并入 P0-06 正式验收

## 已实现契约

`executeCreateNode` 在一个 `InMemoryTransactionalStore` 事务中完成：

1. 保存 `ProjectNode` 聚合，创建版本固定为 1。
2. 分配项目内单调递增 `projectSequence`。
3. 追加不可变 `DomainEvent`。
4. 写入携带同一事件的 Outbox 消息。
5. 保存 `actorId + commandType + idempotencyKey` 命令结果。

事件信封包含 event/project ID、项目序号、聚合类型/ID/版本、事件类型、actor、UTC 时间、correlation/causation ID、原始安全域、before/after 和 Schema 版本。普通节点的原始安全域允许为 `null`，但字段不会被省略。

## 自动测试证据

| 行为 | 结果 |
|---|---|
| 聚合、事件与 Outbox 同事务提交 | 通过 |
| 聚合写入后故障 | 全部回滚 |
| 事件追加后故障 | 全部回滚 |
| Outbox 入队后故障 | 全部回滚 |
| 幂等记录后故障 | 全部回滚 |
| 相同 actor/命令/幂等键与相同业务 payload 重放 | 返回首次结果，不产生第二次写入 |
| 相同幂等键更换业务 payload | 稳定拒绝，错误码 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` |
| 同项目序列递增、不同项目分别计数 | 通过 |
| 聚合 ID 冲突 | 拒绝且不消耗项目序号 |

连同既有健康检查与 Adapter 测试，`pnpm check` 当前共运行 12 项测试，全部通过。

## 保持未决

- 物理数据库及事务实现
- Project Map 图存储
- 实时同步机制
- Task 核心字段权威来源
- 敏感 ACL 主方案
- Huly Shell 静态接入补丁

P0-01/P0-02/P0-03 已于 2026-09-02 依次通过，本证据现已进入 P0-06 正式验收。正式实现仍必须把当前内存唯一约束映射为所选事务存储中的可靠约束，并补充并发竞争测试。
