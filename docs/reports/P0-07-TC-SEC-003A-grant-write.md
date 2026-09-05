# P0-07 / TC-SEC-003A Grant 写模型与最后管理员原子守卫

- 日期：2026-09-05
- 状态：通过子切片验收；P0-07 总项保持进行中
- 产品依据：FC-013、TC-SEC-003、权限通道矩阵
- 架构依据：ADR-003、ADR-004、ADR-006、ADR-008

## 本切片交付

- 新增应用层 `ManageSecurityGrantHandler`，统一处理 Grant 新增、能力/有效期变更和撤销；不开放 HTTP/UI，也不恢复通用无守卫 `update`。
- 操作者在幂等回放前必须重新通过 active user、active 项目经理、当前 active 且未过期 `manage_access` 检查。项目经理、服务身份和旧成员安全域列表均不构成绕过。
- 目标必须是同租户、同项目的 active user 与 active 成员。Domain 必须与正式根节点成对存在；跨项目、legacy、嵌套域和迁移中项目全部 fail-closed。
- 每次成功写入同时递增 Grant 版本、`SecurityDomain.version` 与 `permissionVersion`，并原子追加最小 DomainEvent、Outbox、安全审计和幂等回执。
- Memory 与 SQLite 的专用持久化守卫都要求结果中至少保留一名可操作永久管理员：active user、active `project_manager`、active 且无到期时间的 `manage_access` Grant。
- SQLite 在写前校验双版本、不可变 Domain/Grant 字段及最后管理员，并以方法内 SAVEPOINT 保证调用方即使捕获错误也不能提交半完成 Grant。SQLite `read` 使用最终必回滚事务，与 Memory 快照读保持一致。
- Grant 事件的 `originalSecurityEpoch` 来自根节点并保持稳定；递增的权限版本仅记录为 `permissionVersion`，避免混淆资源安全纪元与授权缓存版本。
- schema v5 新增追加式 `security_grant_audits`；真实 v4→v5 回归验证已有 SecurityDomain 与 Grant 均被保留。

## 自动验收证据

- `tests/security-grant.test.ts` 19 项通过，覆盖成功、同回执回放、撤销/降级/临时化最后管理员拒绝、替代管理员、普通成员 Grant 不计入管理员、双管理员互撤并发和 SQLite 重启。
- 权限拒绝覆盖：无 Grant 的项目经理、服务身份、跨租户、跨项目、legacy、嵌套域、迁移中项目、已过期 Grant、撤销成员或 Principal，以及撤权/到期后的旧回执回放。
- 五个故障注入点均验证 Grant、Domain、审计、事件、Outbox 和回执整体回滚；另覆盖持久层错误在事务回调内被捕获、以及从 `read` 回调尝试写入的回滚行为。
- 连续两次 Grant 变化的事件断言为安全纪元 `[2, 2]`、权限版本 `[2, 3]`，证明两个版本维度没有混用。
- `pnpm check`：TypeScript、94 项测试、14 个 Huly ARM64 镜像锁和薄宿主边界全部通过。
- 独立安全 Review：最终 PASS；首轮发现的 SQLite 部分提交风险和事件纪元语义问题均已修复并加入回归测试。

## 残余风险与明确未完成

本报告只接受无 HTTP/UI 的 Grant 领域写模型，不能据此关闭 P0-07：

- 后续成员降级、成员撤销和 Principal 撤销入口必须复用可操作永久管理员不变量，不能通过其他写路径把域留在零管理员状态。
- Grant API、成员配置 UI、授权名单查询、固定身份矩阵及无存在性泄漏的 HTTP 配对验收尚未实现。
- 非空子树迁移、嵌套域权限交集与 TC-SEC-002 仍需 ADR-006 的持久迁移流程。
- 搜索、通知、实时、ZIP、导入、批量操作等全通道 ACL 尚未完成；当前事件进入新消费者前仍需验证接收方权限。
- 当前并发证据为同进程双 SQLite 连接；多进程和未来 PostgreSQL 实现必须复用同一行为契约与数据库约束。

下一片进入 P0-07 / TC-SEC-003B：只在已验收写模型上开放 Grant API，并补固定身份与无泄漏配对矩阵；不扩展到 UI 或迁移。
