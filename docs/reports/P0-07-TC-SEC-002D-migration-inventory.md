# P0-07 / TC-SEC-002D 非空子树迁移清单快照

- 日期：2026-09-09
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-002A/B/C、ARCH-GATE-SECURITY-001/002

## 本切片交付

- 新增只读 `SecurityMigrationInventoryReader`，以 tenant、project、root、source domain/epoch 构建 Node/Task/Asset 迁移清单。
- 项目树只由 `ProjectNode.parentId` 计算；先读取 tenant-wide Node 并拒绝所有触及目标项目的 missing/cross-project parent，再计算项目内完整闭包。
- Task/Asset 使用迁移专用 tenant-wide 只读端口，避免 project 或 owner 列漂移把对象排除在清单外；SQLite 同时验证 row/JSON 的 tenant/id/project/owner/lifecycle/version。
- inventory 包含根、全部后代及其直接拥有的 Task/Asset，包括软删除对象；项目外对象不混入。
- 项目内 owner、source domain/epoch、嵌套正式域与树完整性均在构造结果前验证；任一异常整体返回同一 fail-closed 错误，不产生 partial result。
- 结果按 ownerNodeId、固定 kind rank、id 的 code-point tuple 排序；每项 cursor 是该 tuple 的无歧义 JSON 表示，Memory/SQLite 与重启结果一致。
- 未创建或推进 Migration，未改对象安全归属，未新增事件、Outbox、Job、API/UI 或 Schema。

## 自动验收证据

- Memory/SQLite 对多层非空子树生成相同 7 项清单；非连续 ID、软删除 Node/Task/Asset、项目外对象过滤、重复读取与 SQLite 重启一致性通过。
- missing root 与只有根的空子树分别验证整体拒绝和单项清单。
- source domain、source epoch、嵌套正式域、跨项目 Task owner 与跨项目 Node parent 入边均在 Memory/SQLite fail-closed。
- 原生 SQLite 依次制造 broken parent、Task row/JSON drift、Asset row/JSON drift 与 parent cycle；每次构建均整体拒绝。
- 独立安全 Review 首轮发现项目过滤会漏掉 other-project Node 指向迁移根的权威 parentId 入边；改为 tenant-wide Node 边界检查并补双 adapter 回归后复审 PASS。
- 定向 27/27 测试通过。
- `pnpm check`：TypeScript、125/125 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 与高置信凭据/私钥特征扫描通过。

## 剩余项

- cursor 当前是可读但由调用者视为 opaque 的 JSON tuple；具体批次 lease/resume 规则留给 worker 子片。
- 迁移创建授权、对象专用换域、批次原子 checkpoint、事件/Outbox、索引/投影验证与提交/回滚编排尚未完成。
- 嵌套域迁移、节点移动与 U2/U7/U8 不在本片范围。

本片只交付迁移 inventory 快照，不宣称完成非空子树迁移或 P0-07。
