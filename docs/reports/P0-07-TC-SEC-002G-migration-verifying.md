# P0-07 / TC-SEC-002G 对象完成验证与进入 verifying

- 日期：2026-09-10
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-002C/D/E/F、ARCH-GATE-SECURITY-001/002

## 本切片交付

- 新增 `BeginSecurityMigrationVerificationHandler`，只接受 tenant、migration ID、expected version 与时间；project/root/source/target/cursor/count/total 全部来自持久 Migration。
- 在同一事务内重建当前 resumable inventory，要求 Migration 为 active，cursor 命中最后一项，`migratedItems=totalItems=当前清单数量`，并由 TC-SEC-002F 的前缀验证证明每一项均为 target domain/epoch。
- 只有对象完成闸门通过后，才使用领域 `transitionSecurityMigration` 生成 active→verifying，并通过 `saveProgressPreservingPlan` 的计划不可变与 CAS 守卫保存。
- verifying 继续由 `effectiveSecurityDomains` 返回旧域与新域交集；本片没有 committed 路径，不宣称索引、投影或全通道验证完成。
- 未修改对象、adapter、Schema、ACL、结构冻结、撤权、最后管理员、事件、Outbox、Job、API/UI。

## 自动验收证据

- Memory/SQLite 对 source→target 与 source→public 的完整对象清单进入 verifying；cursor、count、total 与计划保持，Migration version 恰好 +1。
- incomplete、planned、missing、stale Migration version、total mismatch 与 out-of-order target 均拒绝，持久 Migration 不变。
- SQLite 双连接以同一 expected version 并发推进恰好一次成功；重启后仍为 verifying，旧域与新域权限交集保持。
- 独立安全 Review PASS，确认完成判定、状态机、事务、CAS、租户/项目/子树及权限交集边界均未出现旁路。
- 定向迁移回归 23/23。
- `pnpm check`：TypeScript、140/140 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 通过。

## 剩余项

- 搜索、通知、实时、下载、导出与外部协作投影达到目标 epoch 的真实证据尚未实现，因此不得 committed。
- 迁移期核心 API 仍使用项目级冻结；下一片先在读取路径实现逐对象旧域∩新域，再逐通道扩展。
- 迁移创建授权、Job lease/retry、rollback/recovery、事件/Outbox、嵌套域、节点移动与 U2/U7/U8 不在本片范围。
- 迁移时间的单调性与物理数据库越权篡改仍是后续加固项；当前不放宽权限。

本片只证明产品对象已经完整到达 target 并安全进入 verifying，不宣称完成迁移或 P0-07。
