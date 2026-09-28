# P0-05A-T2b 节点生命周期状态机与完成守卫验收报告

- Task ID：`P0-05A-T2b`
- Risk Class：`R2`
- Base Commit：`46cc16b`
- Functional Contracts：`FC-006`、`A4-03B`
- Test Suites：`TC-DLV-002`（`tests/node-completion-guard.test.ts`）
- 状态：`CLOSED`（IMPLEMENTED / VERIFIED / CODEX_R2_REVIEW_PASS / FINAL_GATE_PASS / COMMITTED / PUSHED）

---

## Review 与 R2F1 修复证据

正式 Review 历史完整保留：P0-05A-T2b implementation → Codex R2 Review **FAIL** → `P0-05A-T2b-R2F1` → Independent Codex R2 Repair Review **PASS**。

首次 Codex R2 Review 确认的三个 Finding 与后续批准产品决定已完成：

1. **SQLite v13 parity**：新增冻结 v12 fixture；旧库在 migration transaction 内重建 `project_nodes`，保留全部正式列、PK、self/tenant FK 与 `project_nodes_by_project` index，并在写入 v13 marker 前校验完整列形状、DEFAULT/NOT NULL、STRICT、CHECK、FK、index 和 `foreign_key_check`。Fresh、v12→v13、更早版本→v13、reopen、非法 INSERT/UPDATE、畸形 v13 marker 与非法持久 status fail-closed 均有回归证据。
2. **Error normalization**：三个 node completion error codes 已加入 `knownCodes` 并由测试确认不会映射为 `UPSTREAM_FAILURE`。
3. **Sensitive concealment**：敏感节点先使用真实 `node.projectId` 进行 Membership/role/Grant 判定；未授权 correct/wrong-project 与不存在节点统一 `NODE_NOT_FOUND`，仅已授权 actor 得到 `PROJECT_MISMATCH`。
4. **批准产品决定**：仅在父节点完成守卫中，canceled/promoted Task 视为 non-blocking terminal；Task 自身状态机未变化。Memory/SQLite 均覆盖免验 canceled/promoted，以及必验 canceled。

Independent Codex R2 Repair Review 结论：**PASS**；MEDIUM-01、LOW-01、LOW-02 均 **CLOSED**，canceled/promoted 产品决定 **CORRECTLY_IMPLEMENTED**。R2F1 状态为 **CLOSED**。

最终 closeout gate：`node-completion-guard` 26/26、`task-upgrade-compatibility` 13/13、`pnpm check` 376/376、diff/JSON/credential scan 全部 PASS。

---

## 1. 目标与实现范围

在已完成的 `P0-05A-T1a/T1b`（Task 验收闭环与三级验收人解析）和 `P0-05A-T2a`（DeliverableRequirement / EvidenceLink 文件证据提交与接受/豁免）基线上，实现 `ProjectNode` 领域生命周期状态机与权威节点完成守卫：

1. **节点状态模型**：
   - `ProjectNode` 聚合增加显式状态：`status: "planned" | "in_progress" | "completed"`，默认 `"planned"`。
   - 记录终态属性：`completedAtUtc: string | null` 与 `completedByPrincipalId: string | null`。
   - 状态转移守卫 `completeProjectNode(node, actorPrincipalId, completedAtUtc)`：仅允许非 completed 状态向 completed 转移。
   - 领域事件 Schema 扩展：`nodeEventSchemas.completed`，事件名 `project-map.node.completed.v1`，载荷包含 `[nodeId, completedByPrincipalId, completedAtUtc]`。

2. **节点完成守卫检查 (`CompleteProjectNodeHandler`)**：
   - **操作权限**：要求当前 active user + active project Membership；操作者必须为当前 active 项目经理（PM）或负责该节点的 Node Owner（`node.leaderPrincipalId`）；鉴权使用 persistence trusted clock。
   - **安全域防枚举**：若节点位于安全域，无权访问者统一返回 404 (`NODE_NOT_FOUND`)，与不存在节点语义一致，fail-closed。
   - **安全迁移冻结**：若当前项目存在处于 active 或 verifying 状态的安全迁移计划，原子拒绝写操作并返回 `SECURITY_MIGRATION_IN_PROGRESS`。
   - **任务完成守卫**：遍历该节点下所有未软删除（`deletedAtUtc === null`）的 Task：
     - `executionState === "canceled"` 或 `"promoted"` 为 non-blocking terminal，不阻塞父节点完成；
     - 其余要求验收的任务（`requiresAcceptance = true`）必须 `reviewState === "accepted"`；
     - 其余免验任务（`requiresAcceptance = false`）必须 `taskLifecycle(task) === "completed"`（即 `executionState === "completed"`）；
     - 任何仍处于 `todo`、`in_progress`、`pending_review` 或 `rejected` 的 Task 均拒绝完成，返回 `NODE_TASKS_NOT_COMPLETED`。
   - **交付物完成守卫**：遍历该节点下所有未软删除的 `DeliverableRequirement`：
     - 凡 `required = true` 者，其状态必须为 `accepted` 或 `waived`；
     - 任何未满足的必需交付物均拒绝完成，返回 `NODE_DELIVERABLES_NOT_SATISFIED`。
   - **CAS 并发版本控制**：显式传入 `expectedVersion`；若当前节点版本不匹配，返回 `NODE_VERSION_CONFLICT`（优先于 `NODE_ALREADY_COMPLETED` 检查）。
   - **幂等重放与 Receipt**：同一幂等键再次调用时，重新校验授权与快照指纹；若载荷冲突返回 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`；同载荷安全返回既有结果。

3. **双后端持久化与事务原子性**：
   - **Memory/SQLite 等价**：Memory 与 SQLite 两个后端均实现 `executeCompleteProjectNode` 端口，在单物理事务内完成聚合状态变更、DomainEvent、Outbox 消息与 Receipt 写入。
   - **SQLite Schema v13 演进**：
     - 在 `project_nodes` 表中添加 `status`（默认 `'planned'`，CHECK 约束限定合法取值）、`completed_at_utc`、`completed_by_principal_id` 字段；
     - 增加 `#validateV13TableShapes` 严格校验表结构；
     - 保证数据库 reopen / restart 后的状态恢复与持久化一致性。
   - **故障注入测试**：验证在 domain event、outbox、receipt 写入等各个断点注入异常时，事务全部回滚，零脏写残留。

4. **Product API 与 HTTP 映射**：
   - 暴露窄公开端点 `POST /api/nodes/:nodeId/actions/complete`，使用收敛的 `executePublicNodeCommand` 处理幂等重试并捕获领域错误；
   - 映射 HTTP 409 状态码：`NODE_ALREADY_COMPLETED`、`NODE_TASKS_NOT_COMPLETED`、`NODE_DELIVERABLES_NOT_SATISFIED`；
   - 浏览器客户端 `project-process-map-client` 增加 `completeNode(nodeId, input, idempotencyKey)` 方法与解码支持。

---

## 2. 验证结果

### 2.1 定向测试

`tests/node-completion-guard.test.ts` 26/26 全部通过，包括 R2F1 error normalization、canceled/promoted completion semantics 与 sensitive-node concealment 回归：
- TC-DLV-002: ProjectNode completes when all tasks and deliverables are satisfied (Memory & SQLite)
- TC-DLV-002: Rejects completion if unreviewed task is not completed (NODE_TASKS_NOT_COMPLETED)
- TC-DLV-002: Rejects completion if reviewed task is not accepted (NODE_TASKS_NOT_COMPLETED)
- TC-DLV-002: Rejects completion if required deliverable is pending or submitted (NODE_DELIVERABLES_NOT_SATISFIED)
- TC-DLV-002: Allows completion when required deliverable is waived
- TC-DLV-002: Optional deliverables do not block completion
- TC-DLV-002: Deleted tasks and deleted deliverables do not block node completion
- TC-DLV-002: Only active PM or Node Owner can complete node
- TC-DLV-002: Expired or revoked PM membership is rejected
- TC-DLV-002: Node without leader rejects non-PM member
- TC-DLV-002: Unauthorized caller receives NODE_NOT_FOUND (404 concealment) when node is in sensitive domain
- TC-DLV-002: Rejects completion during active security migration (SECURITY_MIGRATION_IN_PROGRESS)
- TC-DLV-002: CAS expectedVersion conflict returns NODE_VERSION_CONFLICT
- TC-DLV-002: Re-completing already completed node returns NODE_ALREADY_COMPLETED
- TC-DLV-002: Idempotent replay with same key and payload returns identical receipt
- TC-DLV-002: Reused idempotency key with different expectedVersion is rejected
- TC-DLV-002: Failure injection rollback leaves zero partial writes
- TC-DLV-002: Concurrent completion race commits exactly once with CAS
- TC-DLV-002: SQLite restart preserves completed node status, event, outbox, and receipt
- TC-DLV-002: HTTP Product API complete endpoint works for PM and Node Owner
- TC-DLV-002: HTTP Product API maps domain errors to 409
- TC-DLV-002: HTTP Product API conceals sensitive node with 404 for outsider
- TC-DLV-002: Browser client executes completeNode successfully

### 2.2 兼容性回归测试

相关依赖测试已同步升级断言与结构校验：
- `tests/task-upgrade-compatibility.test.ts`: 13/13 PASS（fresh v13、v12→v13、更早版本→v13、reopen、非法 INSERT/UPDATE、非法持久状态 fail-closed）
- `tests/security-migration-object-write.test.ts`: 4/4 PASS
- `tests/security-migration-batch.test.ts`: PASS
- `tests/node-owner.test.ts`: PASS
- `tests/security-grant.test.ts`: PASS
- `tests/deliverable-evidence.test.ts`: PASS

### 2.3 全量门禁

- `pnpm check`: **376/376 PASS**
- TypeScript: PASS（零错误）
- Huly Image Lock: 14 images `linux/arm64` PASS
- Huly Extension Verify: upstream `ccefccd8d0361d3c8612d508071b777aa833826d` PASS
- `git diff HEAD --check`: PASS（零空白与格式错误）
- 凭据扫描：PASS（无密钥或令牌泄露）
- JSON 结构校验：PASS

---

## 3. 文件修改清单

| 类别 | 文件路径 | 修改简要 |
| --- | --- | --- |
| Domain | `packages/domain/src/project-structure.ts` | 增加 ProjectNode 状态字段、完成函数与事件 Schema |
| Domain | `packages/domain/src/event-schema-registry.ts` | 注册 `project-map.node.completed.v1` 事件 |
| Application | `packages/application/src/errors.ts` | 增加 `NODE_ALREADY_COMPLETED`、`NODE_TASKS_NOT_COMPLETED`、`NODE_DELIVERABLES_NOT_SATISFIED` |
| Application | `packages/application/src/ports/persistence.ts` | 定义 `CompleteProjectNodeCommand`、`CompleteProjectNodeResult` 及持久化方法 |
| Application | `packages/application/src/complete-node.ts` | 实现 `completeProjectNode` 领域命令编排器与守卫 |
| Contracts | `packages/contracts/src/project-process-map-api.ts` | `ApiNode` 增加状态字段，导出 `CompleteNodeRequest` 契约 |
| Client | `packages/api-client/src/project-process-map-client.ts` | 实现 `completeNode` 客户端调用 |
| Adapters | `packages/adapters/src/memory/persistence.ts` | 实现 Memory 下原子完成方法、CAS、单事务与状态规范化 |
| Adapters | `packages/adapters/src/sqlite/persistence.ts` | 实现 Schema v13 演进、表结构校验与 SQLite 单事务完成方法 |
| Product API | `apps/product-api/src/routes/project.ts` | 暴露 `POST /api/nodes/:nodeId/actions/complete` 路由 |
| Product API | `apps/product-api/src/app.ts` | 注册 409 状态码映射 |
| Tests | `tests/node-completion-guard.test.ts` | 新增 23 个涵盖正负向、CAS、并发、安全、重启与 HTTP 的测试用例 |
| Tests | `tests/task-upgrade-compatibility.test.ts` 等 | 更新 schema version 13 断言及默认节点状态 |

---

## 4. 结论与下一步

- P0-05A-T2b 实现了完整的节点状态机与完成守卫，Memory/SQLite 双后端保持严格一致，最终门禁全绿。
- 原 Codex R2 Review 的 FAIL 历史已保留；`P0-05A-T2b-R2F1` 经独立 Repair Review PASS 后 CLOSED。
- 父任务最终状态：IMPLEMENTED / VERIFIED / CODEX_R2_REVIEW_PASS / FINAL_GATE_PASS / COMMITTED / PUSHED / CLOSED；closeout commit 为 `2d553b16eb80f4de64bf2fd07426a8bbb29b04e4`。
