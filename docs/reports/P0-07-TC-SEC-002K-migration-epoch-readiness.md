# P0-07 / TC-SEC-002K 安全域迁移的外部可见性收敛与全通道纪元就绪守卫

- 日期：2026-09-13
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-003、ADR-004、ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-001、TC-SEC-002A～J、TC-SEC-003A/B/C、ARCH-GATE-HULY-001/002、ARCH-GATE-RECOVERY-001

## 独立安全 Review 审计说明

- 独立 Review 执行者：全新 Antigravity 独立只读会话（Clean Read-Only Security Reviewer Context）。
- 基础设施故障说明：此前 Codex Reviewer 两次因 `app-server reconnect 120s` 基础设施超时故障中断，未产出审查结论；本地环境中 Claude CLI 未配置/不可用。
- 结论声明约束：严禁宣称 Claude 或 Codex PASS；所有安全验收结论、全覆盖闭合核查（A～G 项）及独立探针证据，均由 Antigravity 独立只读 Reviewer 独立复跑并核实确认。

## 本切片交付

1. **根除公共 Mint 与伪造接口**：
   - 彻底删除 `kBackendSecret`、`registerVerificationBackend` 以及公开构造器 `createSecurityMigrationCoordinator(Persistence)`。
   - 消除任何向进程内任意模块泄露凭据签发与伪造证据能力的旁路。
   - 采用窄纯函数类型 `VerifyMigrationReadiness`（输入仅为 `tenantId`、`migrationId`、`purpose`），在 `SqlitePersistence` 与 `MemoryPersistence` 内部私有闭包绑定，外部完全无法获取 `#issueReadinessChallenge` 与 `#recordVerifiedEvidence` 句柄。
2. **架构边界与 Composition Root 强隔离**：
   - 领域层（`packages/domain`）、应用层（`packages/application`）及 HTTP 路由层（`apps/product-api/src/routes/project.ts`）零 Adapter 符号/模块导入。
   - 仅允许在 Composition Root（`apps/product-api/src/server.ts`）调用 `createProductionSqliteBundle`，组装持久化与 `HulyRestCollaborationEpochReadinessAdapter`，并将窄纯函数 `verifyMigrationReadiness` 单向注入路由服务。
   - 架构门禁 `ARCH-GATE-BOUNDARY-001`（`tests/architecture-boundaries.test.ts`）严格拦截任何形式的 adapter 依赖或动态 import 规避。
3. **严格规范清单校验（Strict Canonical Manifest Validator）**：
   - `validateCanonicalManifestItem` 覆盖 node/task/asset 专有字段与禁用字段形状、类型、枚举、整数性、nullability 与外部引用结构（`provider`、`kind`、`externalId`、`schemaVersion`）。
   - `validateCanonicalSnapshotItems` 严格断言清单规范排序（`compareManifestItems`）、唯一性（禁止重复项）、itemCount 精确性、UTC 格式与 SHA-256 摘要双向一致性。
   - 在 `MemoryPersistence` 与 `SqlitePersistence` 的 `saveManifestSnapshot` 与 `getManifestSnapshot` 中无条件执行校验，全面防御 snapshot 篡改或伪造。
4. **Held Rollback 真实竞态与未决操作拦截**：
   - 覆盖外部 verifier hold 期间并发插入 in-scope unresolved integration operation（`retryable` 且 `attempts > 0`）或 fence 出现的真实竞态。
   - 事务提交前准确检测并阻断，fail-closed 抛出 `SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE`，迁移状态安全原子流转至 `recovery_required` 并记录审计日志，未发生任何部分换域或数据悬空。
5. **TOCTOU 实时清单双射比对与全绑定验证**：
   - 在 `commitWithReadinessEvidence` 与 `rollbackWithAudit` 终态事务内，重新采集实时 inventory 并与 manifest snapshot 逐字段双射核对，杜绝外部校验期间的对象漂移。
   - 严格全绑定校验：`provider === "huly"`、`purpose`、`nonce`、`scope`、`sourceSecurityDomainId`、`targetSecurityDomainId`、`sourceSecurityEpoch`、`targetSecurityEpoch`、`manifestDigest`、`itemCount`、时间窗口（`issuedAtUtc <= verifiedAtUtc <= nowUtc <= expiresAtUtc`）。
   - 严格遵循 ADR-004：绝不在持有本地数据库事务期间跨越外部 Huly 网络调用。
6. **并发原子性与存储演进**：
   - 双真实 WAL 连接并发 commit vs rollback 互斥终态竞态测试、进程重启恢复与写入边界故障注入测试均通过，保证零部分状态。
   - SQLite schema 升级至 v9（引入 `security_migration_manifest_snapshots` 与 `security_migration_readiness_evidence` 表及约束），并验证 v8 二进制严格拒绝降级读取。

## 自动验收证据

- **独立安全 Review 结论**：PASS（Verdict: PASS, Safe to acceptance/evidence/commit/push: YES）。
- **定向安全迁移收敛测试**：`node --experimental-strip-types --test tests/security-migration-convergence.test.ts`
  - 结果：**25 passed, 0 failed, 0 skipped** (耗时 1026ms)。
- **架构边界门禁**：`node --experimental-strip-types --test tests/architecture-boundaries.test.ts`
  - 结果：**4 passed, 0 failed, 0 skipped** (耗时 90ms)。
- **协作投影出站冻结测试**：`node --experimental-strip-types --test tests/collaboration-projection.test.ts`
  - 结果：**19 passed, 0 failed, 0 skipped** (耗时 857ms)。
- **Product API 测试**：`node --experimental-strip-types --test tests/product-api.test.ts`
  - 结果：**19 passed, 0 failed, 0 skipped** (耗时 355ms)。
- **安全授权测试**：`node --experimental-strip-types --test tests/security-grant.test.ts`
  - 结果：**19 passed, 0 failed, 0 skipped** (耗时 494ms)。
- **Task 升级与 Schema 兼容测试**：`node --experimental-strip-types --test tests/task-upgrade-compatibility.test.ts`
  - 结果：**5 passed, 0 failed, 0 skipped** (耗时 185ms)。
- **批迁移测试**：`node --experimental-strip-types --test tests/security-migration-batch.test.ts`
  - 结果：**7 passed, 0 failed, 0 skipped** (耗时 277ms)。
- **全量生产门禁 (`pnpm check`)**：
  - TypeScript `tsc --noEmit` 0 错误。
  - 全量自动化测试 **197 passed, 0 failed, 0 skipped** (耗时 2390ms)。
  - 14 个 Huly ARM64 镜像 lockfile 验证通过。
  - 4 个 Huly 插件包扩展锁定验证通过（upstream commit `ccefccd8d0361d3c8612d508071b777aa833826d`）。
- **独立安全探针（Production Bundle 伪造绕过）**：
  - 生产 persistence 实例不存在任何公开或可反射的 `#issueReadinessChallenge` / `#recordVerifiedEvidence` / `attachTestHarness`。
  - 尝试调用 `commitWithReadinessEvidence` 提交伪造 evidenceId 被严格阻断，返回 `SECURITY_MIGRATION_EVIDENCE_NOT_FOUND`。
- **Git 格式规范与安全扫描**：
  - `git diff --check` 0 告警，代码无冲突与空白格式问题。
  - 全量源码与 diff 凭据/私钥扫描无命中。

## 残余风险与说明

1. **生产 Huly 迁移收敛保持 Fail-Closed Unsupported**：
   - 当前上游 Huly 生产 REST API 不支持感知产品安全纪元（`securityEpoch`）及细粒度安全域 ACL。
   - `HulyRestCollaborationEpochReadinessAdapter` 遵循 ADR-003/006，对真实 Huly 探测明确返回 `converged: false` 与 `HULY_EPOCH_CONVERGENCE_UNSUPPORTED`，决不把对象存在误认作收敛，确保生产环境 fail-closed。
   - 本次提交与验收绝不宣称 Huly 物理端已完成 ACL 收敛，仅声明产品侧的全通道就绪验证与受控状态机守卫已完备。
2. **P0-07 总项状态**：
   - 本切片仅验收迁移外部可见性收敛与纪元就绪守卫（TC-SEC-002K），P0-07 敏感 ACL 总项仍保持进行中（待推进固定身份扩展 U2/U7/U8 及嵌套安全域）。
