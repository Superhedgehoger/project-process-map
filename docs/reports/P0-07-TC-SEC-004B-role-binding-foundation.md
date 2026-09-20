# P0-07 / TC-SEC-004B TemplateRoleSlot 与 ProjectRoleBinding 领域模型与持久化底座

- 日期：2026-09-15
- 任务标识：P0-07 / TC-SEC-004B
- 功能契约：FC-006、A4-03A
- 验收测试：TC-TASK-005、TC-SEC-004B
- 风险评级：R2（已按批准产品规则建立安全收敛边界）
- 基线提交：3f047c7a7cff1d6cef32bde952dde2f3920db811
- 状态：ACCEPTED / DONE（Codex R2 Cycle 7：PASS）

---

## 1. 批准产品规则落地（Product Decisions Enforced）

1. **多人候选人集合绑定（Multi-Principal Candidate Set）**：
   - 单个项目槽位支持绑定多名用户主体。
   - 领域层 `normalizeCandidateIds` 对候选人数组去重并按 locale-independent 字典序确定性排序存储。
   - 本切片不发明最终评审人选择算法，仅持久化并返回确定性候选集。
2. **项目模板版本槽位快照（Project Template Slot Snapshot）**：
   - 项目在 `project_role_slots` 表与 `project_role_slot_snapshots` 表中持久化保存来自模板版本的槽位快照与版本标记。
   - 模板后续变更不隐式静默篡改已有项目槽位；跨版本槽位升级不在本切片范围内。
3. **项目经理受守卫维护（PM Maintenance Guard）**：
   - 仅当前激活且具有同项目 `project_manager` 角色成员身份的自然人操作者可创建、替换、清空（`principalIds: []`）绑定及初始化槽位。
   - 绑定本身不授予 Membership、Grant 或 ACL，后续在 Task/对象使用时仍需严格重新计算 `RBAC ∩ Membership ∩ Grant`。
4. **失效/缺失回退（Fallthrough Semantics）**：
   - 无效/缺失/不合格的槽位绑定在后续 Task 解析中回退到属主节点负责人（Node Owner / U2），若仍缺失则标记 `REVIEWER_REQUIRED`。本切片严格不改写任务流转逻辑。

---

## 2. Codex R2 Review Cycle 1 Rework 修复（Cycle 1 Findings & Resolutions）

1. **P1 Project Snapshot Mutation Bypass**：
   - 从 `TransactionContext.roleSlots` 中彻底移除了通用的 `insert` 写入口，`TransactionContext` 仅保留 `get` 与 `listByProject` 只读方法。
   - 引入受控的槽位快照初始化入口 `persistence.executeInitializeProjectRoleSlots`，严格实施 PM 身份鉴权、迁移安全期冻结、载荷指纹幂等回执。
   - 实施单项目单一模板版本冻结（`ROLE_SLOT_TEMPLATE_VERSION_FROZEN`）与 write-once 槽位定义不可变校验（`ROLE_SLOT_IMMUTABLE_CONFLICT`），完全拦截增补槽位、篡改定义或跨版本混用。
   - 为 Memory 与 SQLite 添加了完整的权限矩阵、快照不可变性及防绕过探针测试。
2. **P2 Deterministic String Ordering**：
   - 废除任何依赖宿主环境的 `localeCompare`，全面采用 ECMAScript 规范定义严格 code-unit 比较 `compareExactStrings(a, b)`（`a < b ? -1 : a > b ? 1 : 0`）。
   - 添加 Unicode 组合字符排列测试（`user-\u00E9` vs `user-e\u0301`），证明任意入参排列下输出集合与哈希指纹严格一致，幂等重放行为无歧义。
3. **P2 SQLite Corrupt-Row Fail-Closed**：
   - 读取持久化行时杜绝自动 normalize 或 trim（避免掩盖非法数据）；
   - 引入领域层严格规范校验 `assertCanonicalProjectRoleBinding` 与 `assertCanonicalTemplateRoleSlot`，强制校验 ID 非空且未填充、候选人无重复且严格升序、版本为正整数、时间戳为规范 UTC ISO 字符串、租户/项目/槽位无 Discriminator 偏移；
   - 校验失败统一抛出 `ApplicationError`（`ROLE_BINDING_RECORD_CORRUPT` 与 `ROLE_SLOT_RECORD_CORRUPT`）；
   - SQLite 与 Memory 均配备直接数据损坏测试矩阵（空格填充候选人、重复候选人、逆序候选人、非法时间戳、空格填充修改人、Discriminator 漂移）。
4. **Memory Receipt Rollback Assertion**：
   - 修复 Memory 回执 key 格式为 `\u0000`（NUL）分隔符（`${tenant}\u0000${principal}\u0000${op}\u0000${key}`），纠正旧测试使用冒号冒领断言的假阴性缺陷。
   - 验证成功时回执确实存在且可按 `\u0000` 查得，各故障注入点确实完整回滚零残留。
5. **List Ordering Parity**：
   - Memory 与 SQLite 的 `roleSlots.listByProject` 和 `roleBindings.listByProject` 统一通过 `compareExactStrings` 保证 100% 确定性排序；
   - 自动化跨持久化引擎一致性断言确认乱序写入后输出完全等价。

---

## 3. Codex R2 Review Cycle 2 Rework 修复（Cycle 2 Findings & Resolutions）

1. **原子初始化链路与故障注入（Atomic Initialization Chain & Failure Injection）**：
   - 补全 `executeInitializeProjectRoleSlots` 的完整原子事务写链路：
     - Snapshot 标记与槽位状态持久化；
     - Audit 记录（`ProjectRoleSlotAuditEntry`，Action `"initialized"`，写入 `project_role_slot_audits` / `roleSlotAudits`）；
     - Event 记录（注册 `project-map.role-slots.initialized` v1，严格脱敏：载荷仅包含 `{ projectId, sourceTemplateVersionId, slotKeys }`，杜绝槽位名称、描述与敏感快照字段泄漏）；
     - Outbox 记录（topic `project-map.role-slots.initialized.v1`，发布状态，包含完整脱敏领域事件）；
     - Idempotency 回执记录（绑定操作范围与指纹）。
   - 为 Memory 与 SQLite 实现 5 级故障注入点（`after_state`、`after_audit`、`after_event`、`after_outbox`、`after_idempotency`），证明在任一阶段失败时事务均完整回滚，零部分写入，且 project sequence 严格回滚。
2. **空槽位 `slots: []` 独立持久快照标记与版本冻结（Empty Slots Snapshot Marker & Version Freeze）**：
   - SQLite 引入独立表 `project_role_slot_snapshots`（Memory 引入 `roleSlotSnapshots` Map），记录 `(tenant_id, project_id, source_template_version_id, created_at_utc, created_by_principal_id)`。
   - 杜绝仅靠 `project_role_slots` 行数推断初始化状态。即使 `slots: []`，亦原子落盘持久化版本标记。
   - 空槽位初始化后，后续尝试以不同模板版本（如 v2）或非等价定义再次初始化时，均 fail-closed 抛出 `ROLE_SLOT_TEMPLATE_VERSION_FROZEN` 或 `ROLE_SLOT_IMMUTABLE_CONFLICT`；完全等价重放正常成功返回 `replayed: true`。
   - 测试覆盖了 Memory、SQLite 以及 SQLite 进程重启跨会话持久性验证。
3. **Memory Map 权威存储 Key 校验 vs 静默过滤（Memory Storage Key Validation vs Silent Filtering）**：
   - Memory `roleSlots` 与 `roleBindings` 的 `get` 与 `listByProject` 在返回前，强制将内存对象属性与 authoritative Map storage key（`${tenantId}\0${projectId}\0${slotKey}`）进行三元组比对。
   - 出现任何 Discriminator 漂移立即抛出 `ROLE_SLOT_RECORD_CORRUPT` / `ROLE_BINDING_RECORD_CORRUPT`，杜绝被 `.filter()` 静默吞没或改写作用域。
4. **回执重放前权威状态严格校验（Authoritative State Validation Before Receipt Replay）**：
   - 在返回绑定赋值和初始化回执前，强制读取当前持久化权威状态（绑定记录、快照标记、槽位记录）并执行 `assertCanonical*` 规范校验。
   - 若底层行或内存对象被篡改（如非法时间戳、候选人非规范、Discriminator 漂移），回执重放立即 fail-closed 抛出 CORRUPT 异常，禁止直接返回陈旧回执。

---

## 4. Codex R2 Review Cycle 3 Rework 修复（Cycle 3 Findings & Resolutions）

1. **保留合法的历史绑定重放（Preserve Legitimate Historical Binding Replay）**：
   - 修复绑定回执重放校验逻辑：当项目角色绑定版本从 v1 递进到 v2（或 v3）后，原始 v1 幂等指令的重放必须成功。
   - 独立校验当前权威状态规范性（`currentBinding.version >= receipt.binding.version`、候选人资格、时间戳有效），并将历史回执自身的结果（binding、event、outbox）与当前权威状态解耦独立校验，不再要求当前版本或时间戳必须等于历史回执状态。
   - Memory 与 SQLite 均通过了 v1 -> v2 -> v3 的合法重放测试，并在当前权威记录损坏时严格 fail-closed。
2. **完整的回执重放一致性校验（Complete Replay Coherence）**：
   - 绑定重放：独立校验当前权威绑定与回执记录中 binding（principalIds、updatedBy、version、updatedAtUtc）、event（eventId、sequence > 0、payload）、outbox（id、eventId 关联）的完整性。
   - 初始化重放：独立校验权威 snapshot/slots 与回执中的 snapshot（sourceTemplateVersionId、createdBy）、slots（所有 slotKey、name、description）、event（sequence > 0、payload slotKeys 关联）、outbox（id、eventId、topic）、audit 记录（action、slotKeys 关联）及 discriminator scope。
   - 为 Memory 与 SQLite 均添加了 canonical-but-divergent 及 corrupted receipt event/outbox 的反向 fail-closed 测试。
3. **彻底消除虚构的相同初始化结果（Remove Fabricated Identical-Initialization Results）**：
   - 当使用不同幂等键对已存在的相同冻结快照执行等价初始化时，返回并持久化落盘的回执必须由底层权威持久化历史支持（从 `roleSlotAudits`、`domain_events`、`outbox_messages` / SQLite `command_receipts` 真实读取），绝不凭空捏造 sequence 0、非持久化事件/outbox 或 `{}` 空载荷。
   - Memory 与 SQLite 均配备严格的权威历史回填与二次重放一致性测试。
4. **Memory Map 畸变 Storage Key Fail-Closed（Memory Get Malformed Key Fail-Closed）**：
   - 修复 Memory `roleSlots.get` 与 `roleBindings.get`：遍历所有条目时，对任何 key split 长度不为 3 但其值声称归属请求 tenant/project/slot，或 key 归属目标 slot 但格式畸变（如 extra segments）的记录，严格抛出 `ROLE_SLOT_RECORD_CORRUPT` / `ROLE_BINDING_RECORD_CORRUPT`，杜绝被跳过并返回 undefined。
   - `roleSlotSnapshots.getSnapshot` 同样实施严格的 split 长度为 2 校验。
5. **加固 SQLite v11 升级以防同名冲突不兼容表（Harden SQLite v11 Upgrade Against Incompatible Tables）**：
   - 在记录 migration 11 之前，引入严格的表形状校验 `#validateV11TableShapes`，对所有 4 张表（`project_role_slot_snapshots`、`project_role_slots`、`project_role_slot_audits`、`project_role_bindings`）的 `STRICT` 模式、确切列名与类型、NOT NULL、主键组合及外键定义进行逐项检查。
   - 若 v10 数据库存在同名但不兼容的表（如缺少 STRICT、列定义冲突、缺少外键），迁移事务在写入 `schema_migrations` 前即失败并 ROLLBACK，数据库严格停留在 v10。
   - 在 `tests/task-upgrade-compatibility.test.ts` 中添加了针对上述 3 种破坏性情形的具体损坏表升级回滚测试。
6. **恢复精准故障点类型定义与消除无关漂移（Restore Precise Failure Point Typing）**：
   - 从 `packages/application/src/create-node.ts` 中彻底移除了角色槽位与绑定的 failure point 类型耦合与空行漂移，恢复为 `CreateNodeFailurePoint | AssignNodeLeaderFailurePoint`。
   - 分别在 `packages/application/src/role-slots/assign-project-role-binding.ts` 与 `packages/application/src/role-slots/initialize-project-role-slots.ts` 中导出精准的 `injectRoleBindingFailure` 与 `injectRoleSlotFailure`。


---

## 5. Codex R2 Review Cycle 4 Rework 修复（Cycle 4 Findings & Resolutions）

1. **重放时校验持久化记录而非仅回执嵌入对象（Durable Records Independent Validation on Replay）**：
   - 绑定重放（Binding Replay）：不仅校验回执自身的格式，还通过底层权威存储独立加载持久化领域事件（`domain_events` / `Memory.events`）与 Outbox 记录（`outbox_messages` / `Memory.outbox`）。若持久化记录缺失、被删或字段（ID、序列号、载荷、主题）与回执不一致，立即 fail-closed 抛出 `ROLE_BINDING_RECORD_CORRUPT`。同时保留合法的历史绑定重放（当前权威版本更新但历史回执和持久化事件记录一致时，重放成功返回 `replayed: true`）。
   - 初始化重放（Initialization Replay）：不仅校验回执内容，还独立从底层存储加载持久化审计记录（`project_role_slot_audits` / `Memory.roleSlotAudits`）、领域事件与 Outbox。调用全局强一致校验器 `assertCoherentRoleSlotsInitializationRecords`，并在持久化记录缺失或发散时严格抛出 `ROLE_SLOT_RECORD_CORRUPT`。
   - 为 Memory 与 SQLite 均添加了底层事件/Outbox/审计记录缺失和篡改发散的负向测试矩阵。
2. **不同幂等键等价初始化运行全量跨记录一致性校验（Cross-Record Coherence Validation on Identical Initialization）**：
   - 当收到不同幂等键但快照与槽位完全等价的初始化指令时，在生成新回执前，必须从持久化存储加载现有的 Audit、Event、Outbox 记录，并通过 `assertCoherentRoleSlotsInitializationRecords` 严格校验 Snapshot、Slots、Audit、Event、Outbox 的所有 ID、作用域（tenant/project）、slotKeys（严格一致且排序相同）、时间戳（occurredAtUtc = createdAtUtc）、序列号（`projectSequence > 0`）与载荷完全吻合。
   - 若底层历史记录存在任何损坏、序列号为 0、slotKeys 不匹配或主题异常，立即 fail-closed 抛出 `ROLE_SLOT_RECORD_CORRUPT`，且绝不写入新回执（创建 0 回执）。
   - Memory 与 SQLite 均配备了破坏性持久历史（如篡改 sequence、篡改 topic、篡改 audit slotKeys）并验证零回执生成的测试用例。
3. **SQLite 打开已标记 v11 数据库必须运行完整表形状校验与 CHECK 约束检查（SQLite v11 Table Shape & CHECK Validation）**：
   - 无论是在升级到 v11 写入 `schema_migrations` 之前，还是在打开一个已经标记为 v11（`maxRow.version >= 11 && countRow.count === 11`）的既有数据库时，`SqlitePersistence` 均无条件执行 `#validateV11TableShapes(this.#database)`。
   - 扩充 `#validateV11TableShapes` 检查逻辑：
     - 强制检查 `project_role_bindings` 表 DDL 中包含 `CHECK (version > 0)` 约束（通过正则 `/\bCHECK\s*\(\s*version\s*>\s*0\s*\)/i` 校验）；
     - 强制检查 `idx_project_role_slot_audits_project` 索引定义及其在 `project_role_slot_audits(tenant_id, project_id, sequence)` 上的正确性；
     - 在构造函数发生任何 schema 校验或迁移异常时，使用 `try...catch` 确保 `this.#database.close()` 安全释放句柄。
   - 在 `tests/task-upgrade-compatibility.test.ts` 中新增了 Case D（v10 数据库表结构看似完全一致但缺失 `CHECK (version > 0)`，升级时立即拒绝并回滚保留在 v10）以及已标记 v11 数据库在丢失 CHECK、丢失 STRICT 或丢失 Index 时重新打开均 fail-closed 的完整测试。

---

## 6. Codex R2 Review Cycle 5 Rework 修复（Cycle 5 Findings & Resolutions）

1. **初始化回执内鉴别器与字段完整规范校验（Receipt-Embedded Discriminators & Canonical Validation on Replay）**：
   - 彻底修复初始化回放漏洞：在 `executeInitializeProjectRoleSlots` 回执重放阶段，不仅使用底层持久化记录验证回执等价性，还无条件对回执嵌入记录（`previous.result.snapshot`、`previous.result.slots`、`previous.result.audit`、`previous.result.event`、`previous.result.outbox`）运行全量规范强一致性校验 `assertCoherentRoleSlotsInitializationRecords`。
   - 任何针对 `slots[0].tenantId`、`slots[0].projectId`、`audit.tenantId`、`audit.projectId`、`snapshot.tenantId`、`snapshot.projectId`、`event.tenantId`、`event.projectId`、`outbox.tenantId` 等鉴别器的篡改，均在回放返回前被拦截并抛出 `ROLE_SLOT_RECORD_CORRUPT`。
   - 在比对回执与底层记录时，强制补齐 slot 的 `tenantId`、`projectId` 及 audit 的 `tenantId`、`projectId` 与 outbox 的 `tenantId` 字段级双向一致性检查。
   - Memory 与 SQLite 均配备完整的鉴别器篡改拦截矩阵测试。
2. **SQLite 全量交叉校验 `domain_events` 关系列与 `event_json`（Cross-Check SQLite `domain_events` Relational Columns vs `event_json`）**：
   - 在 SQLite 中新增 `domainEventFromRow` 辅助函数，对从 `domain_events` 表读取的每一行，将其实际存储的 10 个关系列（`tenant_id`、`event_id`、`project_id`、`project_sequence`、`aggregate_type`、`aggregate_id`、`aggregate_version`、`event_type`、`schema_version`、`occurred_at_utc`）与反序列化后的 `event_json` 对象进行逐一严格比对。
   - 在角色绑定重放、角色槽位初始化重放以及不同幂等键等价初始化历史加载的所有路径上，全面应用 `domainEventFromRow`。
   - 出现任何关系列与 JSON 漂移（如关系列 `project_sequence` 从 1 篡改为 999 而 JSON 仍为 1，或 `project_id`、`event_type` 篡改），立即 fail-closed 抛出 `ROLE_SLOT_RECORD_CORRUPT`（或 `ROLE_BINDING_RECORD_CORRUPT`）。在不同幂等键等价初始化路径下，事务直接中止，保证产生 0 个新回执。
   - 在 `tests/role-binding.test.ts` 中新增了关系列 `project_sequence`、`project_id`、`event_type` 漂移阻断及 0 新回执验证测试，以及绑定重放关系列漂移阻断测试。

---

## 7. Codex R2 Review Cycle 6 Rework 修复（Cycle 6 Findings & Resolutions）

1. **Memory 角色绑定回执重放补齐 durable outbox 值侧 ID 强校验（Memory Binding Replay Value-Side Outbox ID Coherence）**：
   - 修复 Memory 角色绑定回执重放中的漏洞：在 `executeAssignProjectRoleBinding` 重放阶段，独立加载持久化 outbox 消息后，原实现仅比对了 `tenantId`、`eventId`、`topic`、`createdAtUtc` 及 `payload`，遗漏了 `durableOutbox.id !== rout.id`。
   - 由于 Memory 存储以 `${command.tenantId}\0${rout.id}` 为 Map key，当攻击者或并发异常保留合法 Map key 但篡改 Map value 内的 `id` 属性时，原校验会误判为有效。
   - 现已显式加入 `durableOutbox.id !== rout.id`（并在 SQLite 中对称保留此双重防御），任何值侧 ID 发散均立即 fail-closed 抛出 `ROLE_BINDING_RECORD_CORRUPT`。
2. **回归测试覆盖（Memory Outbox Value-Side Tamper Regression Test）**：
   - 在 `tests/role-binding.test.ts` 的 Cycle 4 Finding 1 测试块中补充针对 Memory 的专项回归测试：保持 Map key `${tenant}\0${res1.outbox.id}` 不变，仅篡改 value 对象的 `id` 属性，断言重放命令被立即拒绝并抛出 `ROLE_BINDING_RECORD_CORRUPT`。

---

## 8. 验收与验证证据（Verification Evidence）

- **定向安全与兼容性测试套件**：
  `node --experimental-strip-types --test tests/role-binding.test.ts tests/task-upgrade-compatibility.test.ts`
  - 结果：**72 passed, 0 failed, 0 skipped** (耗时 ~500ms)
    - 62 个 `tests/role-binding.test.ts` 测试（包含 Cycle 1 至 Cycle 6 所有正向、负向、并发、重启、历史重放、回执损坏、持久记录缺失/发散、鉴别器篡改拦截、SQLite 关系列/JSON 交叉校验、Memory 值侧 Outbox ID 篡改拦截、畸变 key 与故障注入矩阵）
    - 10 个 `tests/task-upgrade-compatibility.test.ts` 测试（包含 schema v10 -> v11 迁移、旧二进制拒绝、Cycle 3 损坏表迁移回滚、Cycle 4 Case D 缺少 CHECK 升级回滚、以及 Cycle 4 已是 v11 畸变表重打开 fail-closed 测试）
- **全量工程检查与类型检查**：
  `pnpm check`
  - `tsc --noEmit`：0 errors, clean
  - 284/284 passed (0 fail, 0 skipped)
  - `pnpm huly:images`：14 ARM64 镜像锁通过
  - `pnpm huly:extension:verify`：4 扩展包校验通过
- **Git 格式检查**：
  `git diff --check`：Clean（0 warnings/errors）
- **凭据扫描**：
  无凭据、私钥或生产敏感数据提交（0 matches）

---

## 9. Codex R2 Review Cycle 7 验收（Final Independent Review）

- 最终结论：**PASS**，可进入验收、Evidence、commit 与 push。
- Cycle 6 漏口已关闭：Memory 绑定回放现在强制校验 durable outbox value-side `id` 与回执/权威 key 身份一致；SQLite 保持同等防御。
- Reviewer 在隔离临时副本中移除该比较后，新增回归测试立即失败（`Missing expected rejection`），证明测试能够真实捕获该漏洞。
- 合法历史版本回放、PM/候选人重新授权、可信时间、快照不可变、迁移冻结、CAS/并发/重启、原子 artifact 链、v11 schema 验证与 ADR-008 事件卫生均未回归。
- 独立复跑结果：focused 2/2、targeted 72/72、full 284/284；typecheck、Huly 14/4、diff、JSON 与凭据扫描全部通过。

---

## 10. 状态与下一步动作（Status & Next Action）

- **当前状态**：`ACCEPTED / DONE`
- **下一步动作**：提交并推送已验收工作树，然后按 Disk State 选择下一个 Ready Task。

