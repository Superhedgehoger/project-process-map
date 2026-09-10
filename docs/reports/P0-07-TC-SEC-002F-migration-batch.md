# P0-07 / TC-SEC-002F 迁移批次与 checkpoint 原子编排

- 日期：2026-09-10
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-002C/D/E、ARCH-GATE-SECURITY-001/002

## 本切片交付

- 新增 `ExecuteSecurityMigrationBatchHandler`，调用方只提供 tenant、migration ID、expected Migration version、受限 batch size 与时间；project/root/source/target/cursor 全部来自持久 active Migration。
- 新增事务内 resumable inventory。原 TC-SEC-002D 全 source reader 保持不变；续跑路径要求 cursor 精确命中稳定清单且位置等于 migratedItems，完成前缀逐项属于 target domain/epoch，未完成后缀逐项属于 source domain/epoch。
- 每批严格从 migratedItems 位置选择最多 100 项，逐项调用 TC-SEC-002E 条件端口；checkpoint 固定使用本批最后一项 cursor，进度只增加实际成功项数。
- 对象写与唯一 checkpoint 位于同一 `Persistence.transaction`。任一 Node/Task/Asset 写或真实 Migration CAS 失败时，Memory draft 与 SQLite `BEGIN IMMEDIATE` 均整批回滚。
- 剩余集为空时返回稳定 complete no-op，不伪造 cursor、进度或 Migration version；本片不推进 verifying/committed。
- 未新增 Schema、事件、Outbox、Job、API/UI，也未放宽结构冻结、普通保存、ACL、撤权或最后管理员守卫。

## 自动验收证据

- Memory/SQLite 以 2+2+末批完成相同六项稳定顺序，migratedItems 为 2/4/6；source→target 与 source→public 均可跨批续跑。
- 完成后空批不写 checkpoint；所有对象仅迁移一次，版本恰好 +1。
- Node、Task、Asset 注入失败与对象写后的真实 stale checkpoint CAS 分别验证整批对象和 Migration 进度完全不变。
- planned、missing Migration、stale Migration version、零/超限 batch size 与 totalItems/inventory 不一致均在写前拒绝。
- missing/伪造/null cursor、cursor 与 migratedItems 错位、完成前缀回漂 source，以及未完成后缀提前 target 均在两个 adapter fail-closed。
- SQLite 双连接以同一 expected Migration version 竞争恰好一成一败；重启后从持久 cursor 完成剩余项，无跳项或重复计数。
- 独立安全 Review 初次与补测复审均 PASS；确认对象写/checkpoint 同事务、持久计划唯一决定范围与目标，未发现 ACL、跨项目或最后管理员旁路。
- 定向迁移回归 17/17；最终 batch 定向测试 7/7。
- `pnpm check`：TypeScript、137/137 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 通过。

## 剩余项

- 迁移计划只持久 totalItems 与 cursor，不持久对象 ID 全快照；当前依赖受信 repository、逻辑删除与迁移期间结构冻结。绕过产品端口直接物理替换等量对象不在本期威胁边界。
- 进入 verifying、索引/搜索/通知/实时/下载/导出目标 epoch 验证、committed/rollback 尚未完成。
- 迁移创建授权、Job lease/retry、事件/Outbox、嵌套域、节点移动与 U2/U7/U8 不在本片范围。

本片只交付可恢复的对象批次与 checkpoint 原子闭环，不宣称完成非空子树迁移或 P0-07。
