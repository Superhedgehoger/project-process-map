# CINDY-ORCH-MVP：开发闭环 Control Plane MVP

## Task Packet

- Task ID：CINDY-ORCH-MVP
- 类型：Repository Development Automation（非产品功能切片）
- Risk：R2（恢复权威、状态机、dirty-tree ownership、证据完整性）
- Base：`2d553b16eb80f4de64bf2fd07426a8bbb29b04e4`（main）
- 状态：READY
- 设计依据：`docs/development/cindy-orchestration.md`

## 目标

实现 Cindy 自动编排的第一阶段控制面，使后续产品 Task 能在可恢复、可审计且 fail-closed 的状态机上运行：

1. 统一新 run 的状态 schema 与合法迁移；
2. 从 Git branch/HEAD/upstream 和已提交 closure 工件 reconcile 陈旧 `.agent/current.json`；
3. 建立 dirty-tree ownership、scope manifest 和完整 working-tree digest；
4. 将运行时证据写入 ignored `.agent/runtime/<run-id>/`，避免 Test/Review 工件改变被证明的 tree；
5. 支持幂等 status/reconcile/init/record 操作及暂停原因，不开放自动 commit/push。

## 直接契约

- Git 和已提交 closure 是恢复权威；说明文档与 current pointer 冲突时不得重复执行已关闭任务。
- 旧 `.agent` 文件按 legacy read-only 导入；严格 schema 只约束新 run，不重写历史 FAIL。
- 未解释 dirty tree、base/upstream 漂移、未知状态迁移或 artifact digest 不一致必须 fail closed。
- runtime artifact 由 Orchestrator 从真实 Git/进程结果派生；Builder 编辑文件不得获得 PASS/CLOSED 权限。
- 危险 Git 操作不实现：禁止 reset/clean/stash/rebase/amend/force push/远端分支删除。
- Antigravity Desktop 只预留 Builder adapter contract；本切片不自动驱动 Desktop。

## Expected Scope

- `schemas/`：新 run、artifact、finding/stop-reason 的 JSON schema。
- `tools/`：orchestrator control plane、Git state/digest/dirty ownership 与 runtime artifact writer。
- `tests/`：状态迁移、陈旧 current reconcile、未知 dirty tree、untracked drift、digest、幂等恢复与 legacy import。
- `package.json`：仅增加本切片需要的 `cindy:*` 入口。
- `.gitignore`：保持 `.agent/runtime/` 不进入 reviewed/committed tree。
- 文档：仅同步真实实现的命令和恢复协议。

## Non-goals

- 自动调用 Builder、Antigravity Desktop 或 Codex Reviewer。
- 自动运行完整 Gate、生成 Repair、Closeout、commit、push 或 Next Task 选择。
- 修改任何产品领域、API、持久化 schema 或安全权限。
- 把 runtime evidence 加入 tracked tree。
- 迁移或重写既有 Task/Review 历史。

## Required Gates

- 新增 `tests/cindy-orchestrator.test.ts` 定向测试全部通过。
- `pnpm check` 全量通过。
- `git diff --check`、JSON/schema 校验与高置信凭据/私钥扫描通过。
- 工作树全部变更可由本 Packet scope 解释。
- 独立只读 Codex R2 Review PASS；Review 绑定最终 working-tree digest。

## Acceptance Criteria

- stale current pointer 可从 Git/closure 确定性调和，不重复关闭或提交历史 Task。
- tracked、staged、untracked、新增、删除、重命名任一变化都会改变 digest。
- 当前 run 之外的 dirty 文件稳定进入 `DIRTY_TREE_UNEXPLAINED`。
- 重复执行合法命令幂等；非法状态跳转无部分 artifact。
- runtime evidence 保持 ignored，写入后不改变 reviewed product tree。
- 不存在任何可触发 commit/push 或危险 Git 操作的代码路径。

## Next Action

在下一专用实现会话启动 Builder；完成独立 Gate 与 Codex R2 Review 后再规划 Gate Automation 阶段。`P0-05A-T2c` 保持 READY_QUEUED，不与本切片混改。
