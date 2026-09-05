# P0-07 / TC-SEC-003B：Grant API 与固定身份无泄漏矩阵

## 目标

只在已验收的 `ManageSecurityGrantHandler` 上增加薄 Product API 与 canonical browser client 契约，并用固定身份配对和 HTTP 并发证明 TC-SEC-003 的领域守卫没有被适配层绕过。本片不增加 Grant 查询、成员配置或 UI，也不宣称完成全通道 ACL。

## 直接依据

- PRD V1.3：权限矩阵、“设置敏感节点及授权名单”、最后敏感管理员保护。
- FC-1.2：FC-013。
- 数据与权限规格：5.1 两层授权、5.3 判定顺序、5.4 核心权限矩阵、11 固定权限身份。
- 测试与验收：U0～U9、TC-SEC-003、权限通道矩阵单对象 API 与安全测试。
- ADR-003、ADR-004、ADR-006、ADR-008。
- 已验收前置：`ca94b6e` 与 `docs/reports/P0-07-TC-SEC-003A-grant-write.md`。

## API 契约

- `POST /api/security-domains/{domainId}/grants/{targetPrincipalId}/actions/{set|revoke}`。
- `set` body：`capability`、`expiresAtUtc`（UTC 或 null）、`expectedGrantVersion`（新增为 null）、`expectedDomainVersion`、`reason`。
- `revoke` body：`expectedGrantVersion`、`expectedDomainVersion`、`reason`；不得接受 capability/expiry。
- 两类成功与合法幂等回放统一返回 200 `CommandResult<SecurityGrantView>`，不为区分新增而预读 Grant。
- actor/tenant 来自认证身份，domain/target/action 来自 URL；客户端不得提交或覆盖 actor、tenant、project、grantedBy、status、version 或 permissionVersion。
- URL 与 body 使用严格解码；未知字段和安全字段伪造以 `VALIDATION_FAILED` 拒绝且不写入。

## 必须保持的不变量

1. Route 只映射输入并调用 003A handler，不预读 Domain、Target 或 Grant，避免 TOCTOU 与存在性泄漏。
2. 无权或不应知存在时，真实/不存在 domain 与真实/不存在 target 返回完全相同的 404 code/message/body，且不含 ID、理由或成员状态。
3. U6 必须同时为 active user、active 项目经理与永久 `manage_access` 才能写；U0/U1/U2/U3/U4/U5/U7/U8/U9 均不能因角色、view/edit 或旧回执绕过。
4. 同 key 同 payload 回放为 200 + `replayed:true`，不重复事件、Outbox、审计；撤权或到期后先复鉴权并返回 404。
5. Domain/Grant 版本冲突与最后管理员保护映射 409；最后管理员 revoke/downgrade/tempify 和 API 并发互撤不能留下部分写或零管理员。
6. 响应、错误、事件、Outbox 与审计不得包含 reason、联系信息或完整 Grant/Domain 对象。
7. canonical browser client 必须 URL encode、携带稳定 Idempotency-Key、按现有幂等重试策略调用，并拒绝响应契约漂移。

## 固定身份证据边界

- U0 非项目成员、U1 普通成员、U3 无敏感 Grant 项目经理、U4 viewer、U5 editor、U9 刚撤权者：按真实模型建立并验收。
- U2 节点负责人、U7 系统管理员、U8 紧急访问者在当前领域模型没有真实角色/流程；不得用 service 或普通用户冒充后宣称完整实现。只记录当前认证身份不具备 project_manager + permanent manage_access 时 404，并把真实模型列为后续前置。
- 必须至少配对 U3↔U6、U7 无绕过证据↔U6、U4 Node GET 200↔Grant POST 404、U9 旧回执 404。

## 允许修改

- `apps/product-api/src/routes/project.ts`、`apps/product-api/src/app.ts`，必要时 `apps/product-api/src/http.ts`
- `packages/contracts/src/project-process-map-api.ts`
- `packages/api-client/src/project-process-map-client.ts`
- 与本任务直接相关的 tests、测试 fixture、状态、验收报告和 checkpoint

## 明确不做

- Grant GET/list、成员枚举或授权名单查询。
- 成员配置、组织管理员/节点负责人/紧急访问新领域模型。
- UI、嵌套域、非空子树迁移、全通道 ACL。
- 修改 003A 的领域/持久化规则，除非独立 Review 发现阻断缺陷。

## 验收

- U6 set/change/expiry/revoke、幂等与异 payload 冲突均通过严格响应 decoder。
- 最后管理员三类拒绝经 API 返回稳定 409；两个独立 HTTP 请求互撤至多一个成功，最终保留可操作永久管理员。
- 无权 existing/missing domain/target 的 404 body 完全相同；安全字段伪造和未知字段无写入。
- U0～U9 矩阵按“真实覆盖/模型限制”如实报告，不把未建模身份冒充为已完成。
- 客户端路径、header、重试和漂移拒绝有契约测试。
- `pnpm check`、独立安全 Review、Evidence、commit/push 全部通过后进入下一 Ready Task。
