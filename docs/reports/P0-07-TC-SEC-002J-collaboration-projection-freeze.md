# P0-07 / TC-SEC-002J 外部协作投影的迁移期出站冻结

- 日期：2026-09-11
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-003、ADR-004、ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-001、TC-SEC-002A～I、TC-SEC-003A/B/C、ARCH-GATE-HULY-001/002、ARCH-GATE-RECOVERY-001

## 本切片交付

- 在外部 Huly 协作调用与本地操作准备前，在同租户当前产品状态上权威判定 Task/Asset 的 project、ownerNodeId、securityDomainId、securityEpoch 与开放 Migration。
- 迁移范围预检覆盖完整祖先链（从 ownerNodeId 遍历至 domain.rootNodeId），严格校验 `securityDomainId === formalRoot.securityDomainId` 且 `securityEpoch === formalRoot.securityEpoch`；任何 public-middle、foreign-domain-middle、epoch 漂移或缺失根均 fail-closed。
- 对 active/verifying/retryable/recovery_required 范围内的 Task 与 Asset，外部 Huly Issue、Blob、Attachment 创建与附加零调用；安全冻结作为可恢复 defer 处理，不消耗失败预算、不递增 provider attempt、不进入 dead letter。
- 引入有界租约出站投影 fence（`outbound_projection_fences`）与非阻塞周期续期；获取 fence 使用强随机 UUID generation token，未过期 fence 拒绝并发重获，已过期 fence 仅能通过 CAS 原子取代。
- `IntegrationOperation` 绑定 leaseToken，并发重试与状态流转均由 generation token 拥有；过期旧 Worker 无法覆盖或释放新代次 fence 与操作。
- 关闭 SQLite state-prefilter 绕过：全租户 `integration_operations` 在跳过前先完成 `operation_json` 解析、枚举值校验与全部关系列/JSON 副本字段交叉比对；任何解析失败、非法枚举、字段漂移均 fail-closed 拦截 `planned -> active` 迁移激活。
- 只有在数据一致性验证通过后，方可跳过一致 terminal 的 completed/compensated 操作或已知非协作操作；跨项目合法 Task/Asset 操作正常放行不阻断无关项目迁移。
- 严格遵循 ADR-004：绝不在持有本地数据库事务期间跨越外部 Huly 或网络调用。

## 自动验收证据

- 独立安全 Review 最终结论：PASS，无残留严重性发现。
- SQLite state-prefilter 绕过彻底修复：全租户操作在跳过前完整校验枚举与全部 7 个安全复制列；`relational completed + JSON retryable` 等既有复现路径现一致返回 `SECURITY_MIGRATION_OUTBOUND_FENCE_ACTIVE` 并拒绝激活。
- 独立定向测试：`tests/collaboration-projection.test.ts` 19/19 PASS（包含 13 组直接状态/枚举/字段漂移断言与两连接 SQLite 并发竞态验证）。
- 既有 `TC-SEC-002I` 本地 Asset 下载交集测试全量保持并通过（18/18 PASS）。
- Antigravity 完整 `pnpm check` 验证通过：
  - TypeScript `tsc --noEmit` 0 错误（严格 `exactOptionalPropertyTypes`）。
  - 全量自动化测试 169/169 PASS（0 fail, 0 skipped）。
  - Huly 镜像锁定验证：14 个 ARM64 镜像 lockfile 验证通过。
  - Huly 扩展验证：4 个插件包上游 commit `ccefccd8d0361d3c8612d508071b777aa833826d` 验证通过。
- `git diff --check` 干净无空白或格式告警。
- 源码、配置与测试中无任何凭据、API key 或私钥特征命中。

## 剩余项与风险说明

- 冻结前已向 Huly 投影的历史 Issue/Attachment/Blob 副本仍需后续端到端收敛方案或 Huly 端映射；本切片仅关闭迁移期间的新出站投影通道，Migration 严禁进入 committed。
- SQLite 迁移激活检查采用租户范围扫描，当前数据规模下执行耗时低于 1ms；未来超大租户历史操作归档可评估冷热数据索引，非当前验收阻断项。
- 搜索、通知、实时、导出通道与完整纪元收敛仍待后续切片推进。

本片仅验收外部协作投影在安全迁移期间的出站冻结与持久 fence 保护，不宣称外部可见性已完全收敛或 P0-07 总项已完成。
