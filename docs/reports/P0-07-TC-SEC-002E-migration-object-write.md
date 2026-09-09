# P0-07 / TC-SEC-002E 对象换域专用持久端口

- 日期：2026-09-09
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-002B/C/D、ARCH-GATE-SECURITY-001/002

## 本切片交付

- Node、Task、Asset repository 新增迁移专用 `migrateSecurityOwnership(migrationId, objectId, expectedVersion)`；目标安全域与纪元只能来自持久 Migration，不接受调用方自带目标值。
- Memory/SQLite 在写入前要求 Migration 存在且为 active，验证正纪元、非 no-op、同租户、同项目、位于迁移根 parentId 子树且对象仍为计划 source domain/epoch。
- 三类对象只改变 `securityDomainId`、`securityEpoch` 与恰好 +1 的 `version`；Task/Asset 的业务 JSON 由 current 快照定点重建，Node 只更新对应关系列。
- missing、stale CAS、范围外、错误 source、非 active 与 already-target 均 fail-closed；事务 callback 捕获错误不留下部分对象变更。
- `SecurityDomainMigrationRepository.insert` 同步收紧为只接受合法初始 planned 记录。任意 active、伪造 cursor/progress/version、无变化 ownership 不能直接插入；激活必须走领域 transition 与 `saveProgressPreservingPlan` 的计划不可变/CAS 守卫。
- 普通 Task/Asset 保存、首敏感根 `assignSecurityDomain`、Migration 进度保存及现有 ACL/最后管理员规则均未放宽。

## 自动验收证据

- Memory/SQLite 对 Node/Task/Asset 的 source→target 与 source→public 均通过逐字段 deep equality，仅安全归属、纪元和版本变化。
- 两个 adapter 对三类对象的 stale、missing、迁移根范围外及 already-target 对称拒绝；planned、错误 source epoch、错误 project 与 missing migration 拒绝。
- SQLite 双连接竞争恰好一成一败；重启后 Task 的目标归属与版本保持一致。现有一致性 decoder 继续在写前拒绝 Task/Asset row/JSON 漂移。
- forged-active 初始写入回归同时覆盖 Memory/SQLite，并确认拒绝后未留下 Migration 记录。
- 独立安全 Review 首轮识别 generic `insert(active)` 可自证可信 Migration；加入初始计划 validator、双 adapter insert gate 与回归测试后复审 PASS。
- 定向复验 61/61；最终迁移相关定向测试 10/10。
- `pnpm check`：TypeScript、130/130 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 通过。

## 剩余项

- 迁移创建授权、目标域存在性/同项目与管理员策略留给受授权创建命令，不由低层对象写端口决定。
- 批次选择、对象写与 cursor checkpoint 原子编排、lease/retry、结构冻结、事件/Outbox、索引/投影验证及 committed/rollback 尚未完成。
- 嵌套域迁移、节点移动与 U2/U7/U8 不在本片范围。

本片只交付可信 active Migration 约束下的单对象换域原语，不宣称完成非空子树迁移或 P0-07。
