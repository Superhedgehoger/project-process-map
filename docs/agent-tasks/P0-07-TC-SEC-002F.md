# P0-07 / TC-SEC-002F：迁移批次与 checkpoint 原子编排

## 目标

在已验收的确定性 inventory、单对象换域端口和 Migration 进度守卫之上，实现一个有界批次：按稳定 cursor 选择下一段对象，并在同一事务内完成这些对象的条件换域与 Migration checkpoint。任一对象或 checkpoint 失败时整批回滚，重启后可从持久 cursor 安全续跑。

## 直接依据

- ADR-005：Node.parentId 是层级权威，批次不得改变结构。
- ADR-006：迁移必须持久、逐项 checkpoint、崩溃可续跑，active 至 committed 前保持旧域∩新域。
- ADR-007：Asset 归属由产品域权威维护。
- 已验收前置：TC-SEC-002C/D/E、ARCH-GATE-SECURITY-001/002。

## 必须保持的不变量

1. 只处理同租户的 active Migration；批次 inventory 必须由持久计划的 project/root/source domain/epoch 重建，不接受调用方传入对象清单、目标域或任意 cursor。
2. 下一批严格位于持久 cursor 之后，沿 TC-SEC-002D 的稳定顺序选取，批量大小必须是受限正整数；不得跳项、重复计数或把 already-target 当成功重放。
3. 每项使用 TC-SEC-002E 的 migrationId/objectId/expectedVersion 条件写；批次内对象写和一次 checkpoint 必须处于同一事务，任何 missing、stale、scope/source 漂移或 checkpoint CAS 失败都整体回滚。
4. checkpoint 的 cursor 必须等于本批最后一项 cursor，migratedItems 只增加本批成功项数且不超过 totalItems；空剩余集不得伪造进度。
5. 批次执行不得推进到 verifying/committed，不创建或改写 Migration 计划，不产生未定义的事件、Outbox 或投影成功声明。
6. Memory/SQLite 行为一致；SQLite 双连接只允许一个相同 expected migration version 的批次提交，失败方不得留下对象或进度的部分写。
7. 结构冻结、ACL 旧域∩新域、撤权即时生效、普通保存端口和最后管理员守卫不得放宽。

## 允许修改

- application 层有界迁移批次服务与必要 DTO/错误映射
- 为同事务 inventory/read/write/checkpoint 所需的最小 persistence 端口组合
- Memory/SQLite 对称实现的必要局部调整
- 直接相关测试、Phase/Report/Evidence/checkpoint

## 明确不做

- 迁移创建/审批授权、HTTP/UI。
- Job lease/retry 调度、verifying/committed/rollback、索引或投影验证。
- 事件/Outbox 契约、嵌套域迁移、节点移动、U2/U7/U8 或 Schema 变化。

## 验收

- Memory/SQLite 对多批次执行产生相同对象顺序、cursor 与 migratedItems；最后不足一批和重启续跑通过。
- 每一种对象写失败和 checkpoint stale CAS 都验证整批对象与 Migration 进度不变，包括 callback 捕获错误场景。
- SQLite 双连接批次竞争恰好一成一败，重启后无跳项、无重复计数、无 row/JSON 漂移。
- 现有 TC-SEC-002B/C/D/E 与安全/ACL 回归全部通过。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再进入验证与提交状态编排。
