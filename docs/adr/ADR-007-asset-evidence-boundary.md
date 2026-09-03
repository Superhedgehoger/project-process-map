# ADR-007：Asset 生命周期与 Evidence 绑定边界

- 状态：Accepted
- 日期：2026-09-04
- 关联：CR-003、C1、C2

## 决定

- Asset 是支持性领域边界，负责文件版本、哈希、扫描、隔离、逻辑删除和 Blob 副本；它不是新的导航模块或微服务要求。
- Task、Node、Blocker、Record、Deliverable、Decision 通过 `AssetBinding` 引用 Asset，不再各自复制 FileMetadata。
- Asset 继承并快照 tenant、project、owner node、安全域和 epoch；绑定时必须解析目标上下文并验证完全一致。
- 生命周期为 `initiated → uploading → scanning → available`，失败可从 `failed` 新尝试，扫描可进入 `quarantined`，业务删除进入不可下载的 `deleted` 墓碑。
- Blob 清理异步可重试；清理失败不得复活已删除 Asset。外部引用仅含 provider/kind/externalId/schemaVersion，不编码扫描状态、文件名或嵌套引用。

## 验收

- 同一 Asset 模型可受控绑定多种业务目标而不改表。
- 扫描状态变化不改变外部引用；失败重试不重复 Asset。
- 删除立即拒绝下载并失效 Evidence，外部 Blob 清理失败只进入恢复队列。

