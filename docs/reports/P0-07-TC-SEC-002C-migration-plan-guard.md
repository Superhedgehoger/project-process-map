# P0-07 / TC-SEC-002C 安全域迁移计划与进度保存守卫

- 日期：2026-09-09
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-004、ADR-006
- 前置依据：ARCH-GATE-SECURITY-001/002、TC-SEC-002A/B、TC-SEC-003A/B/C

## 本切片交付

- 移除 `SecurityDomainMigrationRepository.update`，改为带显式 migration ID 的 `saveProgressPreservingPlan`。
- Memory/SQLite 均锁定迁移 tenant、id、project、root、source/target domain、source/target epoch、hierarchy revision、total、deadline 与 created time；进度保存不得改写已批准计划。
- 新增领域进度保存验证：proposal 必须逐字段等于由 current 重建出的合法状态转换或 active checkpoint，不能直接跳到 committed、倒退/越过 total 或夹带其他字段变化。
- SQLite 的 get/save/listRecoverable 统一验证 row 与 JSON 的全部重复字段；读取漂移数据即 fail-closed，不能向 ACL 交付伪造的 terminal 状态，也不能借保存静默修复。
- 保留 ADR-006 active/verifying/retryable/recovery_required 的旧域∩新域语义；未实现迁移创建、批次执行、API/UI、cursor 枚举或 Schema 变化。

## 自动验收证据

- Memory/SQLite 对全部身份与计划字段篡改稳定拒绝；事务 callback 捕获每次错误后，记录仍与原计划完全一致。
- 合法 active checkpoint 与 active→verifying 保存通过；direct active→committed、progress 倒退、超过 total、伪造 failure 均在写入前失败，旧域∩新域保持不变。
- SQLite 两连接竞争同一 checkpoint 恰好一成一败；重启后 cursor/version 与完整迁移计划一致。
- 原生 SQLite 制造 project、root、state 与 version 四类 row/JSON 漂移后，重启的 get/save/listRecoverable 全部 fail-closed，底层漂移证据保持原样。
- 独立安全 Review 首轮发现完整对象可绕过状态机、读取路径未验证漂移；加入领域重建验证与统一 SQLite 解码器后复审 PASS，无剩余阻断项。
- 定向 15/15 测试通过。
- `pnpm check`：TypeScript、122/122 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 与高置信凭据/私钥特征扫描通过。

## 范围说明与剩余项

- 为让 adapter 复用单一领域规则，本片直接修改 `security-migration.ts`；错误码同步进入应用错误映射。这两处是阻断修复的直接依赖，不引入新产品入口。
- cursor 仍是不透明字符串；本片用 migratedItems 保证单调且不越界，具体枚举与排序策略留给迁移 worker 子片。
- 迁移创建授权、子树快照、Node/Task/Asset 批次换域、索引/投影验证、提交/回滚编排与全读取通道 ACL 尚未完成。

本片只建立迁移控制记录的可信持久边界，不宣称完成 TC-SEC-002 或 P0-07。
