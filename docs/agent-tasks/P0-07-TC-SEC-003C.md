# P0-07 / TC-SEC-003C：ProjectMembership 限权写模型与最后管理员原子守卫

## 目标

关闭 `ProjectMembershipRepository.update` 可绕过 TC-SEC-003A/003B、通过成员降级或撤销清空可操作永久管理员的现存旁路。本片只建立收紧型成员生命周期的应用命令与 Memory/SQLite 跨域原子守卫，不开放 HTTP/UI。

## 直接依据

- PRD V1.3：项目经理管理成员；每棵敏感子树始终保留敏感内容管理员。
- FC-1.2：FC-013。
- 数据与权限规格：项目 RBAC ∩ Grant、5.3 判定顺序、授权变化审计、权限版本与稳定决策码。
- 测试与验收：TC-SEC-003、Grant 伪造/最后管理员撤销、并发与撤权立即生效。
- ADR-003、ADR-004、ADR-006、ADR-008。
- 已验收前置：`ca94b6e`、`a406124` 及相应验收报告。

## 本片操作

- `demote`：active `project_manager` → active `member`。
- `revoke`：active membership → `revoked`，角色值保持不变。
- 不做新增、重新激活、升任项目经理、Principal 全局撤销、HTTP/UI。

## 必须保持的不变量

1. 操作者必须是 active user 与同项目 active `project_manager`。这是项目成员管理，不要求操作者读取目标敏感内容；持久层必须在不泄漏域信息的前提下兜住全部敏感影响。
2. Target 必须是 active user 和同项目 active Membership；跨租户/项目或不存在目标 fail-closed。命令不得改变 tenant/project/principal/createdAt/legacy `securityDomainIds`。
3. 幂等回放前重新读取 actor Principal/Membership 与 target Membership；actor 撤销或降级后不能利用旧回执。
4. 结果必须让每个正式域仍至少保留一名 active user + active project_manager + active、无到期 `manage_access` Grant。任一域失败则整个多域操作回滚并返回 `SECURITY_DOMAIN_LAST_ADMINISTRATOR`。
5. Membership 变化会改变 RBAC∩Grant。对 Target 拥有当前有效 Grant 的每个正式域，必须原子递增 `SecurityDomain.permissionVersion` 与 `version`；不得修改 Grant 行或把 legacy v3 列表升级为正式域。
6. Membership、全部受影响 Domain 版本、逐域最小事件/Outbox、追加式成员安全审计与回执在同一事务中提交。
7. Memory/SQLite 专用保存方法自身执行 Membership CAS、不可变字段、跨域最后管理员和 Domain CAS；即使调用方捕获错误，也不能提交部分状态。
8. 移除生产端口的通用 `memberships.update`。测试撤权应使用新命令或受控 fixture，不得保留可调用旁路。
9. 输出只含最小 Membership view 与已授权 actor 可见的权限版本结果；事件/审计/错误不得包含 reason、Grant/Domain/Membership 正文或敏感节点信息。

## 允许修改

- `packages/domain/src/project-access.ts`
- `packages/application/src/security/` 下本任务文件
- `packages/application/src/ports/persistence.ts`、`packages/application/src/errors.ts`
- `packages/adapters/src/{memory,sqlite}/persistence.ts`
- 直接相关 tests、fixture、状态、报告和 checkpoint

## 明确不做

- Member/Grant HTTP、查询名单或 UI。
- 成员新增、恢复、升任，Principal 全局撤销。
- Node Owner、organization/system_admin、Emergency Access。
- 嵌套域、非空子树迁移或全通道 ACL。

## 验收

- Memory/SQLite demote/revoke 成功，Membership CAS、全部受影响 Domain 双版本 +1、事件/Outbox/审计/回执同成败。
- 最后管理员 demote/revoke 稳定失败；有替代管理员后成功；多域中任一域无替代则全回滚。
- 两个 SQLite 连接并发收紧两名管理员，至多一个成功；重启后状态、版本、审计、回执一致。
- 故障注入与“持久层错误被回调捕获”均无部分提交。
- 幂等/异 payload、actor 撤销或降级后回放、无权与目标不合格、stale versions、legacy-only 均 fail-closed。
- 静态检查证明无通用 `memberships.update`；真实 v5→v6 升级保留现有安全数据。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后进入下一 Ready Task。
