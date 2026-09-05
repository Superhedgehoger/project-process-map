# P0-07 / TC-SEC-003A：Grant 写模型与最后管理员原子守卫

## 目标

在不开放 HTTP/UI 的前提下，建立正式 SecurityGrant 写命令及持久层不变量：授权新增、能力/有效期变更和撤销必须经过同一应用命令，在一个本地事务内完成权限校验、Grant 与 SecurityDomain 权限版本更新、最小事件、Outbox、追加式安全审计和幂等回执；任何并发路径都不能留下零名永久有效的 `manage_access`。

本任务是 L 级 P0-07 的一个小切片。完成后再单独开放 Grant API、成员配置和固定身份矩阵。

## 直接依据

- FC-1.2：FC-013。
- 数据与权限规格：SecurityDomain / Grant、5.1 两层授权、5.3 判定顺序、5.4 敏感授权。
- 测试与验收：TC-SEC-003、权限通道矩阵、安全测试中的 Grant 伪造/最后管理员撤销。
- ADR-003、ADR-004、ADR-006、ADR-008。
- 已验收前置：`81cef4d` 与 `docs/reports/P0-07-TC-SEC-001-first-security-root.md`。

## 允许修改

- `packages/domain/src/security-access.ts`
- `packages/application/src/security/` 下本任务直接相关文件
- `packages/application/src/access/project-security.ts`
- `packages/application/src/ports/persistence.ts`
- `packages/application/src/errors.ts`
- `packages/adapters/src/{memory,sqlite}/persistence.ts`
- 与本任务直接相关的 tests、`docs/phase0-status.md`、本任务验收报告和 checkpoint

## 必须保持的不变量

1. 只有 active 项目经理且当前持有该正式域的 active、未过期 `manage_access` 才能写 Grant；项目经理和系统管理员不自动绕过。
2. 目标主体必须是 active Principal 与 active 项目成员；MVP 不增加用户组主体。
3. 新增、改能力、改有效期、撤销均使用专门命令和乐观版本；不得重新暴露无守卫的通用 `securityGrants.update`。
4. 成功提交后，每个正式域始终至少保留一名 active、无到期时间的 `manage_access`；撤销、降级、设置有效期及并发请求都不能绕过。
5. Grant 变化原子递增 `SecurityDomain.permissionVersion`，并与 Grant、最小 DomainEvent、Outbox、安全审计、回执同成败。
6. 幂等回放前重新读取当前 Principal、Membership、Grant 与时间；撤权或过期后不能靠旧回执成功。
7. 跨租户、跨项目、遗留 v3 域、嵌套域和进行中迁移全部 fail-closed；TC-SEC-002 行为不得混入本任务。
8. 对无权调用者不泄漏域、Grant、成员或目标主体存在性；错误和事件载荷不得包含理由、联系信息或完整对象。

## 明确不做

- HTTP/UI、成员管理页面、授权名单查询。
- 嵌套域、非空子树迁移、紧急访问、用户组 Grant。
- 搜索、通知、实时、ZIP 等全通道 ACL。
- 改变 PRD/FC 或 ADR 产品规则。

## 验收

- Memory 与 SQLite 行为一致，覆盖成功、幂等、故障注入、重启与并发。
- 覆盖新增管理员后撤销旧管理员成功，以及撤销/降级/临时化最后永久管理员失败且无部分写。
- 覆盖无权、过期 Grant、撤销成员/Principal、跨租户/项目、legacy 域、迁移中冻结。
- DomainEvent / Outbox / 安全审计不含审计理由或敏感对象正文。
- `pnpm check` 通过，独立安全 Review PASS，验收报告与 checkpoint 更新后方可提交。
