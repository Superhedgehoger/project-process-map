# P0-07 / TC-SEC-002D：非空子树迁移清单快照

## 目标

为 ADR-006 的持久批次迁移建立只读、确定性的 Node/Task/Asset inventory 与 cursor 基础。给定项目、迁移根和源安全域快照，完整枚举必须迁移的现存对象；本切片不执行换域写入。

## 直接依据

- ADR-005：项目树以 `ProjectNode.parentId` 为唯一层级权威。
- ADR-006：迁移使用持久计划、逐项 checkpoint，批次崩溃后可从 cursor 续跑。
- ADR-007：Asset 快照 owner node 与 security domain/epoch，不由 Huly Attachment 决定归属。
- 已验收前置：TC-SEC-002A/B/C、ARCH-GATE-SECURITY-001/002。

## 必须保持的不变量

1. 子树只从同租户、同项目的权威 `parentId` 闭包计算；Relation、Huly hierarchy 或客户端清单均不得参与。
2. inventory 包含根及全部后代 Node，并包含这些 Node 直接拥有的全部 Task 与 Asset；软删除对象也保留在清单中，避免遗留安全归属。
3. 每项至少包含对象类型、对象 ID、owner/root 关联、当前 securityDomainId/securityEpoch 和 version，供后续批次做条件写与审计。
4. 结果按稳定 tuple 排序并生成不依赖数据库返回顺序的 opaque cursor；Memory/SQLite、重启与重复读取结果完全一致。
5. 根不存在、跨项目、父链断裂/环、子树内对象 owner/project 不一致、源域/纪元漂移或尚不支持的嵌套正式域均 fail-closed，不返回部分清单。
6. inventory 是只读快照；本切片不创建/推进 Migration，不改 Node/Task/Asset，不产生事件、Outbox 或 Job。

## 允许修改

- 新增 application 层 migration inventory 模块与必要 DTO
- persistence 只读端口及 Memory/SQLite 对称实现（例如 Asset `listByNode`）
- 直接相关测试、Phase/Report/Evidence/checkpoint

## 明确不做

- 迁移创建授权与 HTTP/UI。
- Node/Task/Asset 换域、批次事务、事件/Outbox、索引/投影验证、committed/rollback。
- cursor lease/Job worker、嵌套域迁移、节点移动、U2/U7/U8 或 Schema 变化。

## 验收

- Memory/SQLite 对多层非空子树产生逐项一致的完整 inventory、totalItems 与 cursor 序列。
- 非连续 ID、软删除对象与空子树覆盖；重复读取和 SQLite 重启完全确定。
- 跨项目、断链/环、归属漂移、源域/epoch 漂移、嵌套正式域均 fail-closed 且不返回 partial result。
- 静态检查证明只读取 `parentId` 权威，并且没有对象换域写入。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再进入专用批次换域端口。
