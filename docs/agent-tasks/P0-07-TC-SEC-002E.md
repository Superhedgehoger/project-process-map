# P0-07 / TC-SEC-002E：对象换域专用持久端口

## 目标

为 ADR-006 批次执行建立仅限 active migration 的 Node/Task/Asset 单对象条件换域原语。该端口只改变对象的 securityDomainId/securityEpoch 与 version，并以现存迁移计划约束源、目标和项目；普通业务保存端口仍不得换域。

## 直接依据

- ADR-005：Node.parentId 与产品 Task 为权威事实，换域不得改变层级或业务生命周期。
- ADR-006：持久迁移、旧域∩新域、逐项 checkpoint、失败 fail-closed。
- ADR-007：Asset owner/security 快照由产品域权威维护。
- 已验收前置：TC-SEC-002B/C/D。

## 必须保持的不变量

1. 调用必须提供 migrationId、对象 ID、对象 expectedVersion；adapter 在同一事务读取可信 Migration，并要求 state=`active`、tenant/project/source/target domain 与 epoch 匹配。
2. 仅允许对象从计划的 sourceSecurityDomainId/sourceSecurityEpoch 变为 targetSecurityDomainId/targetSecurityEpoch，version 恰好 +1；target domain 可为 null。
3. Node 的 id/project/parent/title/kind/deletedAt，Task 的所有非 security/version 字段，以及 Asset 的 uploader、元数据、生命周期与 deletedAt 均逐字段保持。
4. 对象 missing、跨项目、错误 source、已被其他迁移改变、stale version、非 active/漂移 Migration 均稳定拒绝；不得把“已经是 target”当成本端口成功重放。
5. Memory/SQLite 在实际写入前完成所有校验；事务 callback 捕获错误也不得部分改变对象。
6. SQLite 同时更新重复 security/epoch/version 表列（Node）或 JSON+version（Task/Asset），并在读取 current 时拒绝 row/JSON 漂移。
7. `assignSecurityDomain` 继续只服务首敏感根命令；普通 Task/Asset `savePreservingSecurityOwnership` 与 Migration `saveProgressPreservingPlan` 不放宽。

## 允许修改

- persistence migration-only 写端口与 Memory/SQLite 对称实现
- 必要的共享一致性解码器与直接错误码
- 直接相关测试、Phase/Report/Evidence/checkpoint

## 明确不做

- 批次选择、cursor 推进、Migration checkpoint/transition、Job/lease/retry。
- 迁移创建授权、HTTP/UI、事件/Outbox、索引/投影验证、committed/rollback。
- Node 移动、嵌套域迁移、U2/U7/U8 或 Schema 变化。

## 验收

- Memory/SQLite 对 Node/Task/Asset 的单项 source→target 与 source→public 条件换域通过，且只有 security/epoch/version 变化。
- wrong migration/state/project/source/epoch、missing、stale CAS、already-target 与显式 ID 改写矩阵稳定失败，存储对象不变。
- SQLite 双连接竞争恰好一成一败；重启后对象归属一致，row/JSON 无漂移。
- callback 捕获错误无部分写；现有 TC-SEC-002B/C/D 与安全根测试通过。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再进入批次 + checkpoint 原子编排。
