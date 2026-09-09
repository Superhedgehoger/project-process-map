# P0-07 / TC-SEC-002A：敏感父节点下新建后代的同域继承

## 目标

解除当前“敏感节点下禁止新建后代”的临时拒绝，但只允许新节点由服务端原子继承父节点的正式 `securityDomainId` 与当前 `securityEpoch`。本片不处理既有节点换域、非空子树迁移或嵌套 SecurityDomain。

## 直接依据

- PRD V1.3：敏感节点的后代必须保持同等访问约束；项目经理负责项目结构管理。
- FC-1.2：FC-013。
- 数据与权限规格：项目 RBAC ∩ Grant、按对象 SecurityDomain 判定、授权失败最小泄漏。
- 测试与验收：TC-SEC-001、TC-SEC-002、撤权立即生效与跨域伪造拒绝。
- ADR-003、ADR-004、ADR-006、ADR-008。
- 已验收前置：TC-SEC-001、TC-SEC-003A/B/C。

## 必须保持的不变量

1. 客户端创建普通 Node 时仍只能提交 `securityDomainId: null`；非空值继续返回 `SECURITY_DOMAIN_ASSIGNMENT_REQUIRES_COMMAND`，不得借本片伪造域或跨域。
2. 父节点公开时，新节点仍公开且 `securityEpoch = 1`；父节点属于正式、未删除、非嵌套 SecurityDomain 时，新节点必须由服务端继承父节点的 `securityDomainId` 与当前 `securityEpoch`。
3. 敏感父节点下创建要求 actor 为 active user、同项目 active `project_manager`，且对父域具有当前有效 `edit` 或更高 Grant；RBAC 与 Grant 缺一不可。
4. existing/missing/cross-project 父节点以及无权访问正式父域必须 fail-closed，不泄漏父节点或域存在性。legacy-only、嵌套域、开放 SecurityDomainMigration 均拒绝。
5. 幂等回放前必须重新读取 actor Principal、Membership、父节点、Domain 与 Grant；撤权、降级或撤销后不能利用旧回执。
6. Node、最小事件、Outbox 与回执必须在同一事务提交，事件的 `originalSecurityDomainId/originalSecurityEpoch` 与实际继承结果一致。
7. 新节点上的 Task 与 Asset 必须继续沿既有链路继承相同正式域；不得出现短暂公开后代。
8. 事件必须复用已注册的 `project-map.node.created` v1 Schema；若 payload 形状变化，先按 ADR-008 更新注册与兼容 fixture。

## 允许修改

- `packages/application/src/create-node.ts`
- 必要时 `packages/application/src/access/project-security.ts`、`packages/application/src/errors.ts`
- 直接相关测试、Task Packet、Phase/Report/Evidence/checkpoint

原则上不修改 Domain、Persistence adapter 或 SQLite Schema；若事实证明必须修改，先重新拆 Task，不得在本片暗中扩域。

## 明确不做

- 既有 Node 或非空子树换域、ADR-006 批次迁移。
- 在敏感父域内创建更严格的嵌套 SecurityDomain。
- Node Owner、organization/system_admin、Emergency Access。
- 节点移动、负责人/角色槽位。
- HTTP/UI 新入口以及关系、搜索、通知、实时、文件、ZIP、复盘等全通道加固。
- 宣称完成整个 TC-SEC-002 或 P0-07。

## 验收

- Memory/SQLite：公开父节点行为不回归；有权项目经理在敏感父节点下创建后代并准确继承域/纪元。
- Node、事件、Outbox、回执同成败；四个现有故障注入点均无部分提交。
- Task/Asset 在新敏感后代上继承同域。
- 普通成员即使有 edit Grant、无 Grant 项目经理、撤销 Membership/Principal、过期 Grant、legacy/nested/migrating 项目均拒绝。
- existing/missing 父节点无权探测结果一致；客户端非空域与跨项目父节点拒绝。
- 回放前撤销 Grant 或降级/撤销 actor 后拒绝；异 payload 幂等冲突稳定。
- SQLite 重启与同 nodeId 并发保持单一事实；`pnpm check`、独立安全 Review、Evidence、commit/push 通过。
