# P0-07 / TC-SEC-003C Membership 限权写模型

- 日期：2026-09-09
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 产品依据：PRD V1.3 权限矩阵、FC-013、TC-SEC-003
- 架构依据：ADR-003、ADR-004、ADR-006、ADR-008

## 本切片交付

- 以 `RestrictProjectMembershipHandler` 提供 `demote` 与 `revoke` 两种收紧型成员操作；不开放 HTTP/UI，不扩展成员新增、恢复或升任。
- 移除生产端口的通用 `ProjectMembershipRepository.update`。Memory 与 SQLite 只暴露专用限制保存方法，并在持久层再次校验 Membership CAS、不可变身份字段、合法状态转换、active user 目标和跨域最后管理员不变量。
- Target 在正式域中拥有当前有效 Grant 时，Membership 变化与全部受影响 `SecurityDomain.permissionVersion/version` 同事务递增；不修改 Grant，也不把 legacy `securityDomainIds` 提升为正式域。
- 任一正式域缺少替代的 active user + active project_manager + 永久 `manage_access` Grant 时，多域操作整体拒绝并返回稳定的 `SECURITY_DOMAIN_LAST_ADMINISTRATOR`。
- SQLite 专用写入使用局部 SAVEPOINT；即使调用事务回调捕获后续 Domain 写错误，已经执行的 Membership UPDATE 也会回滚。
- 追加式成员安全审计、逐域最小事件、Outbox 和幂等回执与领域状态同成败。返回值仅含目标、角色、状态与 Membership 版本，不返回域列表、Grant 或 reason。
- SQLite schema 升至 v6，新增项目成员安全审计表；v5→v6 升级保留既有 SecurityDomain 与 Grant。

## 自动验收证据

- Memory/SQLite 成功撤销会原子更新 Membership、受影响 Domain 双版本、审计、事件、Outbox 与回执；合法回放返回原最小结果。
- 最后一名可操作永久管理员的 demote/revoke 均稳定失败；一安全一不安全的两域组合整体回滚。
- 五个故障注入点均证明领域状态、审计、事件、Outbox 和回执无部分提交。
- SQLite 触发器制造 Membership 写入后的 Domain 失败，事务回调捕获错误后提交仍未留下 Membership 半写。
- 两个 SQLite 连接并发互相降级至多一个成功；重启后只保留一个可操作管理员、一个审计事实和连续 Domain 版本。
- actor 被降级后不能利用旧回执；目标资格和当前结果在回放前重新读取。
- 静态检查确认生产代码和既有测试中不存在 `memberships.update`。
- 独立安全 Review 首轮发现 legacy-only、嵌套域、跨项目事件聚合键和事件 Schema fixture 四项阻断；修复后复审 PASS，无剩余阻断项。
- `pnpm check`：TypeScript、108/108 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 与高置信凭据/私钥特征扫描通过。

## 明确未完成

- 成员新增、重新激活、升任项目经理、Principal 全局撤销。
- Member/Grant 查询 API、成员配置 UI。
- 真实 Node Owner、organization/system_admin、Emergency Access 模型及 U2/U7/U8 完整矩阵。
- 嵌套域、非空子树迁移、搜索/关系/通知/实时/文件/ZIP/复盘等全通道 ACL。

P0-07 总项保持进行中；下一片必须按依赖选择最小 Ready 安全任务，不得因本切片通过而解除公网监听闸门。
