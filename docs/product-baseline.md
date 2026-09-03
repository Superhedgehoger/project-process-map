# 产品基线登记

| 项目 | 当前值 |
|---|---|
| PRD | V1.3 |
| 功能契约 | FC-1.2 |
| 变更记录 | CR-003（架构修正闸门；PRD/FC 版本同步待完成） |
| 阶段 | Phase 0 |
| 登记日期 | 2026-09-02 |

源文档位于 Cindy 会话 `c076ebd8-b056-4f1a-9a0d-8adb56513956`：

- `PRD-项目过程图谱.md`
- `development-kit/00-产品功能契约.md`
- `development-kit/01-UI-UX设计规格.md`
- `development-kit/02-技术架构与开发规格.md`
- `development-kit/03-数据模型与权限规格.md`
- `development-kit/04-MVP开发Backlog.md`
- `development-kit/05-测试与验收计划.md`
- `development-kit/06-Huly上游同步与选择性升级规范.md`

开发不得用脚手架默认值替代尚待 ADR 决策的事项。

已批准的交付覆盖决定：

- [CR-002：SaaS 与无 Docker 发行目标](./change-records/CR-002-docker-free-saas.md)
- [ADR-002：无 Docker 的 SaaS 运行与发行边界](./adr/ADR-002-docker-free-runtime.md)
- [CR-003：架构修正闸门](./change-records/CR-003-architecture-correction-gate.md)
- [ADR-003：SaaS 租户、身份与领域权威边界](./adr/ADR-003-saas-domain-authorities.md)
- [ADR-004：持久工作单元、Outbox 与集成任务](./adr/ADR-004-durable-uow-outbox-jobs.md)
- [ADR-005：产品 Task 生命周期与项目树权威](./adr/ADR-005-task-and-tree-authority.md)
- [ADR-006：安全域移动的持久迁移与权限交集](./adr/ADR-006-security-domain-migration.md)
- [ADR-007：Asset 生命周期与 Evidence 绑定边界](./adr/ADR-007-asset-evidence-boundary.md)
- [ADR-008：最小领域事件与 Schema 演进](./adr/ADR-008-event-schema-evolution.md)

CR-002 与 CR-003 的产品负责人决定在权威顺序中高于尚未同步版本号的源功能契约。完成源 PRD、FC-016、架构、数据权限、Backlog 与测试计划同步后，登记新的 PRD/FC 版本；同步前不得把旧文档中的 Compose 描述解释为最终交付约束，也不得继续扩展已知会导致双权威和不可恢复写入的原型结构。
