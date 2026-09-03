# ADR-005：产品 Task 生命周期与项目树权威

- 状态：Accepted
- 日期：2026-09-04
- 关联：CR-003、ADR-003、P0-05A

## 决定

- Product Task 是唯一业务 Task 聚合；Huly Issue 仅为可选外部投影。
- Task 分别保存 `executionState` 与 `reviewState`，公开 `lifecycleState` 由两者推导，不保存第三份可漂移状态。
- 必验任务只能按 `todo → in_progress → pending_review → completed` 前进。退回和撤回回到可再次提交的进行中语义，每次动作追加 ReviewCycle；非必验任务才允许直接完成。
- 外部协作工具的 Done 不得绕过产品验收。外部变化必须转译为带期望版本的产品命令。
- 项目树只写 `ProjectNode.parentId`。Relation 只允许 `predecessor` 和 `related`；图中的 `parent_child` 边从 Node 派生。
- Node 移动必须校验项目、层级 revision、单父和祖先环，并以乐观版本冲突拒绝并发覆盖。

## 验收

- Huly 不可用时，产品 Task 仍可完成全部业务状态转换。
- 必验 Task 无法直接完成；退回、撤回、再次提交和验收动作均保留历史。
- 任何写入口都不能持久化 `parent-child` Relation。
- Graph、列表和时间轴对父节点的回答均来自 `parentId`。

