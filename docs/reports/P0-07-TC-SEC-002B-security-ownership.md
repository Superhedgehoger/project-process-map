# P0-07 / TC-SEC-002B Task/Asset 安全归属不可变守卫

- 日期：2026-09-09
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 产品依据：PRD V1.3、FC-013、TC-SEC-001/002
- 架构依据：ADR-003、ADR-004、ADR-006、ADR-007

## 本切片交付

- 删除普通 Task/Asset 持久端口的通用 `update`，改为语义明确的 `savePreservingSecurityOwnership`；后续 ADR-006 迁移必须新增专用端口。
- Memory/SQLite 均以显式资源 ID 定位既有对象，并在写入前执行 CAS 与安全归属不可变校验。
- Task 的 tenant、id、project、owner node、security domain、security epoch 不可由普通保存改写；Asset 额外保护 uploader。
- SQLite 普通保存不再更新 project/owner 关系列，并在写入前验证 row 与 JSON 的 tenant/id/project/owner/version 一致；既有漂移 fail-closed，不借普通保存静默修复。
- 保持 Task 生命周期、验收/改派与 Asset 生命周期调用经受限端口工作；未新增 Schema、API/UI、迁移 Job 或 cursor。
- Task/Asset 当前领域模型均无 `createdAtUtc`；Task Packet 已纠正为当前真实模型范围，没有凭空扩展产品字段。

## 自动验收证据

- Memory/SQLite 均拒绝 public→sensitive、sensitive→public、Domain A→B、epoch、owner node、project、tenant、id 改写；Asset 同时拒绝 uploader 改写。
- 篡改错误在事务 callback 内被捕获后继续执行，最终提交仍不留下部分写。
- Task 与 Asset 的合法生命周期保存、stale CAS、SQLite 双连接并发 CAS 与重启恢复均通过。
- 原生 SQLite 制造 Task JSON project 漂移和 Asset relational owner 漂移后，普通保存稳定拒绝且不静默修复。
- TC-SEC-002A 敏感后代继承、Task review/改派与 Asset ingest 回归通过。
- 独立安全 Review 首轮发现 Task Packet 的不存在字段及 SQLite row/JSON 漂移检查缺口；纠正 Packet、加入一致性守卫和回归测试后复审 PASS，无剩余阻断项。
- `pnpm check`：TypeScript、118/118 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- 定向 32/32 测试、`git diff --check` 与高置信凭据/私钥特征扫描通过。

## 明确未完成

- 既有节点/非空子树换域及 ADR-006 批次迁移。
- 嵌套 SecurityDomain、Node Owner、organization/system_admin、Emergency Access。
- 节点移动、API/UI 与其他全通道 ACL。

本片只关闭普通 Task/Asset 生命周期持久化改写安全归属的旁路，不宣称完成整个 TC-SEC-002 或 P0-07。
