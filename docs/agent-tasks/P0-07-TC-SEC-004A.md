# P0-07 / TC-SEC-004A：ProjectNode 负责人 (Node Owner / U2) 领域模型与敏感安全守卫

## 目标

在 `ProjectNode` 聚合上建立权威的节点负责人（Node Owner / U2）领域模型，关闭当前节点无负责人字段且无法表达真实 U2 身份的空白。实现“项目成员资格 ∩ 节点负责人 ∩ 敏感域 Grant”三层守卫，确保敏感节点下的负责人若无有效 Grant 绝对无法越权访问或修改敏感内容，对外表现为严格的 404 权限隐蔽，且节点负责人绝不能满足敏感域最后管理员不变量。本切片为 P0-05A-T1b 任务验收人三级解析提供底座。

## 直接依据

- **PRD V1.3**：第 67–68 行（项目经理分配节点负责人；节点负责人编辑负责范围内容、进度与时间）、第 72 行（敏感权限原则、最后敏感管理员保护）、第 164 行（验收人按显式指定 → 模板槽位 → 节点负责人解析）。
- **FC-1.2**：FC-006（节点详情与职责管理）、FC-013（敏感子树全通道权限受控）。
- **数据模型与权限规格 (03)**：
  - 第 3.2 节：Node 关键字段包含负责人（负责人等实例字段建立后是执行权威值）。
  - 第 3.3 节：任务验收人第三级回退为当前节点负责人（必须为项目成员并具备安全域访问权）。
  - 第 5.1 节：两层授权与“项目角色能力 ∩ Grant 能力 ∩ 对象状态守卫”交集；最后管理员保护。
  - 第 5.3 节：判定顺序（1. 有效身份 → 2. 项目访问权 → 3. 对象状态 → 4. 项目角色 → 5. 节点职责 → 6. 敏感 Grant → 7. 业务守卫 → 8. 安全审计）。
  - 第 5.4 节：核心权限矩阵（节点负责人对负责范围可编辑内容/进度；敏感授权无权）。
  - 第 11 节：固定测试身份 U2（普通节点负责人）。
- **测试与验收计划 (05)**：第 4 节固定身份 U2、TC-TASK-005。
- **架构决策**：ADR-003（SaaS 租户与身份权威边界）、ADR-004（持久工作单元与原子写）、ADR-005（项目树权威与单父约束）、ADR-006（安全域迁移与权限交集）、ADR-008（事件 Schema 演进）。
- **已验收前置**：`6305b78`（HEAD）、TC-SEC-003A/B/C、TC-SEC-002A～K。

## 必须保持的不变量

1. **节点负责人身份权威性**：`ProjectNode` 增加 `leaderPrincipalId: PrincipalId | null`。若指定，候选人必须是同租户 `active` user，且在同项目持有 `active` `ProjectMembership`；不存在、跨租户、非 active 或非项目成员一律原子拒绝（`INVALID_NODE_LEADER`）。
2. **结构权限与分配权限单向性**：只有 active `project_manager` 可在创建节点或分配负责人时指定/变更 `leaderPrincipalId`；普通成员及节点负责人自身无权变更节点负责人字段。
3. **两层授权绝对相交 (RBAC ∩ Grant)**：
   - 普通节点（`securityDomainId === null`）：U2 对所负责节点具有“负责范围”内容与进度编辑能力；
   - 敏感节点（`securityDomainId !== null`）：U2 即使被指定为 `leaderPrincipalId`，若在该安全域无当前有效且具备相应能力的 `SecurityGrant`，则判定顺序在第 6 步拦截，绝对无法查看或修改该节点及其下属任务与文件。
4. **权限隐蔽与防枚举 (404 统一表现)**：
   - 无 Grant 的 U2 探测或请求其负责的敏感节点时，返回与 U0（非成员）、U1（普通成员）、U3（无权项目经理）完全相同的 404 响应，绝不泄漏节点存在性、安全域 ID、标题或负责人信息。
5. **最后管理员不变量零豁免**：
   - U2 作为 `member` 角色，不能仅凭 Node Owner 身份或 Grant 记录获得有效的 `manage_access` 能力，绝不能执行 Grant 写操作（调用 Grant API 统一返回 404）；本切片不新增“存储层禁止 member 目标拥有该 Grant 行”的产品规则；
   - 在任何 demote/revoke 成员或撤销 Grant 的场景中，U2 的存在绝不能被计入敏感域的有效永久管理员（必须为 active user + active `project_manager` + permanent `manage_access`）。
6. **迁移期间只读与交集守卫**：
   - 在安全域迁移期间（`active`、`verifying`、`retryable`、`recovery_required`），所有节点写操作冻结；U2 对处于迁移范围内的节点若发起写入一律拒绝，读取仍须满足源域与目标域双重有效 Grant。
7. **持久化与 Schema 平滑升级**：
   - SQLite schema 由 v9 升至 v10，在 `project_nodes` 增加 `leader_principal_id TEXT NULL`，老版本历史记录默认回填 `NULL`；
   - Memory 与 SQLite 严格保持相同行为，重启恢复与并发保存验证 CAS 与关系列一致性。
8. **事件与审计最小信封**：
   - 节点负责人指定/变更形成事件，不得在事件 payload 夹带非公开敏感信息或越权突破安全域信封。

## 允许修改与新建的文件

- `packages/domain/src/project-structure.ts`（`ProjectNode` 增加 `leaderPrincipalId` 字段与守卫辅助函数）
- `packages/domain/src/event-schema-registry.ts`（ADR-008 事件 Schema 注册中心、校验及敏感字段防泄漏）
- `packages/contracts/src/project-process-map-api.ts`（API 合约契约支持 `leaderPrincipalId`）
- `packages/application/src/ports/persistence.ts`（节点仓库契约支持 `leaderPrincipalId` 与 `NodeLeaderMutationRepository` 窄仓储契约）
- `packages/adapters/src/sqlite/production-bundle.ts`（生产 SQLite 组装根暴露受保护的 `NodeLeaderMutationRepository`）
- `packages/application/src/errors.ts`（增加 `INVALID_NODE_LEADER` 等应用错误码）
- `packages/application/src/create-node.ts`（创建节点与负责人变更，原子事件/Outbox，防重放与故障注入点）
- `packages/application/src/access/project-security.ts`（加固 Node Owner 权限交集判定及迁移判定）
- `packages/application/src/tasks/act-on-task.ts`（重载权威属主节点，软删除/陈旧一致性守卫与 404 隐蔽）
- `packages/application/src/assets/attach-task-asset.ts`（重载权威属主节点，软删除/陈旧一致性守卫与 404 隐蔽）
- `apps/product-api/src/routes/project.ts`（生产 HTTP 路由加固 U1/U2 职责与 404 隐蔽，assign-leader 端点）
- `apps/product-api/src/app.ts`（错误码映射与 HTTP 状态码）
- `packages/adapters/src/memory/persistence.ts`（MemoryPersistence 支持 `leaderPrincipalId`、capability 校验与 ADR-008 边界校验）
- `packages/adapters/src/sqlite/persistence.ts`（SQLite schema 升级至 v10，BEGIN IMMEDIATE 事务串行化，capability 校验与 ADR-008 边界校验）
- `tests/fixtures/node-events-v1.json`（ADR-008 静态事件契约 fixture）
- `tests/node-owner.test.ts`（TC-SEC-004A 全量测试矩阵与 review findings 回归测试）
- 测试适配及断言加固：`tests/security-*.test.ts`、`tests/collaboration-projection.test.ts`、`tests/task-upgrade-compatibility.test.ts`
- 状态与检查点文档：`.agent/tasks/P0-07-TC-SEC-004A.json`、`docs/phase0-status.md`、`docs/handoff/GOAL-CHECKPOINT.md`、`docs/reports/P0-07-TC-SEC-004A-node-owner-guard.md`

## 禁止修改的文件

- 生产 Huly 适配器与集成端口（`packages/adapters/src/huly/*`）
- TC-SEC-003A/003B/003C 已验收的 Grant 与 Membership 限权领域守卫及 API 核心逻辑（`packages/application/src/security/manage-security-grant.ts`、`packages/application/src/security/restrict-project-membership.ts` 等，除非修复阻断缺陷）
- 任务验收与交付物非本切片逻辑（P0-05A 的 Deliverable 守卫及 TaskReview 状态机）
- 组织管理员与紧急访问未决模型（不得在此切片伪造 U7/U8 实体）

## 明确不做

- `TemplateRoleSlot` 与 `ProjectRoleBinding` 模板角色槽位（归属 TC-SEC-004B）。
- 任务验收人三级解析算法的完整连调（归属 TC-SEC-004B / P0-05A-T1b）。
- U7 组织系统管理员租户级实体及管理流（归属 TC-SEC-004D，待产品决策）。
- U8 紧急访问独立审批流（归属 TC-SEC-004C / Backlog D-02）。
- 节点详情 UI、地图画布交互与前端组件。

## 验收测试与证据要求

1. **普通节点负责人正向与边界验证**：
   - 项目经理成功创建指定 U2 为 `leaderPrincipalId` 的普通节点；
   - 指定非项目成员、已撤销成员、跨租户用户作为负责人时，以稳定错误原子拒绝；
   - U2 在普通节点上具备负责范围权限，但不能执行项目经理专属操作（如创建敏感根、修改地图全局结构）。
2. **敏感节点负责人负向与 404 隐蔽验证**：
   - 在敏感域下创建节点并指定 U2 为负责人；
   - 当 U2 未被授予该敏感域的有效 Grant 时，U2 尝试读取或操作该节点均返回严格 404，且响应 body 与 U0/U1/U3 探测完全一致；
   - 当 U2 被授予有效 `view` Grant 时，U2 可读但不能写；被授予 `edit` Grant 时，U2 可读写负责范围；
   - 撤销 Grant 或 Grant 到期后，U2 立即退回 404。
3. **最后管理员不变量零突破**：
   - 证明敏感节点负责人的存在不能抵消最后管理员保护；对最后一名持有 permanent `manage_access` 的项目经理执行撤销或降级时，即便该域下存在已绑定的 U2 负责人，操作仍被稳定拒绝（`SECURITY_DOMAIN_LAST_ADMINISTRATOR`）；
   - U2 无法调用 Grant API 为自己或他人授权。
4. **持久化与迁移升级验证**：
   - SQLite 从 v9 成功升级至 v10，旧节点数据正常读出且 `leaderPrincipalId === null`；
   - 重启与两连接并发写节点负责人，CAS 冲突防并发覆盖；
   - 故障注入点验证 Node 保存与事件/Outbox 同成败，无部分提交。
5. **完整门禁**：
   - 定向测试全部通过；全量生产门禁 `pnpm check` 零失败、零跳过；
   - `git diff --check` 与凭据扫描 clean。

## Review 要求

- 必须由独立的只读审查 Agent 进行安全复核。
- 重点核查：
  1. `ProjectNode.leaderPrincipalId` 是否引入任何可绕过 `grantAllows` 的旁路；
  2. 敏感节点下无 Grant 的 U2 是否绝对保持 404，无任何存在性/元数据泄漏；
  3. SQLite schema v10 升级脚本在既有数据库与空数据库上的幂等性与兼容性；
  4. 是否保持单所有者、无 Docker SaaS 约束及 ADR 架构边界。

## next_action

- 状态：ACCEPTED / DONE（Codex R2 Cycle 6 Final Verdict: PASS）。
- next_action：选择下一个 Ready Task（TC-SEC-004B 模板角色槽位与项目角色绑定 / P0-05A-T1b 任务验收人三级解析），在全新独立短工时会话中启动实施。
- 架构事实说明：生产 Huly 协同收敛保持 fail-closed（超出本切片范围，由既有架构守卫妥善隔离）。
