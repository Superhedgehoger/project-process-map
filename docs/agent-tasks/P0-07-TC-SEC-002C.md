# P0-07 / TC-SEC-002C：安全域迁移计划不可变与进度保存守卫

## 目标

在实现非空子树逐项换域前，关闭通用 `SecurityDomainMigrationRepository.update` 可重写迁移身份、范围和源/目标计划的持久层旁路。迁移 worker 只能保存已批准计划内的状态与检查点进度。

## 直接依据

- ADR-006：迁移是持久状态机与逐项 checkpoint；失败保持旧域∩新域，直到恢复或受审计回滚。
- ADR-004：持久工作单元、CAS、可恢复后台工作。
- 数据与权限规格：权限变化 fail-closed，迁移期间不得扩大可见性。
- 已验收前置：ARCH-GATE-SECURITY-001/002、TC-SEC-002A/B、TC-SEC-003A/B/C。

## 必须保持的不变量

1. 既有迁移的 `tenantId/id/projectId/rootNodeId/sourceSecurityDomainId/targetSecurityDomainId/sourceSecurityEpoch/targetSecurityEpoch/totalItems/deadlineAtUtc/createdAtUtc` 对进度保存不可变。
2. `hierarchyRevision` 是计划时快照，普通进度保存不得改写；结构变化由后续独立规划/恢复规则处理，不在 worker 内静默重算。
3. 只有领域状态机产出的 `state/cursor/migratedItems/failure/nextAttemptAtUtc/updatedAtUtc/version` 可经受限端口保存，且 Memory/SQLite 自身执行 CAS。
4. 显式 migration ID 防止对象 ID 改写；SQLite row 与 JSON 的重复身份、计划及 version 漂移必须 fail-closed，不得借普通保存修复。
5. 回调捕获错误、stale CAS、SQLite 并发与重启不得改变迁移计划或回退 cursor/progress。
6. `effectiveSecurityDomains` 的 active/verifying/retryable/recovery_required 旧域∩新域语义不变。

## 允许修改

- `packages/application/src/ports/persistence.ts`
- `packages/adapters/src/memory/persistence.ts`
- `packages/adapters/src/sqlite/persistence.ts`
- `tests/security-migration-persistence.test.ts` 与直接相关测试
- Phase/Report/Evidence/checkpoint

## 明确不做

- 创建迁移的 API/UI/命令与产品规划规则。
- Node/Task/Asset 批量换域、cursor 枚举策略、Job worker、索引/投影验证与 committed/rollback 编排。
- 嵌套域、节点移动、U2/U7/U8 或 SQLite Schema 变化。

## 验收

- Memory/SQLite 稳定拒绝所有迁移身份/计划字段改写，且存储记录不变。
- 合法状态转换与 checkpoint 保存继续工作；progress 不得倒退或超过 total。
- 捕获错误、stale CAS、双连接并发、SQLite row/JSON 漂移与重启证据通过。
- 旧通用 update 从端口移除，后续 worker 只能调用受限进度保存端口。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再进入迁移创建/批次执行子片。
