# P0-07 / TC-SEC-002H 核心读取 API 的迁移期权限交集

- 日期：2026-09-10
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-001、TC-SEC-002A～G、TC-SEC-003A/B/C

## 本切片交付

- 新增逐对象、capability-aware 的迁移期授权：只使用同租户持久 Migration 与权威 Node.parentId / Task、Asset ownerNodeId 判定范围。
- active、verifying、retryable、recovery_required 中，当前对象必须精确处于持久计划的 source 或 target domain/epoch，并同时通过两端当前授权；source↔public 的 public 一侧仍要求 active 项目成员。
- Node collection/detail 与嵌套 Task/Asset 读取不再项目级冻结；无权对象按 404 或 collection 过滤处理，已迁与未迁对象行为一致。
- formal domain 缺失、删除、嵌套，迁移根缺失、删除、跨项目，祖先断链/环、跨项目父边、重叠命中多个迁移均 fail-closed；范围外对象沿用当前域授权。
- 写路径仍由 `assertProjectSecurityStable` 冻结。Task 创建/动作、Asset 附加、Node 创建、SecurityRoot 与 Grant 管理在冻结前使用 capability-aware 双域授权，避免 404/409 随对象换域翻转形成迁移进度 oracle。
- 修复 CreateNode 顶层与 public parent 的提前返回，使所有结构创建分支在开放迁移期间冻结。

## 自动验收证据

- Memory/SQLite 固定身份矩阵覆盖 only-old、only-new、both、neither、撤销 principal、撤销 membership、过期/撤销 Grant，以及对象 source→target 后授权不变。
- active、verifying、retryable、recovery_required 均保持交集；source→public 与 public→target 均覆盖敏感侧授权和 active membership。
- Product API 证明 Node、Task、Asset 在 source/target 两侧均可由双域授权者读取；迁移端点不可判定时 detail/collection/write 均不泄露对象。
- capability-aware 写预授权证明 only-old/only-new 在对象换域前后均拒绝，both 才进入现有冻结守卫；顶层/public/sensitive Node 结构写均继续冻结。
- 独立安全 Review 经两轮 BLOCKER 修复后 PASS：关闭写错误码 oracle、非法迁移根误放行与 CreateNode 结构写绕过。
- 定向安全回归 57/57；最终 `pnpm check`：TypeScript、146/146 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 通过。
- 当前变更文件的凭据、API key 与私钥特征扫描无命中。

## 剩余项

- Blob 内容下载、搜索、通知、实时、ZIP/导出与外部协作投影尚未接入迁移交集，不得据此进入 committed。
- deleted migration root、全部写 Handler 的完整 HTTP only-old/only-new 矩阵仍可继续增强；当前实现已 fail-closed，属非阻塞测试深度风险。
- 当前逐对象检查为对象数×迁移数×树深的读取，规模化性能与时序侧信道需后续专门验证和优化，优化不得放宽 fail-closed 语义。
- 迁移创建、Job lease/retry、rollback/recovery、事件/Outbox、嵌套域、节点移动与 U2/U7/U8 不在本片范围。

本片只验收核心 Product API 的 Node/Task/Asset 元数据读取与写冻结边界，不宣称所有读取通道或 P0-07 已完成。
