# P0-05A-T1b Task 验收人三级解析与候选仲裁验收报告

- 日期：2026-09-20
- 状态：ACCEPTED / DONE；Codex R2 Review Cycle 5 PASS
- 产品依据：FC-006、A4-03A、TC-TASK-005
- 架构依据：CR-003、ADR-003、ADR-004、ADR-005、ADR-008
- 基础提交：`9cadf1c72140e0f0bf572efab0e18d27abc77a30`
- 风险级别：R2（Permission / Task state / Transaction / Idempotency）

---

## 1. 本切片目标与批准决策

连接已完成的三个权威底座（显式验收人、项目模板角色槽位底座 P0-07 / TC-SEC-004B、节点负责人 P0-07 / TC-SEC-004A），形成完整的三级验收人解析链：
`显式验收人 → 项目模板角色槽位（ProjectRoleSlot/Binding） → 节点负责人（Node leaderPrincipalId） → REVIEWER_REQUIRED`。

### 批准的产品与架构决策（CR-001 / docs/agent-tasks/P0-05A-T1b.md）
1. **显式槽位标识**：Task 创建契约新增可选 `reviewerRoleSlotKey`，显式指定本 Task 使用的项目角色槽位。严禁根据 slot name、description、列表顺序或隐式默认值推断。
2. **显式优先且不掩盖错误**：当 `reviewerPrincipalId` 非空且当前合格时直接获胜；若显式 reviewer 不合格，立即返回 `REVIEWER_NOT_ELIGIBLE`，不得通过槽位或节点回退掩盖错误。
3. **空显式回退槽位与确定性裁决**：仅在 `reviewerPrincipalId` 为空时才读取 `reviewerRoleSlotKey`。过滤出符合三大门禁（Active User Principal、Active Project Membership、目标 Security Domain `view` 权限）的候选人后，按 canonical Principal ID 最小者（ECMAScript code-unit 顺序，`compareExactStrings`）确定性选取。
4. **回退节点负责人与最终原子拒绝**：若槽位不存在、未绑定、或所有候选人均不合格，平滑回退到当前所属节点的 `leaderPrincipalId`；节点负责人同样执行三大门禁资格检查。若均无合格人，以 `REVIEWER_REQUIRED` 原子拒绝，无部分 Task/Event/Outbox 写入。
5. **免验任务约束**：`requiresAcceptance=false` 时，若传入 `reviewerRoleSlotKey`，以 `REVIEWER_NOT_ALLOWED` 拒绝。
6. **快照不可变性与免 Schema Bump**：Task 只保存解析后的单一 `reviewerPrincipalId` 快照，后续角色绑定或节点负责人变更不影响既有 Task 快照；无需升级 SQLite schema。
7. **可信授时**：权限与授权检查使用持久化提供的可信事务时间（`this.#persistence.nowUtc()`），杜绝客户端伪造历史时间绕过过期 Grant。

---

## 2. Codex R2 Review Cycle 1 返工项修复 (Cycle 1 Rework)

针对 Codex independent R2 review cycle 1 的 4 项 findings，执行了彻底的修复与回归覆盖：

1. **HIGH: Replay Reauthorization（回放重授权安全校验）**
   - 之前问题：`create-task` 在回放时直接返回收据，未对快照中的验收人执行基于当前可信时间（`nowUtc()`）的状态重验。
   - 修复实现：回放时解析收据中的 `TaskView`，通过 `isCandidateEligible` 在当前事务上下文中验证持久化的 `reviewerPrincipalId`。若 Principal 撤销、Membership 撤销、Sensitive Domain Grant 撤销或 Grant 过期，一律 fail closed 抛出 `REVIEWER_NOT_ELIGIBLE`。
   - 严格禁止替换：回放重授权失败时绝对不重跑槽位解析或替换为其他候选人，也不回退到节点负责人。
   - 收据损坏防御：`taskViewFromReceipt` 校验 `requiresAcceptance` 任务的 `reviewerPrincipalId` 必须为有效非空字符串，否则返回 `VALIDATION_FAILED`。

2. **HIGH: Base Fingerprint Compatibility（基础提交 9cadf1c 收据兼容性）**
   - 之前问题：基础提交生成的普通 `TaskView`（含 `reviewHistory: []`）在回放时由于新增了 `reviewerRoleSlotKey: null` 导致指纹不匹配而被误拒。
   - 修复实现：引入 `baseFingerprint(command)`，在 `command.reviewerRoleSlotKey == null`（null 或 undefined）时显式兼容匹配基础提交的指纹；同时确保当 caller 传入非空 slotKey 或请求体字段漂移时，仍准确拒绝并抛出 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`。

3. **MEDIUM: Public Validation（公开接口校验与状态码统一）**
   - 之前问题：格式错误的 `reviewerRoleSlotKey` 会抛出未捕获的领域错误，经 `asApplicationError` 变成 502 `UPSTREAM_FAILURE`。
   - 修复实现：在 `CreateTaskHandler.validate` 与 `resolveTaskReviewer` 中统一将 slotKey 格式/长度非法抛为 `ApplicationError("VALIDATION_FAILED")`，并在 `Product API` 中明确将其及 `REVIEWER_NOT_ALLOWED`、`REVIEWER_REQUIRED` 映射为 HTTP 422。在 `tests/product-api.test.ts` 中补充针对非字符串、含空格、超长（>64）、免验任务传 slotKey 的测试。

4. **LOW: Artifact Accuracy（工件与变更标记校准）**
   - 在 `.agent/tasks/P0-05A-T1b/artifacts/diff.json` 中将 `publicHttpOrUiChange` 设为 `true`，准确记录公开 API 请求契约的新增可选字段 `reviewerRoleSlotKey`。

---

## 2.1 Codex R2 Review Cycle 2 返工项修复 (Cycle 2 Rework)

针对 Codex independent R2 review cycle 2 的 4 项 findings，执行了彻底的闭环修复与全生命周期回归：

1. **HIGH: Authoritative Task Loading & Domain Coherence on Replay（回放必须加载权威 Task 并校验所有权及安全域/纪元连贯性）**
   - 之前问题：回放仅验证收据中的 reviewer 是否符合当前 Node 的安全域，若权威 Task 缺失、已被删除、归属被改写、或其安全域/纪元与 Node 不一致，可能导致越权或脏回放。
   - 修复实现：回放时显式通过 `transaction.tasks.get(command.taskId)` 读取当前权威 Task。
     - 若 Task 不存在或 `deletedAtUtc !== null`，fail closed 抛出 `TASK_NOT_FOUND`；
     - 校验 `authoritativeTask.id === command.taskId`、`authoritativeTask.projectId === command.projectId`、`authoritativeTask.ownerNodeId === command.nodeId`，不符抛出 `TASK_NOT_FOUND`；
     - 校验 `authoritativeTask.securityDomainId === node.securityDomainId` 与 `authoritativeTask.securityEpoch === node.securityEpoch`，不符抛出 `TASK_NOT_FOUND`；
     - 校验 `authoritativeTask.requiresAcceptance === command.requiresAcceptance`，不符抛出 `TASK_NOT_FOUND`；
     - 针对 Task 权威所在的当前 `authoritativeTask.securityDomainId` 进行 reviewer 与 assignee 的可信时间重授权；
     - 允许 Task 在创建后正常执行生命周期推进（如 version 递增、`in_progress`），回放时忠实返回初次创建时的不可变历史快照（`value: replayedView, replayed: true`），不对可变字段强求与收据一致。

2. **HIGH: Strict Receipt Identity and Immutable Command Invariant Binding（收据身份与不可变命令不变量严格绑定）**
   - 之前问题：收据解码未严格绑定命令身份，可能导致返回了错误 Task 的收据或接受 `requiresAcceptance=false` 的收据跳过审批人重验。
   - 修复实现：
     - 收据内容反序列化时严格校验 `replayedView.id === command.taskId`、`replayedView.nodeId === command.nodeId`、`replayedView.requiresAcceptance === command.requiresAcceptance`、`replayedView.title === command.title`；若收据包含 `projectId` 也必须完全匹配；
     - 非旧版迁移收据（`!matchesOlderLegacy`）时校验 `replayedView.assigneePrincipalId === command.assigneePrincipalId`；
     - `taskViewFromReceipt` 强化格式防御：必须为有效 lifecycle state、version 必须为正整数、`requiresAcceptance=false` 时 `reviewerPrincipalId` 必须为 null（否则抛 `VALIDATION_FAILED`）。

3. **MEDIUM: Guard All Legacy Fingerprint Branches Against Non-Null Slot Input（防范所有遗留指纹分支渗漏非空 slotKey）**
   - 之前问题：`matchesOlderLegacy` 未完全排除非空 `reviewerRoleSlotKey`，可能绕过指纹敏感性及免验任务槽位禁止。
   - 修复实现：
     - 在 `CreateTaskHandler.validate(command)` 首部增加强制校验：若 `!command.requiresAcceptance && (command.reviewerPrincipalId !== null || (command.reviewerRoleSlotKey !== null && command.reviewerRoleSlotKey !== undefined))`，直接抛出 `ApplicationError("REVIEWER_NOT_ALLOWED")`，在查询任何收据前就拦截；
     - `matchesBase` 与 `matchesOlderLegacy` 均严格强制要求 `command.reviewerRoleSlotKey === null || command.reviewerRoleSlotKey === undefined`，彻底阻断非空 slotKey 命中任何 legacy 兼容分支。

4. **MEDIUM: Restore Public API Error Map SECURITY_MIGRATION_MANIFEST_MISMATCH: 409（恢复 Product API 错误映射）**
   - 之前问题：Product API 的 `httpStatus` 映射误将 `SECURITY_MIGRATION_MANIFEST_MISMATCH` 遗漏导致转为 422。
   - 修复实现：在 `apps/product-api/src/app.ts` 中恢复 `SECURITY_MIGRATION_MANIFEST_MISMATCH: 409`，并在 `tests/product-api.test.ts` 中增加精准回归测试。

---

## 2.2 Codex R2 Review Cycle 3 返工项修复 (Cycle 3 Rework)

针对 Codex independent R2 review cycle 3 的 2 项 findings 及测试准确性反馈，执行了彻底的闭环修复与全覆盖回归：

1. **HIGH: Explicit-Reviewer Receipt Substitution Rejection（显式验收人收据篡改替换拦截）**
   - 之前问题：回放时仅重验收据中记录的 reviewer 是否合格，当命令显式指定 reviewer A 时，若收据被篡改成另一名当前合格的 reviewer B，系统误判回放成功并返回被篡改的 B。
   - 修复实现：
     - 在所有被识别的收据世代（`current`、`base`、`older_legacy`）中，当 `command.reviewerPrincipalId !== null` 时，强制校验 `replayedView.reviewerPrincipalId === command.reviewerPrincipalId`，不符直接抛出 `ApplicationError("VALIDATION_FAILED")`，绝不放行；
     - 继续在当前可信时间（`authorizationAtUtc`）下重验同一持久化 reviewer 的资格，若 A 已被撤销/过期则 fail-closed 抛出 `REVIEWER_NOT_ELIGIBLE`；
     - 确保空显式（`command.reviewerPrincipalId === null`）的槽位/节点解析语义不受影响，允许收据保存解析出的非空合格 reviewer。

2. **MEDIUM: Generation-Aware Receipt Creation Invariants（按世代严格定义收据创建不变量）**
   - 之前问题：`projectId` 存在但非字符串（如 number/boolean/object）时未被拦截；`command.assigneePrincipalId === null` 允许收据为非空 assignee；允许伪造的创建快照 status（如 `completed`）或 version（如 999999）。
   - 修复实现：
     - 代码中显式定义 `generation: "current" | "base" | "older_legacy"`，废除试探性宽松校验；
     - 当收据中包含 `projectId` 时，严格校验其必须为 string 且与 `command.projectId` 完全一致，否则抛出 `VALIDATION_FAILED`；
     - 当前世代与 immediate-base 世代严格双向绑定 assignee：命令为 null 则收据必须为 null，命令为 non-null 则收据必须严格一致；仅在 `older_legacy` 世代保留历史表示法（收据不含 assignee 故为 null）；
     - 创建快照状态与版本不变量严格固化：`create_task` 收据必须为 `version === 1` 且 `status === "todo"`，current 世代 `reviewHistory` 必须为空数组；
     - 同时支持后续合法生命周期推进：底层权威 Task 推进到 version 2/3（`in_progress` / `completed`）时，回放原创建命令忠实返回初次创建快照（`version: 1, status: "todo"`）。

3. **TEST: Accurate Labels and Assertions（校正测试标签与断言过度声称）**
   - 将测试标签中无真实并发的“CAS concurrency”纠正为准确的“duplicate taskId rejection”；
   - 在免验任务测试中显式在持久层插入收据，使“even if receipt exists”的测试断言完全名实相符。

---

## 2.3 Codex R2 Review Cycle 4 返工项修复 (Cycle 4 Rework)

针对 Codex independent R2 review cycle 4 的 2 项 findings 及回归/表述要求，执行了彻底的闭环修复：

1. **MEDIUM: Immediate-Base Creation Receipt History Invariant（Immediate-base 创建收据 reviewHistory 不变量强化）**
   - 之前问题：immediate-base 世代收据被允许绕过空 reviewHistory 约束，可能在 Memory 和 SQLite 中回放伪造的非空或畸形评审操作。
   - 修复实现：
     - immediate-base 与 current 世代严格对齐：创建收据的 `reviewHistory` 必须为显式存在的数组，且长度必须为 0 (`raw.reviewHistory.length === 0`)；
     - 废除原宽松的 `taskViewFromReceipt` 解码器，引入严格的 `assertValidTaskReviewActionView` 检查：深度验证 `cycleNumber`（必须为正整数 >= 1）、`action`（必须属于 `"submitted" | "accepted" | "rejected" | "withdrawn"`）、`actorPrincipalId`（非空字符串）、`reviewerPrincipalId`（null 或非空字符串）、`occurredAtUtc`（有效 UTC ISO 字符串）以及 `note`（null 或字符串）；
     - 任何非空、非数组或畸形格式的 `reviewHistory` 均在 Memory 与 SQLite 中 fail-closed 抛出 `VALIDATION_FAILED`。

2. **LOW: Confine Missing-Field Normalization to Documented Older-Legacy（缺失字段归一化严格收敛于旧版遗留收据）**
   - 之前问题：解码器在世代判定前把 undefined 与 null 混同归一化，导致 current 与 immediate-base 世代缺失 `assigneePrincipalId` 或 `reviewHistory` 时被静默补全为 null/空数组。
   - 修复实现：
     - 对于 current 和 immediate-base 世代，强制要求创建快照字段显式存在且类型正确：`assigneePrincipalId` 必须以属性形式存在（`"assigneePrincipalId" in raw` 且 !== undefined），且值必须为 null 或非空字符串（命令为 null 但收据缺失该字段时也一律拦截）；`reviewHistory` 必须显式存在且为数组；
     - 缺失字段归一化（missing-field normalization）严格限制在已归档的 `older_legacy` 世代，仅对该历史 schema 真正缺失的字段进行 null / `[]` 补齐；
     - 避免在世代分类/校验前将 undefined 与 null 视作等价。

3. **TEST: Command-Level Lifecycle Regression & Accurate Test Wording（命令级生命周期回归与准确用词）**
   - 新增完整的命令级生命周期测试：通过真实的 `ActOnTaskHandler` 驱动 `start -> submit -> accept`（版本从 1 推进到 4，状态从 `todo` 到 `completed`），验证对已完成任务回放创建命令依然忠实返回初始创建快照（`version: 1, status: "todo", reviewHistory: []`），且对当前 reviewer 和 assignee 的重验机制依然实时生效；
   - 更新测试命名与文档表述，明确将直接修改持久化状态的测试标记为“Direct persistence state progression”，避免过度声称。

---

## 3. 交付物与代码变更

1. **应用层服务 `packages/application/src/tasks/resolve-task-reviewer.ts`（新增）**：
   - 导出 `resolveTaskReviewer(transaction, params)` 与 `isCandidateEligible(transaction, tenantId, projectId, securityDomainId, candidateId, authorizationAtUtc)`。
   - 严格执行三级解析顺序与四重过滤门禁。

2. **Task 创建用例 `packages/application/src/tasks/create-task.ts`（修改）**：
   - `CreateTaskCommand` 新增可选 `reviewerRoleSlotKey?: string | null | undefined`。
   - 校验格式/长度并抛出 `VALIDATION_FAILED`；`requiresAcceptance=false` 互斥防护。
   - 接入 `resolveTaskReviewer`，并以 `baseFingerprint` + `matchesCurrent` + `matchesOlderLegacy` 支撑兼容。
   - 回放时使用 `persistence.nowUtc()` 执行 `isCandidateEligible` 重验。
   - 严格落实代际不变量、显式存在性与空 history 校验，彻底移除宽松解码。

3. **Product API 路由与架构对齐 `apps/product-api/src/routes/project.ts` & `apps/product-api/src/app.ts`（修改）**：
   - `CreateTaskRequest` 增加可选 `reviewerRoleSlotKey` 字段解码与类型验证。
   - 将 `VALIDATION_FAILED`、`REVIEWER_NOT_ALLOWED`、`REVIEWER_REQUIRED` 映射到 HTTP 422。
   - 恢复 `SECURITY_MIGRATION_MANIFEST_MISMATCH: 409`。

4. **测试套件（修改/新增）**：
   - `tests/task-reviewer-resolution.test.ts`：包含 27 个测试用例，覆盖三级解析全路径、显式覆盖、确定性排序、所有失败回退原因、最终无候选拦截、免验禁止、格式校验、收据指纹隔离、不可变快照、安全冻结、重放重验、基线指纹兼容、收据损坏拦截、权威 Task 不存在/漂移拦截、收据不可变字段校验、显式验收人篡改拦截、世代感知收据校验、创建快照状态/版本不变量校验、immediate-base 空 reviewHistory 及畸形拦截、显式字段缺失拦截、命令级生命周期推进及正向升级兼容测试。
   - `tests/product-api.test.ts`：增加 `reviewerRoleSlotKey` 格式、非空防越权及 409 恢复测试。

---

## 4. 验证与门禁证据

- **针对性测试（Task Reviewer Resolution）**：
  ```bash
  node --experimental-strip-types --test tests/task-reviewer-resolution.test.ts
  ```
  结果：27 passed, 0 failed, 0 skipped.

- **Product API 回归测试**：
  ```bash
  node --experimental-strip-types --test tests/product-api.test.ts
  ```
  结果：21 passed, 0 failed, 0 skipped.

- **Task 升级兼容性测试**：
  ```bash
  node --experimental-strip-types --test tests/task-upgrade-compatibility.test.ts
  ```
  结果：9 passed, 0 failed, 0 skipped.

- **所有 Task 相关测试回归**：
  ```bash
  node --experimental-strip-types --test tests/task-*.test.ts tests/product-task.test.ts
  ```
  结果：43 passed, 0 failed, 0 skipped.

- **完整机械门禁 (`pnpm check`)**：
  ```bash
  pnpm check
  ```
  结果：
  - TypeScript `tsc --noEmit`：0 错误。
  - 测试套件：313 项测试全部通过（313 passed, 0 failed）。
  - Huly 镜像锁：14 个 ARM64 镜像一致（`huly:images` ok）。
  - Huly 扩展包校验：4 个扩展包一致（`huly:extension:verify` ok）。

- **Git Diff 格式检查**：
  ```bash
  git diff --check
  ```
  结果：Clean（无行尾空格，无冲突标记，退出码 0）。

- **密钥与凭据扫描**：
  结果：零匹配，未引入任何明文凭证、私钥或测试密钥。

---

## 5. 下一步

Codex R2 Review Cycle 5 已通过（PASS）。本切片已完成最终验收，状态为 ACCEPTED / DONE；提交与推送由授权工作流执行。
