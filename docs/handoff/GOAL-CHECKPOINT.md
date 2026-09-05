# Goal Handoff Checkpoint — project-process-map

## 当前恢复状态（2026-09-05，优先于下方历史暂停记录）

- 状态：GOAL_RUNNING
- Goal threadId：`01a06f07-6235-7a43-b22d-fc042cf0f6aa`
- Branch：`main`
- 已验收实现提交：`ca94b6e`（`feat: guard security grant mutations`）
- upstream：`origin/main` 已包含 `ca94b6e` 与 checkpoint 提交 `44a5957`。
- 工作区：TC-SEC-003A 已验收、提交并推送；当前仅下一 Task Packet 与本 checkpoint 更新未提交。
- 当前 Gate：P0-07 敏感 ACL（总项继续进行中）
- 最近完成：P0-07 / TC-SEC-003A Grant 写模型、授权审计与最后管理员原子守卫
- 验收：独立安全复核最终 PASS；定向安全测试 19/19；`pnpm check` 94/94；14 个 Huly 镜像锁；薄宿主边界；`git diff --check`；凭据/私钥特征扫描均通过。
- 当前 Task：P0-07 / TC-SEC-003B Grant API 与固定身份无泄漏矩阵
- Task Packet：`docs/agent-tasks/P0-07-TC-SEC-003B.md`
- Blocker：无
- next_action：按 Task Packet 增加薄 Grant action API、严格 contracts/canonical client 与 U0～U9 诚实覆盖矩阵；完成 HTTP 并发、无泄漏、完整检查、独立 Review、Evidence、commit/push 后进入下一 Ready Task。

旧会话 `e8e244ee-0c02-4769-8bd0-37f1ca8bd485` 仅是该 Git 工作树所在目录，不得作为聊天执行上下文恢复。原绑定的“project-process-map Goal 恢复”和“用量恢复后继续任务”自动任务已于 2026-09-05 暂停；后续不得把本 Goal 的恢复投递到该旧会话。

---

## 历史暂停记录（已失效，仅保留审计）

- 生成时间：2026-09-04
- 状态：PAUSED_WAITING_FOR_QUOTA
- 暂停原因：Codex 5 小时使用限额
- 预计恢复：2026-09-05 00:10
- 建议重试：2026-09-05 00:15
- Goal threadId：01a06cba-9ba2-7ca0-ab71-a78bf2ea1499

## Git 状态

- Branch: main
- HEAD: 5f9017447b9728b6ab6d3a810a743b66106b6aff
- upstream: origin/main（与 HEAD 一致，已推送）
- 最近提交: 5f90174 feat: add durable task review cycle
- 工作区: 33 个文件变更/未跟踪，全部属于本轮 P0-07 / TC-SEC-001 安全切片，尚未提交、尚未推送。

## Phase / Gate

- 项目阶段: Phase 0（领域边界、无 Docker SaaS 发行、持久化恢复、可选 Huly 协作投影）
- 当前 Gate: P0-07 敏感 ACL（总项进行中）
- 当前子切片: TC-SEC-001 首个敏感根与首管理员原子创建

## 当前 Backlog Task

- TC-SEC-001：把普通节点转换为敏感根，并在同一事务内建立 SecurityDomain、首名 manage_access Grant、节点安全域、事件、Outbox 与回执。

## 已完成部分（本轮，未提交）

- 新增正式 SecurityDomain / SecurityGrant 领域模型与 grantAllows 能力判定。
- 新增 CreateSecurityRootHandler 与 POST /api/nodes/{nodeId}/security-domain 路由、浏览器契约解码。
- 空叶节点限制：仅允许无后代、无 Task、无 Asset 的节点成为敏感根。
- 租户范围拒绝复用被旧 Node/Task/Asset 引用过的域 ID（防旧域语义被劫持）。
- v3 旧域兼容只保留 view，不提升为 contribute/edit/manage_access。
- 权限时间改为每次事务内、紧邻判定处重新读取；文件外部存储后的最终事务重新取时间。
- grantAllows 拒绝非法/过期时间，fail-closed。
- Node 持久化端口用 assignSecurityDomain 替换整对象 update，锁定安全域变更入口。
- 无权/不存在节点统一返回 404（防枚举）；Product API 逐 Node/Task/Asset 鉴权。
- 文档：README、phase0-status、product-baseline、P0-ND-01、P0-05A-T1a 与新验收报告。

## 未完成部分

- 最终 pnpm smoke:native 尚未针对最后一次持久化重构后的构建复跑。
- 两名复核 Agent（next_backlog、p07_dependency）末轮复核因额度耗尽未返回结论；最后一次 assignSecurityDomain 不变量改动尚未独立复核。
- 尚未 git diff --check + 凭据扫描 + 提交 + 推送。

## 最近测试结果

- pnpm check：TypeScript + 74/74 测试 + 14 个 Huly ARM64 镜像锁 + 薄宿主边界全部通过。
- pnpm build:native：通过，最终制品 SHA-256 7a1d200745666e98d695cd63bc8e293031636317d0cb1420fea909c91ccf1cff。
- pnpm smoke:native：旧制品 SHA 9bbdc8... 已通过；最终构建后尚未复跑。

## 当前 Blocker

- Codex 5 小时使用限额；复核 Agent 额度同时耗尽。

## 下一步具体动作（恢复后按序执行）

1. pnpm smoke:native（针对最终构建 SHA 7a1d2007...，需 loopback 监听，可能需审批）。
2. git diff --check，并扫描凭据/私钥/密钥。
3. 复核最终 assignSecurityDomain 不变量改动（若额度恢复可再启一名 Agent）。
4. 提交并推送本切片，提交信息建议 feat: add sensitive security root and first-admin grant。
5. 提交后回到 Backlog 自动推进：下一片为 P0-07 成员/Grant 管理审计，或按依赖进入非空子树迁移 TC-SEC-002（需 ADR-006 持久迁移，不得扩展当前同步命令）。

## 恢复所需最小文件/报告

- 本检查点: docs/handoff/GOAL-CHECKPOINT.md
- 验收报告: docs/reports/P0-07-TC-SEC-001-first-security-root.md
- 状态: docs/phase0-status.md、docs/product-baseline.md
- 主要代码: packages/application/src/security/create-security-root.ts、packages/application/src/access/project-security.ts、packages/domain/src/security-access.ts、packages/adapters/src/{memory,sqlite}/persistence.ts
- 测试: tests/security-root.test.ts、tests/persistence.test.ts、tests/product-api.test.ts

## 未提交修改是否安全保留

- 安全：全部是本轮安全切片的源码/测试/文档改动，工作区仅未提交，无待执行的破坏性操作。
- 注意：在最终 smoke 与复核完成前不要提交或推送，避免把未验证状态写入远程。
