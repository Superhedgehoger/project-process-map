# P0-07 / TC-SEC-002K：安全域迁移的外部可见性收敛与全通道纪元就绪守卫

## 目标

在 TC-SEC-002J 关闭迁移期新出站协作投影旁路的基础上，为安全域迁移建立从 verifying 到 committed 或 rollback 的外部可见性收敛与全通道纪元就绪验证闸门：在所有外部协作通道（Huly Issue/Attachment/Blob）与本地持久通道完成历史副本收敛确认、且确认所有相关对象均已安全对齐目标 securityEpoch 之前，严禁直接进入 committed；若迁移需要回滚，亦须具备受控且原子审计的纪元回滚与状态对齐。

## 直接依据

- ADR-003：Product Task/Asset 是权威事实，Huly 只是可恢复异步投影。
- ADR-005：范围只由产品 Node.parentId 与 Task/Asset ownerNodeId 决定。
- ADR-006：迁移期间所有读取/可见性通道保持旧域∩新域，索引与可见性投影达到目标 epoch 后才能 committed。
- ADR-007：Asset/Blob 外部副本不是下载或 ACL 权威。
- 已验收前置：TC-SEC-001、TC-SEC-002A～J、TC-SEC-003A/B/C、ARCH-GATE-HULY-001/002、ARCH-GATE-RECOVERY-001。

## 必须保持的不变量

1. 迁移 committed 必须且只能在 Migration 处于 verifying 且所有 inventory 对象均已完成换域、所有外部协作历史副本完成收敛确认、且出站 fence 均已安全清理时方可触发。
2. 只要有任何未收敛的外部协作投影操作、活跃出站 fence 或目标 securityEpoch 尚未在所有通道就绪，committed 状态转移必须 fail-closed。
3. 迁移回滚（rollback）必须由严格受控命令驱动并具备完整审计日志，确保对象安全归属与纪元一致恢复，不得造成悬空状态或单向权限泄露。
4. 保持 ADR-004 的 UoW/Outbox/Job 边界，绝不在持有本地数据库事务期间跨越外部 Huly 网络调用。
5. 不弱化现有的租户隔离、逐对象权限交集（TC-SEC-002H/I）与出站冻结（TC-SEC-002J）。

## 允许修改

- Migration verifying->committed 状态转移守卫与持久化验证
- 外部协作纪元对齐/收敛状态判定端口与适配器
- 迁移完成与受控回滚的领域逻辑及契约测试
- Phase/Report/Evidence/checkpoint

## 明确不做

- Huly 端的全量 space/ACL 物理改造。
- 搜索、通知、实时通道的多副本生产实施。
- 绕过 verifying 直接 committed 的捷径命令或接口。

## 验收

- verifying 状态在外部副本未收敛、存在活跃出站 fence 或存在未决协作操作时严格拒绝 committed。
- 全部通道纪元就绪且 fence 清理完成后，方可通过受保护的领域端口原子推进至 committed，解除权限交集与迁移冻结。
- `pnpm check`、独立安全 Review、Evidence、commit/push。
