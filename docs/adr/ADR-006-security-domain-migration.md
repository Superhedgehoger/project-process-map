# ADR-006：安全域移动的持久迁移与权限交集

- 状态：Accepted
- 日期：2026-09-04
- 关联：CR-003、P0-07

## 决定

- 安全域移动不是一次“大事务”，而是持久 `SecurityDomainMigration` 与逐项检查点。
- 状态为 `planned → active → verifying → committed`；临时失败进入 `retryable`，需人工判断的失败进入 `recovery_required`。
- active 至 committed 前，所有 API、搜索、通知、实时、下载和导出均要求同时具备旧域与新域权限；失败不会放宽该交集。
- 迁移期间冻结会改变范围的结构写入；撤权仍即时生效。索引和可见性投影达到目标 epoch 后才能提交。
- 历史事件的可见性不因移出敏感域自动放宽；显式解密/解密级别降低须走单独审计命令。

## 验收

- 每个批次边界崩溃后可从 cursor 续跑。
- 已迁与未迁对象在所有读取通道表现一致，不泄露名称、计数或存在性。
- `retryable/recovery_required` 永久保持旧/新权限交集，直到恢复或受审计回滚。

