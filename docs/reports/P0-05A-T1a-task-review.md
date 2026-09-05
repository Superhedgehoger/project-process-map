# P0-05A-T1a 显式验收人的任务验收周期

- 日期：2026-09-04
- 状态：通过子切片验收；P0-05A 总项保持进行中
- 产品依据：FC-006、A4-03A、TC-TASK-001～005
- 架构依据：CR-003、ADR-003、ADR-004、ADR-005、ADR-008

## 本切片交付

- Product Task 保存 `assigneePrincipalId` 与明确的 `reviewerPrincipalId` 快照；必验任务没有验收人时以 `REVIEWER_REQUIRED` 原子拒绝。
- `ProjectMembership` 以产品域事实持久保存项目角色、成员状态和安全域授权。负责人/验收人候选同时要求 Active Principal、Active Membership 和目标安全域权限。
- 负责人执行开始、提交、撤回和免验完成；项目经理可改派负责人/验收人并参与通过或退回，但不能代负责人提交。改派是有版本、有事件和 Outbox 的正式命令。
- 提供开始、提交、通过、退回、撤回和免验任务直接完成命令；HTTP 状态命令统一要求 `expectedVersion` 与 `Idempotency-Key`。
- 退回理由必填；退回后再次提交生成新 `cycleNumber`。每条 submitted/accepted/rejected/withdrawn 动作保存当轮验收人、操作者、时间和说明，只追加不覆盖。
- Task 更新、Review Action、最小 DomainEvent、Outbox 和命令回执在同一持久事务提交。事件只含 task、node 和 cycle 标识，不携带提交说明或退回理由。
- Memory 与 SQLite 使用同一 Repository 契约；SQLite 关闭重开后仍能恢复任务版本和全部验收历史。
- 任务兼容结构始于 SQLite schema v3；当前 schema v4 新增正式 SecurityDomain/SecurityGrant，同时继续兼容旧 `task_json`、创建回执和无验收人字段。旧的未指派普通任务可由项目经理显式改派后继续，未知的未来 schema 版本拒绝启动。
- 当前安全域迁移期间整项目 API fail-closed；节点详情还逐 Task/Asset 重验安全域，避免迁移尚未实现交集判定时泄漏验收理由或文件元数据。
- Huly 不参与产品验收事务，也不能把外部 Done 解释成 Product Task 已验收。协作状态更新投影将在独立 Adapter 切片实现，失败不得回滚本地验收事实。

## 自动验收证据

- 无验收人和不合格显式验收人：无 Task、事件、Outbox 或回执残留。
- `todo → in_progress → pending_review → rejected/in_progress → pending_review → completed` 两轮闭环。
- 非验收人通过/退回、无理由退回、旧期望版本均被稳定拒绝。
- 相同幂等键回放原结果；同版本并发通过/退回只有一个结论提交。
- `pnpm check`：TypeScript、57 项测试、14 个 Huly ARM64 镜像锁和薄宿主边界全部通过。
- `pnpm build:native`：Node 24 发行包 SHA-256 为 `bcd6549c56749796b90661b09bab766a1c0459a682eeb96ec927ec03b25ae49d`。
- `pnpm smoke:native`：打包程序完成 Task、Asset、两轮任务验收、停止、重启与历史回读，`dockerInvoked=false`。

## 追踪覆盖

| 测试项 | 本切片覆盖 |
|---|---|
| TC-TASK-001 | 显式验收人的负责人提交、指定验收人通过，以及免验任务领域状态机 |
| TC-TASK-002 | 退回理由、回到进行中、新周期、追加历史 |
| TC-TASK-003 | CAS、幂等、并发结论与 Product Task 单一权威；Huly 原生入口仍保持只读启动壳 |
| TC-TASK-004 | 本地 DomainEvent/Outbox 原子性与安全域信封；通知消费者和渠道 ACL 待后续 |
| TC-TASK-005 | 显式验收人快照、Active 成员资格、项目经理改派和稳定拒绝；模板槽位与节点负责人回退待后续 |

## 未完成边界

以下内容不得因为本报告而标记完成：

- ProjectRoleBinding、节点负责人、正式成员配置入口、授权变更追加审计和可查询的细粒度 Grant。
- “显式指定 → 模板验收人槽位 → 节点负责人”的后两级验收人解析。
- A4-03C 的任务验收 UI、站内通知、搜索、实时与全通道 ACL。
- DeliverableRequirement、EvidenceLink、接受/豁免、证据失效和节点完成守卫。
- Huly 已存在 Issue 的状态更新投影。
- Huly 登录主体默认没有项目成员资格；P0-07 管理入口完成前保持空列表/404，并且非 loopback 服务启动被拒绝。
- 安全域迁移的旧域∩新域逐对象判定；本阶段使用整项目冻结代替，不把临时措施写成最终 ACL。

下一步应补 P0-07 的正式成员配置/授权审计和模板角色解析，或者在边界不交叉的前提下进入独立 Deliverable/Evidence 子切片。P0-05A 在这些依赖完成前保持“进行中”。
