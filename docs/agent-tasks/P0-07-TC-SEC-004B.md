# P0-07 / TC-SEC-004B：模板角色槽位与项目角色绑定底座

## Task Packet

- Task ID：P0-07 / TC-SEC-004B
- FC：FC-006、A4-03A（以当前仓库登记的 FC-1.2 摘要与已验收报告为准）
- Test ID：TC-TASK-005、TC-SEC-004B（新增）
- RISK_CLASS：R2（Permission / Transaction / Schema Migration / Event / Outbox / Idempotency）
- Base：`3f047c7a7cff1d6cef32bde952dde2f3920db811`

## 目标

建立 `TemplateRoleSlot` 与 `ProjectRoleBinding` 的最小产品域和持久化底座，使后续 P0-05A-T1b 可以按“显式验收人 → 模板验收人槽位 → 节点负责人”解析验收人。此切片只交付角色槽位与项目绑定本身，不在 Task 创建/改派路径启用三级解析。

## 当前状态

- TC-SEC-004A 已验收并提交：ProjectNode 已有权威 `leaderPrincipalId`，Node Owner/U2 不产生额外 ACL，也不能满足最后管理员不变量。
- P0-05A-T1a 已验收：显式验收人快照、ReviewCycle、CAS、幂等与原子事件链已存在。
- 当前仓库没有 Template 聚合、`TemplateRoleSlot` 或 `ProjectRoleBinding` 实现。
- 契约预检结果：`CONTRACT_READY`。产品负责人已明确：一个槽位可绑定多名成员；项目保存来自模板版本的槽位快照，绑定由项目经理维护；槽位未绑定、成员失效或无目标安全域权限时，后续验收人解析继续回退到节点负责人，最终仍无合格人时原子返回 `REVIEWER_REQUIRED`。

## 已批准产品规则（2026-09-15）

1. **多人绑定**：同一项目槽位可以绑定多名当前 active 项目成员；绑定集合必须去重、顺序确定且版本化。本切片只保存集合，不定义后续 Task 从多人中选出单一验收人的算法。
2. **项目快照**：项目持有来源模板版本的槽位定义快照。模板后续变化不得静默改写既有项目；跨模板版本升级不属于本切片。
3. **项目经理维护**：只有当前 active project manager 可以创建、替换或清除项目绑定。绑定本身不授予 Membership、Security Grant 或对象访问能力，因此维护绑定不额外要求某个对象安全域 Grant；后续使用绑定解析具体对象责任时仍必须重新校验目标对象的 RBAC ∩ Membership ∩ Grant。
4. **继续回退**：槽位不存在、未绑定、成员失效或候选人不具备目标安全域权限时，后续三级解析跳到节点负责人；最终无合格人时返回 `REVIEWER_REQUIRED`。该解析行为归 P0-05A-T1b，本切片只保证绑定底座能够提供确定性候选集合。

## 契约预检（写 Schema/代码前必须完成）

只读取本 Task Packet、`docs/product-baseline.md`、`docs/reports/P0-05A-T1a-task-review.md`、`docs/reports/P0-07-TC-SEC-004A-node-owner-guard.md`、`docs/adr/ADR-003-saas-domain-authorities.md`、`docs/adr/ADR-004-durable-uow-outbox-jobs.md`、`docs/adr/ADR-005-task-and-tree-authority.md`、`docs/adr/ADR-008-event-schema-evolution.md` 及直接涉及的现有代码/测试。

必须确认现有磁盘事实是否足以唯一决定：

1. 一个槽位在一个项目中是单绑定还是多绑定；
2. 槽位定义属于模板版本、项目快照，还是其他现有权威实体；
3. 绑定失效、成员撤销或候选人不合格时是直接失败还是允许后续层级回退；
4. 谁可创建/修改/清除绑定，以及该操作是否要求敏感域 Grant。

以上问题已由“已批准产品规则”明确回答。任何尚未明确的多人候选选人算法、模板升级或公开管理 UI/API 仍必须停止，不得自行创造规则。

## Expected Scope（契约充分时）

- `packages/domain`：最小槽位/绑定模型与不变量。
- `packages/application`：受守卫的绑定命令和只读解析端口；不接入 Task 三级解析。
- `packages/adapters`：Memory/SQLite 等价持久化、CAS、幂等、审计、DomainEvent、Outbox、回执；必要时单调 Schema 升级与旧二进制拒绝。
- `tests`：正负权限矩阵、并发/重启/升级/故障注入、Memory/SQLite parity、最小事件 Schema。
- `docs`、`.agent`：Task Report、Evidence、状态与 checkpoint。

## Non-goals

- 不实现 P0-05A-T1b 的 Task 验收人三级解析或改变现有 Task 创建行为。
- 不新增 UI、Stitch 设计、浏览器流程或公开 HTTP API，除非当前批准契约明确要求本切片开放。
- 不实现 U7 组织系统管理员、U8 紧急访问、嵌套安全域或新的 ACL 能力。
- 不让角色绑定直接授予项目成员资格、Security Grant 或最后管理员资格。
- 不改变 Huly 权威边界、迁移收敛规则或已验收 TC-SEC-004A 行为。

## 不变量与失败场景

- Huly 不是槽位/绑定权威；产品域只有一个权威事实源。
- 绑定对象必须 tenant/project 隔离；目标必须是当前 active user 与当前 active project membership。
- 角色绑定只是责任解析输入，不能替代 RBAC、Membership 或敏感域 Grant。
- 通用 persistence insert/update 不得成为绕过受守卫命令的写入口。
- 幂等回放必须重新校验当前操作者与目标资格；相同 key 不同 payload 稳定拒绝。
- 并发修改只能有一个 CAS 胜者；Memory/SQLite 行为一致，SQLite 重启后可恢复。
- 状态、审计、最小事件、Outbox 与回执同一事务；任一故障点零部分写。
- 事件/Outbox 不携带姓名、邮箱、Grant 详情或其他敏感快照；未知版本 fail-closed。

## Acceptance Criteria

- 契约预检有明确 `CONTRACT_READY` 证据，或在任何实现前返回 `PRODUCT_RULE_REQUIRED`。
- 契约充分时，领域/持久化/受守卫命令和升级测试全部通过，且不改变现有 Task 解析行为。
- `git diff --check`、typecheck、定向测试、`pnpm check`、Huly lock/contract check 通过。
- R2 必须经过新的 Codex 独立短上下文 Review；PASS 前不得提交或推送。

## Evidence 要求

- Task Report 记录契约来源、模型选择、Memory/SQLite parity、升级路径、测试计数、风险与明确 next_action。
- Worker 只返回 Task ID、修改文件、diff 摘要、测试结果、风险、next_action；不要回灌完整 stdout。
