# ADR-003：SaaS 租户、身份与领域权威边界

- 状态：Accepted
- 日期：2026-09-03
- 关联：CR-003、P0-ND-02

## 背景

Phase 0 原型用 Huly actor、workspace 和 Issue 表达用户、租户与任务权威，同时在产品侧保存节点归属、验收和文件信息。这会造成身份外键锁定、Task 双权威、树结构双写与安全域移动期间的越权窗口。

## 决定

### Tenant 与 Principal

- 每个领域实体、命令、事件、幂等键、投影、集成操作和后台任务都必须带 `tenantId`。
- 产品主体使用稳定的内部 `principalId`；操作者、委托者和服务身份均引用该键。
- 外部身份映射键为 `(tenantId, provider, providerTenantId, providerSubjectId)`，映射到一个内部 `principalId`；外部标识不得被其他领域表直接引用。
- 所有查询先绑定可信 TenantContext，再解析资源；不得仅依赖客户端提交的 tenant header。

### Product-owned Task

- Task 是 Task Coordination 边界内的产品聚合，产品持有 title、ownerNodeId、executionState、reviewState、assigneePrincipalId、acceptance policy 与版本。
- 产品生命周期由 `executionState + reviewState` 推导，不保存第二份可漂移的 lifecycle 状态。
- Huly Issue、其他项目协作工具或未来原生看板是 Task 的外部投影。每个投影保存版本化稳定引用与同步水位，但不是产品事实的提交条件。
- 外部状态变化只能转译为显式产品命令；冲突由版本与策略解决，不能静默覆盖验收结果。

### Project Structure

- `ProjectNode.parentId` 是树的唯一写模型权威。
- 跨节点依赖、并行、汇合等非树关系继续由 Relation 聚合表达。
- `parent-child` edge 如为图查询需要，只能从 Node 投影生成并可随时重建。

### Security Domain Migration

- 安全域移动先创建 `SecurityDomainMigration`，记录 source、target、旧/新 epoch、范围、状态、检查点和失败原因。
- 状态依次为 `requested → propagating → verifying → completed`，失败进入 `retryable` 或 `recovery_required`；取消只允许在尚未发布新权限前发生。
- 迁移期间有效权限为旧域与新域权限的交集，避免短暂扩权；后台投影全部验证后，原子提升资源 security epoch。
- 事件保存原始安全域与 epoch，历史可见性通过权限投影判断，不直接广播原始事件载荷。

### Asset / Evidence

- Asset Lifecycle 管理文件版本、校验和、扫描、隔离、删除墓碑与外部 Blob；Evidence 只引用可用 AssetVersion，并表达它对 Task、Node、Deliverable、Decision 等业务对象的用途。
- 外部引用固定为 `{ provider, kind, externalId, schemaVersion }`。扫描状态、文件名、父引用等可变信息不得编码进该引用。
- Asset 状态转换、删除/恢复/清除以及历史保留使用显式状态机和删除矩阵；不得通过覆盖事件历史完成“删除”。

## 结果

产品可以替换 Huly Identity/Tracker，或为不同租户使用不同协作提供方，而不迁移领域主键。Task 验收、看板、通知和自动化围绕同一产品聚合扩展。代价是 Huly 由同步权威改为最终一致投影，需要持久 Integration Operation 和恢复工具。

## 禁止的实现捷径

- 用 Huly workspace/account/Issue ID 作为产品 Tenant/Principal/Task 主键。
- 同时更新 `Node.parentId` 与可写 `parent-child` Relation。
- 在安全域迁移中先开放新域再异步收紧旧域。
- 把完整外部响应或含敏感字段的 before/after 对象直接发送到通用通知 Outbox。

