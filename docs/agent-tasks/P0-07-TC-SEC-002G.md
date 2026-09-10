# P0-07 / TC-SEC-002G：对象完成验证与进入 verifying

## 目标

在批次进度已覆盖完整 inventory 后，以当前真实对象状态重新验证 target 前缀完整性，并通过受保护的 Migration 状态机从 active 进入 verifying。该切片只建立“对象迁移完成”闸门，不宣称索引、投影或所有读取通道已达目标 epoch，也不进入 committed。

## 直接依据

- ADR-005：Node.parentId 是项目树唯一层级权威。
- ADR-006：active 后进入 verifying；索引和可见性投影达到目标 epoch 后才能 committed；verifying 仍保持旧域∩新域。
- ADR-007：Asset 安全归属由产品域权威维护。
- 已验收前置：TC-SEC-002C/D/E/F、ARCH-GATE-SECURITY-001/002。

## 必须保持的不变量

1. 只接受同租户 active Migration 与 expected version；project/root/source/target/cursor/totalItems 只能读取持久计划。
2. 必须重建稳定 resumable inventory，并要求 migratedItems=totalItems=当前完整清单数量、cursor 命中最后一项、每一项均为 target domain/epoch；空清单、缺项、增项、乱序 target/source 或任何归属漂移均 fail-closed。
3. active→verifying 只能通过领域 `transitionSecurityMigration` 与 `saveProgressPreservingPlan`；不得直接改 state、cursor、计划字段或对象。
4. 验证与状态推进必须在同一事务；stale CAS、并发推进或 callback 失败不得留下 partial state。
5. verifying 继续使用旧域∩新域权限交集；不得解除结构冻结、恢复普通写、放宽撤权或最后管理员保护。
6. 不得把对象完成等同于索引/投影/全通道验证完成；本片不得 committed。

## 允许修改

- application 层对象完成验证与进入 verifying 的专用服务
- 必要的直接错误映射与测试
- Phase/Report/Evidence/checkpoint

## 明确不做

- 索引、搜索、通知、实时、下载、导出或 Huly 投影的 epoch 验证。
- committed/rollback/recovery 命令、事件/Outbox、Job lease/retry、HTTP/UI。
- 迁移创建授权、嵌套域、节点移动、U2/U7/U8 或 Schema 变化。

## 验收

- Memory/SQLite 只有完整 target inventory 可从 active 进入 verifying，且 cursor/plan/progress 不变、version 恰好 +1。
- 未完成、伪造 cursor/count、source 回漂、out-of-order target、total mismatch、missing/non-active/stale 均拒绝且状态不变。
- SQLite 双连接并发推进恰好一次成功，重启保持 verifying；`effectiveSecurityDomains` 仍返回旧域与新域。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再进入各读取通道 epoch 验证。
