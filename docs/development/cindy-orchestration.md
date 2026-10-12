# Cindy 开发闭环自动编排方案

## 1. 目标与边界

Cindy 作为唯一 Orchestrator，尽可能自动执行：

```text
Task 初始化
→ Builder
→ 独立 Test / Gate
→ 独立 Codex Review
→ FAIL 自动生成 Repair
→ Repair Builder
→ Re-test / Re-review
→ PASS 后 Closeout
→ Commit / Push
→ 识别 Next Task
```

仅在以下情况暂停并请求产品负责人决策：

- `PRODUCT_DECISION_REQUIRED`；
- 真实 `BLOCKER`；
- 需求、功能契约或权威来源冲突；
- 无法由当前 run 解释的 dirty tree；
- 需要 reset、rebase、force push、删除分支等危险 Git 操作；
- migration、安全边界、ACL 或 authority 方案无法从已批准契约唯一推出。

Antigravity CLI 不再使用。Antigravity Desktop 可作为可选 Builder；遇到范围选择时固定选择 **in the project**。Codex / GPT-5.6 Sol 用于规划和独立只读 Review，不得同时充当同一轮实现的 Builder 与 Reviewer。

## 2. 权威与角色隔离

### 2.1 恢复权威与权威来源

恢复与初始化时严格依据以下不可篡改事实，禁止依赖未经证明的本地文件或松散指针：

1. **Git 仓库事实**：当前 branch、HEAD commit、upstreamRef、upstreamCommit 与 working tree clean/dirty 状态；
2. **已提交 Task 权威（Task Authority）**：
   - 权威 Task Packet 必须提交于当前 Git HEAD 历史中（`.agent/tasks/<taskId>/task.json`）；
   - Task 权威锚点为 Git 历史派生的 `taskAuthorityCommit`（最后修改该 Task Packet 的 Git commit SHA）；
   - 初始化时当前 HEAD 必须严格等于 `taskAuthorityCommit`（无漂移）；
   - 未来若 HEAD 前进，必须通过正式 Task activation/update commit 修改 Task Packet 产生新的 `taskAuthorityCommit`；
3. **已提交 Closure 权威**：HEAD 中已记录 `status: CLOSED` 的 Task 永久闭环，禁止二次执行；
4. **唯一 Active Run 权威**：`.agent/runtime/` 下每个任务最多存在一个活跃运行态，且必须分别满足实时权威等式（Equation A: `actualHead == run.taskAuthorityCommit == run.headCommit == currentTask.taskAuthorityCommit`）与声明基线等式（Equation B: `run.baseCommit == currentTask.baseCommit`，且基线为 authority 的祖先提交）；
5. **`.agent/current.json` 仅为 Hint 指针**：仅作为非权威提示（hint only），不得单独用于授权执行或替代 Git/Active Run 事实；
6. 任何说明性文档（handoff、phase status 等）均不可作为执行凭据。

状态源冲突必须先执行 reconcile；不能重复提交已包含在 HEAD 中的切片，也不能改写原始 FAIL 历史。

### 2.2 角色

- **Cindy Orchestrator**：状态迁移、工件校验、Git 安全、独立 Gate、调度 Builder/Reviewer、Repair 初始化、Closeout、普通 commit/push、Next Task 选择。
- **Builder**：只实现当前 Task 或 Repair，运行定向测试并回传摘要；不得写 Review verdict、commit/push 或选择下一任务。
- **Codex Reviewer**：新上下文、只读、独立身份；审查从原始 task base 到最终 tree 的累计 diff，不修改工作树。
- **Antigravity Desktop**：可选 Builder adapter。Cindy 生成 packet，Desktop 完成修改后由 Cindy 重新计算 diff 和运行 Gate；不信任 Desktop 自报 PASS。

## 3. 状态机

```text
RECONCILING
→ TASK_INITIALIZED
→ READY_FOR_BUILDER
→ BUILDING
→ BUILDER_COMPLETE
→ TESTING
→ READY_FOR_REVIEW
→ REVIEWING
├─ PASS → FINAL_GATE → READY_TO_COMMIT → COMMITTING → PUSHING → CLOSED
│                                                        └→ NEXT_TASK_SELECTED
└─ FAIL → REPAIR_INITIALIZED → REPAIR_BUILDING → TESTING → READY_FOR_REVIEW
```

暂停状态：

- `PRODUCT_DECISION_REQUIRED`
- `BLOCKED`
- `CONTRACT_CONFLICT`
- `DIRTY_TREE_UNEXPLAINED`
- `GIT_SAFETY_STOP`
- `MIGRATION_OR_SECURITY_AMBIGUITY`

状态迁移必须幂等。`FAIL` 自动进入 Repair，不把正常返工当作人工暂停原因。

## 4. Run 与工件

工件分为两个平面，禁止让 Review/Test 结果修改它们所证明的 tree：

1. **Tracked control packet**：Task/Repair packet、预先声明的 scope、required gates 与静态配置；必须在 Final Review 冻结 tree 之前完成，之后不再修改。
2. **Runtime evidence**：所有执行后才产生的 baseline、diff/test/review/closeout/git/next-task 结果，写入 Cindy/harness durable run store；若使用仓库路径，只能写入被 Git 忽略的 `.agent/runtime/<run-id>/`。

```text
.agent/runtime/<run-id>/
  run.json
  baseline.json
  builder-result.json
  diff-manifest.json
  test-result-cycle-N.json
  review-request-cycle-N.json
  review-result-cycle-N.json
  repair-init-cycle-N.json
  closeout.json
  git-receipt.json
  next-task.json
```

实际 commit SHA、push 前后 remote SHA、最终 clean 状态和 push 后 Next Task 选择都是 post-commit 事实，不能预写进产生该 commit 的 tracked tree。Orchestrator 不得为记录“clean”而在 push 后制造新的未解释 dirty tree。若需要把 CLOSED 状态和 receipt 摘要纳入仓库，必须作为后续独立的 metadata reconciliation checkpoint 提交；该 checkpoint 自身的实际 push receipt 仍只存在 runtime store，避免递归自引用。

最低绑定要求：

- baseline：branch、base HEAD、upstream SHA、初始 tree 状态；
- diff manifest：完整 changed/untracked 列表、允许范围、diff digest、最终 tree digest；
- test result：命令、起止时间、退出码、tree digest、日志 digest；
- review result：reviewer identity/session、只读声明、reviewed base/tree/diff digest、结构化 verdict 与 findings；
- post-commit git receipt：commit SHA、remote/ref、push 前后 remote SHA、最终 clean 状态；保存于仓库外 durable store 或 ignored runtime 目录，避免自引用。

`STRUCTURE_VALID_EXTERNAL` 表示该工件由外部执行者产生，Cindy 在受控 Typed Writer 的原子写入边界内重新验证了 Schema、run/task/cycle 身份、当前状态以及该工件所要求的 Git / tree / diff / reviewer-session 等绑定，并以不可变形式持久化。该分类不表示 Cindy 自己执行了测试、Review 或外部命令，不证明外部执行过程真实发生，也不等价于 TRUSTED_EXECUTOR / PROCESS_ATTESTED / GATE_PASS。不能因 Builder 编辑 JSON 就获得 PASS、CLOSED 或 push 权限。最终产品 commit 必须逐字节匹配 Reviewer 已冻结的 product tree；runtime evidence 不属于该 tree。

## 5. Review / Repair 协议

1. Review 开始时冻结完整 working-tree/diff digest；Review 期间任何 tracked、staged、untracked、新增、删除或重命名变化都立即使本轮结论失效。
2. 每个 finding 使用稳定 ID，保留原文、severity、失败场景、复现方式、要求和 disposition。
3. Repair packet 必须逐项引用 finding ID，只允许最小修复与直接回归测试。
4. Re-review 逐项给出 `OPEN` / `CLOSED`，同时重新审查从父 Task base 到当前 tree 的累计 diff。
5. 原始 FAIL 永久保留，不得重写成 PASS。
6. 默认最多 3 个自动 Repair cycle；同类 finding 第二次复发、范围持续膨胀或出现未批准的 migration/security 设计时，升级为真实 `BLOCKER` 或 `PRODUCT_DECISION_REQUIRED`。

## 6. Gate 与 Git 安全

### 6.1 Gate

Task Packet 必须声明风险驱动的 required gates；最低包含：

- 定向测试；
- `pnpm check`；
- `git diff --check`；
- JSON / artifact 结构校验；
- 高置信凭据、私钥、登录数据与生产个人数据扫描。

涉及发行、真实持久化、升级、浏览器或 Huly 的切片必须追加对应 build/smoke/baseline gate，不能把 `pnpm check` 当作充分证据。

### 6.2 Commit / Push

只允许普通 commit 和 fast-forward push。执行前必须满足：

- 最终 tree 与 PASS 绑定的 tree 完全相同；
- 所有 finding 已 CLOSED，Final Gate 在该 tree 上 PASS；
- branch、base、scope 与 dirty tree 均可解释；
- fetch 后 upstream 未漂移；
- commit message 与 Task ID 可追踪。

禁止自动执行 `reset --hard`、`clean -fd`、stash、rebase、amend、force push 或远端分支删除。Push 后验证远端 SHA 等于本地 commit SHA。

## 7. Next Task 选择

自动选择仅在存在唯一 Ready Task 时执行，并验证：

- objective 来自已批准 backlog / Task Packet；
- 所有 dependencies 已 CLOSED 且已推送；
- risk、required gates 和 authority sources 已登记；
- 不存在同优先级冲突候选。

没有唯一候选时只输出候选与理由，并暂停为契约/优先级决策，不由模型自行创造优先级。

## 8. 分阶段落地与架构决策

### 8.1 落地阶段

1. **Control Plane MVP**：状态 schema、legacy reconcile、dirty-tree guard、artifact writer、幂等恢复。
2. **Gate Automation**：真实命令执行、tree/log digest、凭据扫描与 required-gates 校验。
3. **Review / Repair Loop**：只读 Reviewer adapter、结构化 findings、自动 Repair packet、循环熔断。
4. **Safe Closeout**：Final Gate、closeout、普通 commit、fetch/fast-forward push、git receipt。
5. **Next Task**：结构化 backlog 与唯一 Ready Task 选择。
6. **Desktop Adapter**：最后接入 Antigravity Desktop；无法可靠判断完成时停在 `READY_FOR_BUILDER`，不得伪造执行结果。

首个自动化实现切片应只交付第 1 阶段，不与 `P0-05A-T2c` 产品代码混合；自动化自身也必须经过独立 Review 后，才逐步开放 commit/push 权限。

### 8.2 已批准架构决策（R2F1-R2）

#### DECISION A — Control Plane MVP 不提供提交授权
CINDY-ORCH-MVP 是 Control Plane MVP，本阶段明确 NON-GOAL：自动完整 Gate、自动 Closeout、git commit、git push、Next Task 自动执行。
- `FINAL_GATE`、`READY_TO_COMMIT`、`COMMITTING`、`PUSHING`、`CLOSED`、`NEXT_TASK_SELECTED` 保留在状态词汇与 schema 中，但 MVP 不存在任何公开可执行路径可推进到这些状态。
- `recordValidatedFinalGateResult()` 与 `recordCloseout()` 稳定 fail closed，抛出 `FEATURE_NOT_AVAILABLE_IN_CONTROL_PLANE_MVP`。
- 所有公开 API 尝试进入特权状态均被无条件拒绝。

#### DECISION B — 本地文件系统 Threat Model
- **防御范围**：malformed input、path traversal、absolute path escape、static symlink escape、并发 orchestrator runs、stale locks、crash/partial writes、stale evidence、unauthorized public API use。
- **非防御范围**：同一个系统 UID 下恶意代码若具有并发修改 runtime FS 的能力，本系统不承诺抵御该层面的竞态；该主体本身已经具有直接修改 repo 产品文件的权限，不存在由 runtime artifact writer 新增的实际权限边界。
- **路径规范化**：repoRoot 在启动时通过 `realpath(repoRoot)` 规范化一次，后续所有路径从 canonical root 派生。拒绝已有 symlink、dangling symlink、runtime root symlink、run dir symlink 与 artifact target symlink。

#### DECISION C — Cindy Control Schema Dialect v1
- 不再声称完整 JSON Schema Draft 2020-12 实现，定义明确的 `Cindy Control Schema Dialect v1`（`https://cindy.control-plane.local/schemas/dialect/v1`）。
- 严格白名单关键字校验，未知关键字一律 FAIL CLOSED。
- 格式限制：当前仅支持 `format: date-time`，未知格式（如 `email`）一律 FAIL CLOSED。
- 数组 items：不支持布尔 schema（`items: false`），遇到一律 FAIL CLOSED。

#### Safe Closeout 工件映射规范（M02 递延）
在未来 Safe Closeout 阶段，必须建立：
`reviewed pre-commit tree ↔ resulting commit tree ↔ git receipt`
的双向映射事实链，而非简单比较 commit 前后的 HEAD digest，以防止提交本身使 pre-commit digest 比较失效。当前 MVP 封死 closeout 执行路径，避免错误比较。

#### DECISION D — 锁安全与 Stale Lock 契约（Control Plane MVP）

在 Control Plane MVP 阶段收敛锁获取与陈旧锁处理契约：

- **Lock acquisition（自动、安全）**：采用 candidate-file + atomic link 模式（`open(".run.lock.candidate.<uuid>", "wx")` → 写入元数据 → `filehandle.sync()` → `filehandle.close()` → 重新读取并校验元数据完整性 → `link(candidatePath, lockPath)`）。
  `link()` 在 POSIX 文件系统上提供原子的 create-if-absent 语义，不存在 TOCTOU acquisition window。正式 `.run.lock` 只能在元数据完整、sync 完成后出现。候选文件在写入、同步或校验失败时仅清理自身候选文件，绝不污染或残留正式主锁。
- **Lock contention（fail closed）**：若争抢返回 `EEXIST`，且检测到锁仍被持有或未知，fail closed（重试等待超时后报 `CONCURRENT_RUN_UPDATE`）。
- **Stale lock detection（自动）**：自动检测。若 `.run.lock` 持有者 PID 在本机通过 `process.kill(pid, 0)` 返回 `ESRCH` 确认死亡，识别为 stale。
- **Stale lock reclamation（Control Plane MVP 不支持）**：Control Plane MVP 明确**不得自动** `unlink`、`rename`、`replace` 或 `reclaim` 该主锁。检测到 confirmed dead owner 时稳定 fail closed，抛出结构化错误 `STALE_RUN_LOCK_REQUIRES_RECONCILIATION`。
- **Fail-closed stage boundary 说明**：此决策并非临时 bug workaround，而是明确的 fail-closed stage boundary。基于 Node/pathname 的自动回收无法在缺乏原子 CAS 保证的前提下安全避免“观察 stale → 回收并创建新锁 → 延迟 recoverer 破坏新锁”的双重持有竞态。自动 stale recovery 明确递延（deferred）到未来独立的 **Safe Lock Recovery phase**。
- **Lock release**：`releaseRunLock` 严格校验当前 `.run.lock` 的 `ownerId` 与当前 holder 的 `ownerId` 完全一致；任何 mismatch 或 malformed lock 绝不执行 unlink。

#### DECISION P — 非客观暂停原因不自动恢复（Control Plane MVP）
- 只有 Cindy 能够通过 Git 事实客观重新证明已经解决的问题，才允许自动 resume：
  - `DIRTY_TREE_UNEXPLAINED`：重新读取 Task scope 与 live Git status，当脏文件完全在 allowedScope 内或工作树 clean 时 controlled resume；
  - `GIT_SAFETY_STOP`：重新读取 Task 权威、分支、HEAD、upstreamRef、upstreamCommit 与 divergence，全部吻合时 controlled resume。
- 人工与主观原因一律不自动 resume：
  - `PRODUCT_DECISION_REQUIRED`
  - `CONTRACT_CONFLICT`
  - `MIGRATION_OR_SECURITY_AMBIGUITY`
  - `BLOCKED`
- 删除/禁用 `productDecisionApproved` 作为自动恢复凭据。HEAD 或工作树中存在任何未绑定布尔值均不可解锁上述状态。
- `resumeRun()` 遇到人工暂停原因时返回原 Run，保持 `state`、`stopReason` 与 `pausedFrom` 严格不变。

#### DECISION Q — taskAuthorityCommit 必填与权威模型收敛（Control Plane MVP）
- `taskAuthorityCommit` 在 `CindyRun`、`cindy-run.schema.json`、`BaselineArtifact`、`cindy-baseline.schema.json` 中均为必填（required）。
- 缺失该字段直接判定为 `RUN_GIT_SNAPSHOT_INCOMPLETE` 或 schema invalid，严禁自动 backfill 为当前 HEAD。
- （注：关于 `run.baseCommit` 与 `taskAuthorityCommit` 的等式关系，已被 DECISION X 分离修正）。

#### DECISION R — Git 路径统一采用 POSIX / Git 字面语义
- 仓库路径统一采用 forward slash `/` 作为分隔符。
- Git 返回路径中的反斜杠 `\` 严格视为文件名的一部分（POSIX literal character），绝不执行 `.replaceAll("\\", "/")`。
- Task scope entries 禁止包含反斜杠 `\`，包含即报 `INVALID_SCOPE_ENTRY`（`PathTraversalError`）。
- 作用域 `src/` 无法授权名为 `src\rogue.ts` 的单个字面文件名。

#### DECISION S — 移除通用导出的 Git 执行器
- `runGitReadOnly()` 撤销 export，变为内部受限私有函数 `runGitReadOnlyInternal()`。
- 外部调用者只能调用具体类型化事实 API（如 `getGitBranch()`、`getGitHead()`、`getGitStatus()`、`readCommittedTaskPacket()`、`getTaskAuthorityCommit()` 等），禁止外部构造任意 argv。

#### DECISION T — 严格 Task ID 校验与 Packet 身份强绑定
- 统一 `validateTaskId()` 校验：必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`，显式禁止 `.`、`..`、`/`、`\`、空白符、控制符。
- Committed Task Packet 必须显式包含 `taskId`，且 `packet.taskId === requested taskId`，禁止缺失或不匹配。

#### DECISION U — 封闭 Run 原始创建路径
- 移除公开的原始 `createInitialRun()`。
- `RuntimeArtifactStore` 仅暴露 `initializeRunSafely()`，内部持有 `.init.lock` 并执行完整的闭环检查（Closure、Task 权威、Git 事实、HEAD 等式、作用域所有权、唯一 Active Run）。

#### DECISION V — 初始化锁故障安全与唯一 ownerId
- `.init.lock` 采用 candidate-file + atomic link 模式串行化所有初始化操作。
- 元数据包含密码学唯一 `ownerId`（UUID v4）；释放时严格核对 ownerId，禁止误删。
- 候选文件写入、同步、校验失败时仅清理自身候选，不触碰正式主锁；confirmed stale 锁只检测不自动回收。

#### DECISION W — 完整权威模型定义
- 废弃以 `task.json.baseCommit` 为唯一权威或“所有暂停状态皆可自动恢复”的旧文档表述。
- 恢复与初始化的唯一根基为 Git history 派生的 `taskAuthorityCommit` 与唯一活跃 Run。

#### DECISION X — Task Authority 与 Task Baseline 语义分离
- **历史真实状态**：真实任务的 declared baseline（`taskPacket.baseCommit`）通常早于其 Task Packet 最终提交的 `taskAuthorityCommit`。严禁修改已提交 Task 数据迎合代码。
- **两组独立等式**：
  - **Equation A（Live Task Authority）**：
    `actual HEAD == run.taskAuthorityCommit == run.headCommit == currentTask.taskAuthorityCommit`
    在 MVP 阶段不允许运行态生命周期内 HEAD 前进或 Task Packet 漂移。
  - **Equation B（Declared Task Baseline）**：
    `run.baseCommit == currentTask.baseCommit`
    额外通过 `isGitAncestor(taskBase, taskAuthorityCommit)` 确保声明的历史 baseline 确实位于权威 commit 的祖先历史中（或等于它）。`run.baseCommit` 绝不强制要求等于 `taskAuthorityCommit`。

#### DECISION Y — Store 不是公开 Workflow State Machine
- `RuntimeArtifactStore` 的职责严格限制为：持久化、CAS、锁、工件边界校验与底层 I/O。
- 从公开/deep-import 可调用界面彻底移除直接推动业务状态的低层 capability：`advanceToReadyForReview()`、`advanceToReviewing()`、`advanceToRepairInitialized()`、`recordReviewPassRecorded()` 等。
- 业务状态推进必须仅通过高层、语义明确的 Orchestrator 操作（如 `prepareForReview`、`startReview`、`recordValidatedReviewResult` 等）。

#### DECISION Z — 每次状态写入重新校验 Live Authority
- 状态安全检查绝不仅发生在 init/reconcile/resume；每一次修改 `run.state` 前，统一在内部原子 mutation 边界（`withAuthorizedRunMutation`）重新读取并严格校验：
  1. 获取 per-run lock；
  2. 重新读取磁盘上最新的 fresh run；
  3. 校验 run schema 与工件边界；
  4. 校验该 run 是当前任务唯一的活跃 Run；
  5. 读取 HEAD committed Task Packet；
  6. 重新派生 `taskAuthorityCommit`；
  7. 校验 Live Task Authority（Equation A）；
  8. 校验 Declared Task Baseline 与祖先关系（Equation B）；
  9. 校验分支一致性；
  10. 校验 upstreamRef；
  11. 校验 upstreamCommit；
  12. 校验 ahead / behind / diverged 安全性；
  13. 检查真实 dirty tree 文件；
  14. 校验 dirty tree 严格处于 HEAD committed Task Packet 的 allowedScope 内；
  15. 校验具体操作前置条件、递增版本号；
  16. 执行原子写与 CAS 回写。

#### DECISION AA — 证据信任分类（Evidence Trust Classification）
- 工件增加信任标记 `trustClassification`:
  - `STRUCTURE_VALID_EXTERNAL`：STRUCTURE_VALID_EXTERNAL 表示该工件由外部执行者产生，Cindy 在受控 Typed Writer 的原子写入边界内重新验证了 Schema、run/task/cycle 身份、当前状态以及该工件所要求的 Git / tree / diff / reviewer-session 等绑定，并以不可变形式持久化。该分类不表示 Cindy 自己执行了测试、Review 或外部命令，不证明外部执行过程真实发生，也不等价于 TRUSTED_EXECUTOR / PROCESS_ATTESTED / GATE_PASS；
  - `UNVERIFIED_EXTERNAL`：通过普通/未受信的通用 `recordArtifact` 写入的数据。
- 通用 `recordArtifact` 即使传入 `authoritative: true` 也必须拒绝；只有绑定当前 active run、cycle、HEAD authority、工作树与对应 reviewer session 的受控类型化写入可产生 `STRUCTURE_VALID_EXTERNAL`。这仅表示结构及绑定有效，不表示 Cindy 自己执行了测试或证明了外部报告真实性。
- 只有标记为 `STRUCTURE_VALID_EXTERNAL` 的证据工件才能被状态迁移消费并推动执行流（例如 `prepareForReview`、`recordValidatedReviewResult`、`consumeReviewPass`）；状态写入边界还须独立复查相应证据和 live authority，不能只信任调用者传入的 operation 名称。在 Control Plane MVP 中，Review PASS 仅记录不可变证据，状态继续保持 `REVIEWING`，不向 `FINAL_GATE` 推进。

#### DECISION AB — Packet 身份强一致性与前置路径校验
- `readCommittedTaskPacket()` 严格要求 `data.taskId` 为 string 且完全等于请求的 `taskId`，彻底移除旧的 `data.task` fallback。
- `getTaskAuthorityCommit(taskId)` 与 `importLegacyTask(taskId)` 入口第一步必须执行 `validateTaskId(taskId)`，任何路径拼接或 Git 查询前必须确保 task ID 合法安全。

#### DECISION AC — current.json 真正 Hint-Only
- `.agent/current.json` 发生解析错误、陈旧 runId、错误 taskId 或错误 status 时，绝不能否决已经通过 Git 事实与活跃 Run 独立确定的 authority target。
- 规则 A：显式 `reconcile(taskId=T)` → 权威目标为 T，pointer 无权干预。
- 规则 B：无显式 taskId 但存在唯一活跃 run T → 权威目标为 T，pointer 无权干预。
- 规则 C：0 个活跃 run 且无显式 taskId → 返回 `CURRENT_TASK_UNRESOLVED`，即使 pointer 指向某一 task。
- 规则 D：多于 1 个活跃 run → 返回 `AMBIGUOUS_ACTIVE_RUN`，pointer 绝不能用于消歧。
- pointerHealth 仅作为诊断信息返回（`OK`、`MISSING`、`STALE`、`CORRUPT`、`MISMATCH`），不污染已独立解析成功的权威结果；`pointer.status` 永远不能覆盖 `run.state`。

#### DECISION AD — 无虚假信任声明（No False Trust Claim）与 Phase 0/MVP 边界
- **外部观察信任边界**：Control Plane MVP 本身并不执行测试或生成只读 Review，所记录的工件均为**外部观察记录（external observations）**。Cindy 执行 schema validation 与 Git 事实/工作树绑定校验，但明确不提供密码学证明或不可伪造的进程级 attestation。
- **Gate Executor 递延**：可信的独立 Gate 执行器（Trusted Gate Execution）明确递延至 Phase 2 Gate Automation。Control Plane MVP 不增加伪造的执行器，特权状态保持安全密封（Fail Closed）。

#### DECISION AW — 通用 Bound Writer 不得写入状态驱动工件（Generic Bound Writer Forbidden for State-Driving Evidence）
- 从 `RuntimeArtifactStore` 公开界面物理移除 `recordBoundEvidence()`。
- 任何被 workflow state machine 消费的状态驱动工件（`TEST_RESULT`, `DIFF_MANIFEST`, `REVIEW_REQUEST`, `REVIEW_RESULT`）均禁止通过公开通用接口写入并赋予 `STRUCTURE_VALID_EXTERNAL` 分类。
- 底层受限写入能力通过模块私有能力传递模式（Module-Private Capability Pattern via static initialization block）仅由 `CindyOrchestrator` 专用类型化方法调用。

#### DECISION AX — 类型化证据写入器不等于受信任执行器（Typed Evidence Writer ≠ Trusted Executor）
- 类型化写入接口仅用于记录外部观察结果并强制校验 schema、身份与工作树绑定。
- 标记维持 `STRUCTURE_VALID_EXTERNAL`，不发明虚假的 `TRUSTED_EXECUTOR` 等分类，保持 Phase 0 边界。

#### DECISION AY — 派生安全暂停禁止走行政暂停接口（Derived Safety Stop Forbidden in Administrative Transitions）
- `applyAdministrativeTransition()` 的目标严格限定为审批的人工暂停状态（`BLOCKED`, `PRODUCT_DECISION_REQUIRED`, `CONTRACT_CONFLICT`, `MIGRATION_OR_SECURITY_AMBIGUITY`）。
- `GIT_SAFETY_STOP` 与 `DIRTY_TREE_UNEXPLAINED` 彻底从行政迁移目标集中移除；在健康代码库中，任何 deep-import caller 均无法直接触发或伪造派生安全暂停。
- 派生安全暂停只能由系统在 mutation boundary 重新评估 live Git/Task authority 与未解释 dirty tree 后内部派生。

#### DECISION AZ — Run 锁只能锁已注册的有效 Run（Run Lock Strictly Preflighted on Registered Valid Run）
- `acquireRunLock(runDir)` 在创建 `.run.lock` 之前必须严格预检：目录存在、`run.json` 存在、JSON 解析合法、符合 run schema、且 `run.runId` 与目标 runId 完全匹配。
- 孤儿目录、破损/空/非法 schema 或 runId 不匹配的目录严格拒绝建锁，避免非受信/未注册目录被锁住。

#### DECISION BA — 原周期 Review 重放内容冲突 Fail-Closed（Original Cycle Review Replay Content Conflict Fail-Closed）
- 当 Review FAIL 推进 `currentCycle` 后，若收到针对原 cycle 的重复提交，必须读取原 cycle 已落盘的 `review-result-cycle-<cycle>.json` 进行规范化 JSON 比对。
- 仅在内容严格一致时允许幂等重放；一旦发现 findings、summary、verdict 或其他字段存在差异，必须抛出 `ConflictingArtifactError` 严格拒绝，防止历史 Review 结果被静默篡改或作为重放成功掩盖。

#### DECISION BB — 通用 recordArtifact 权限严格封闭（Generic recordArtifact Authority Boundary Sealed）
- 公开的 `recordArtifact()` 严格禁止传入 `authoritative: true` 或 `trustClassification: STRUCTURE_VALID_EXTERNAL`。
- 所有非类型化写入仅能记录为 `UNVERIFIED_EXTERNAL` 诊断工件，状态机绝不消费。

#### DECISION BI — 状态驱动工件持锁二次校验（Double-Checked Typed Evidence Write Boundary）
- 类型化证据写入器（`recordTestResult`, `recordDiffManifest`, `recordReviewRequest`, `recordReviewResult`）实行双阶段原子写入：
  1. 第一阶段保持外层 preflight，用于快速错误反馈并降低不必要的锁竞争；
  2. 第二阶段在取得 `run lock` 后，在写入磁盘前必须重新读取磁盘 `run.json`，验证 `lockedRun.version` 与预期版本严格一致，验证当前 state 与 cycle，重新评估 live Git authority（HEAD、Task authority、upstream、clean/scope）、重新计算 working tree / diff digest，并复验相应的前置绑定工件；
  3. 只有锁内二次复检全部通过，才生成 `STRUCTURE_VALID_EXTERNAL` 并原子写盘；若发生并发版本漂移、状态变更、HEAD/Task/upstream 漂移或工作树篡改，必须在锁内抛出异常拒绝写盘，释放锁并确保磁盘无残留临时工件。

#### DECISION BJ — 运行与基线原子捆绑发布（Atomic Initial Bundle Publication via Staging Directory）
- `initializeRunSafely` 不得在最终 `runtime/<runId>/` 目录下逐个写入 `run.json` 与 `baseline.json`，以避免崩溃留下缺失 baseline 的半初始化活跃 run；
- 初始化全量工件先在同文件系统保留目录 `.agent/.cindy-init-staging/<runId>.<uuid>/` 内完整写入并完成 cross-binding / schema 验证与 fsync；
- 验证通过后，在目标路径 `runtime/<runId>` 确认不存在的前提下，通过单次原子目录重命名（`rename(stagingDir, finalRunDir)`）将整个初始化 bundle 一次性发布至 active scanner 可见目录；
- 若目标目录已存在，立即 fail-closed 抛出 `ConflictingArtifactError`，严禁覆盖或合并；
- `.agent/.cindy-init-staging/` 严格被 active run scanner 忽略，不占活跃 run 配额，不产生 `INVALID_RUN_RECORD`。

#### DECISION BK — 双扫描与元数据版本围栏（Double Scan and Post-Read Identity/Freshness Fence）
- `initializeRunSafely` 与 `executeSemanticTransition` 均引入快照元数据身份记录与后置围栏：
  1. 在读取内容时捕获每个合法输入的物理文件系统身份（`dev`, `ino`, `size`, `mtimeMs`, `ctimeMs`, `mode`, `target`）；
  2. 采用双扫描基线，第一次扫描与第二次扫描计算之 tree digest 必须完全一致；
  3. 扫描完成后立即执行早期元数据一致性校验（Early Identity Fence），检出在读取过程中发生的并发文件修改、重命名或类型漂移；
  4. 在完成所有 staging 写入、fsync 并通过最终 Git authority fence 之后、执行原子发布（`renameSync`）之前，执行最终元数据新鲜度印章（Final Freshness Seal），检出可观察的文件版本与元数据漂移。
- **边界说明**：元数据一致性属于运行期防御性启发式校验，不声称密码学不可伪造性；根据既有冻结的 Decision B 威胁模型，系统不承诺防御同 UID 恶意进程在系统调用之间发动的主动 TOCTOU 竞态。

#### DECISION BL — 语义状态迁移零 Await 发布顺序（Semantic Publication Zero-Await Execution Order）
- 语义迁移遵循规范化阶段顺序：
  `SNAPSHOT_VALIDATION` → `STAGE1_WRITE_AND_FSYNC` → `EARLY_IDENTITY_FENCE` → `FINAL_GIT_AUTHORITY` → `FINAL_FRESHNESS_SEAL` → `ATOMIC_RENAME`；
- 所有 staging 文件的写入与 `FileHandle.sync()` 必须在最终 Git authority fence 之前完成；
- 最终 Git authority fence 与 final freshness seal 通过后，紧接着直接调用同步 `renameSync()` 完成原子发布，消除普通 awaited 异步调度交错窗口；
- **物理限制**：最终 `renameSync` 系统调用边界与跨子系统同步系统调用之间的微秒级窗口，属于 Decision B 冻结威胁模型明确排除的同 UID 对抗竞态范围。

#### DECISION BM — FAIL 幂等重放全量事实独立核验（Strict Evidence & Live Authority Verification on FAIL Duplicate Replay）
- 当 `recordValidatedReviewResult` 针对处于 `REPAIR_INITIALIZED` 状态的 run 收到 FAIL 重放（即使调用者省略 `op.review`）：
  1. 绝不盲目信任磁盘已有的 `REVIEW_RESULT`；
  2. 必须读取磁盘已有的 `review-result-cycle-<cycle>.json`，严格核验其 `verdict === "FAIL"`、`runId`、`taskId`、`cycle`、`trustClassification === "STRUCTURE_VALID_EXTERNAL"`；
  3. 核验其 `reviewedBaseCommit` 与 `run.baseCommit` 一致，`reviewedTreeDigest` 与 `run.boundTreeDigest` 一致，`reviewedDiffDigest` 与 `run.diffDigest` 一致；
  4. 核验当前周期绑定的 `REVIEW_REQUEST` 存在且 reviewer 身份、session 与 read-only 要求与评审工件完全吻合；
  5. 重新计算当前 live working tree digest 与元数据身份围栏，要求工作树处于完全一致且未篡改的快照绑定状态；
  6. 执行最终 Git authority 校验，若任何一项不满足，立即拒绝并抛出异常，保持当前 run 版本与状态完好无损。
