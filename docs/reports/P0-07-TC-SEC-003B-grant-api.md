# P0-07 / TC-SEC-003B Grant API 与固定身份无泄漏矩阵

- 日期：2026-09-05
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 产品依据：PRD V1.3 权限矩阵、FC-013、TC-SEC-003、固定身份与权限通道矩阵
- 架构依据：ADR-003、ADR-004、ADR-006、ADR-008

## 本切片交付

- 新增单一命令式入口 `POST /api/security-domains/{domainId}/grants/{targetPrincipalId}/actions/{set|revoke}`；Route 不预读 Domain、Target 或 Grant，只把认证身份、URL 与严格 body 映射到已验收的 `ManageSecurityGrantHandler`。
- set 支持新增、能力变更和有效期变更；revoke 只接受双版本与理由。两类成功及合法回放统一返回 200，避免为选择状态码引入 TOCTOU 读取。
- 请求拒绝未知字段和 actor/tenant/project/grantedBy/status/version/permissionVersion 等安全字段伪造。Domain 与 Target 只取 URL，Actor 与 Tenant 只取认证上下文。
- Domain/Grant 版本冲突与最后管理员保护显式映射 409；无权且不应知存在时保持统一 404。响应只含最小 Grant view，不含 reason、审计或完整领域对象。
- canonical browser client 增加 set/revoke 方法，编码路径段、复用稳定 Idempotency-Key 与现有安全重试，并以严格 capability/status/UTC/version decoder 拒绝响应漂移。

## 自动验收证据

- U6 经 API 完成新增、能力变更、限时变更、撤销、合法回放和异 payload 冲突；响应经共享 contract decoder 验证。
- 最后一名永久管理员的撤销、降级、临时化均返回 409 `SECURITY_DOMAIN_LAST_ADMINISTRATOR` 且状态不变；两个独立 API handler 并发互撤最多一个成功，最终保留一名永久管理员。
- U0 非成员、U1 普通成员、U3 无 Grant 项目经理、U4 viewer、U5 editor、U9 刚撤权者均有拒绝证据；U4 同时证明敏感 Node 可读但 Grant 写 404，U9 证明旧成功回执在撤权后仍为 404。
- U3 针对 existing/missing Domain × existing/missing Target 的四组探测得到完全相同 404 body，且不含 Domain ID、Target ID 或 reason。
- 未知/伪造字段、缺 Idempotency-Key、revoke null version 均返回稳定 422 且不产生授权写入。
- browser client 覆盖特殊字符路径编码、503 重试保持同一 Idempotency-Key、响应 capability 漂移拒绝。
- 定向 TypeScript 与 API/client 测试 19/19；`pnpm check` 当前为 98/98，14 个 Huly ARM64 镜像锁和薄宿主边界通过。
- 独立安全 Review 首轮复现非法日历时间、decoder 额外字段透传、畸形 URL 误报 502 和 U6 证据不足；修复后复审 PASS，29 项定向复验通过。

## 固定身份的诚实覆盖边界

- U0、U1、U3、U4、U5、U6、U9 使用当前真实 Principal、ProjectMembership 与 SecurityGrant 模型覆盖。
- 当前模型没有 Node Owner、organization/system_admin 和 Emergency Access 实体，因此 U2、U7、U8 只验证“认证身份没有 project_manager + permanent manage_access 时不能写”，不冒充或宣称真实角色已经完成。
- Product API 当前仍固定 `phase0-project`；本片没有扩展通用项目解析、成员枚举或授权名单读取。

## 明确未完成

- Grant GET/list、成员配置与 UI。
- 真实节点负责人、系统管理员和紧急访问领域模型及相应 U2/U7/U8 完整矩阵。
- 嵌套域、非空子树迁移与 TC-SEC-002。
- 搜索、关系、通知、实时、文件、ZIP、复盘等全通道 ACL；本片只验收新增的单对象 Grant 写 API。

下一片必须继续 P0-07 的成员生命周期/最后管理员守卫或按依赖进入固定身份模型；不能仅凭本 API 解除公网监听闸门。
