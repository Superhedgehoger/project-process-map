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

### 2.1 恢复权威

恢复时按以下顺序核对，而不是盲信可编辑状态文件：

1. Git 当前 branch、HEAD、upstream 与 clean/dirty 状态；
2. 已提交 Task / Repair / Review closure 工件；
3. `.agent/current.json` 可重建指针；
4. handoff、phase status 等说明性文档。

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

工件只能记录 Orchestrator 从真实进程和 Git 对象派生的结果，不能因 Builder 编辑 JSON 就获得 PASS、CLOSED 或 push 权限。最终产品 commit 必须逐字节匹配 Reviewer 已冻结的 product tree；runtime evidence 不属于该 tree。

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

## 8. 分阶段落地

1. **Control Plane MVP**：状态 schema、legacy reconcile、dirty-tree guard、artifact writer、幂等恢复。
2. **Gate Automation**：真实命令执行、tree/log digest、凭据扫描与 required-gates 校验。
3. **Review / Repair Loop**：只读 Reviewer adapter、结构化 findings、自动 Repair packet、循环熔断。
4. **Safe Closeout**：Final Gate、closeout、普通 commit、fetch/fast-forward push、git receipt。
5. **Next Task**：结构化 backlog 与唯一 Ready Task 选择。
6. **Desktop Adapter**：最后接入 Antigravity Desktop；无法可靠判断完成时停在 `READY_FOR_BUILDER`，不得伪造执行结果。

首个自动化实现切片应只交付第 1 阶段，不与 `P0-05A-T2c` 产品代码混合；自动化自身也必须经过独立 Review 后，才逐步开放 commit/push 权限。
