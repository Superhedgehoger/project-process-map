# P0-07 / TC-SEC-002J：外部协作投影的迁移期出站冻结

## 目标

在尚未具备 Huly 端旧域∩新域 ACL 映射与既有副本收敛证据前，先关闭迁移范围内 Task/Asset 的新出站投影旁路：开放迁移期间不得向 Huly 创建、更新或附加相关 Issue/Blob/Attachment，也不得把安全冻结消耗成普通失败或死信。本片不宣称外部通道已经可见性收敛，也不进入 committed。

## 直接依据

- ADR-003：Product Task/Asset 是权威事实，Huly 只是可恢复异步投影。
- ADR-005：范围只由产品 Node.parentId 与 Task/Asset ownerNodeId 决定。
- ADR-006：迁移期间所有读取/可见性通道保持旧域∩新域，索引与可见性投影达到目标 epoch 后才能 committed。
- ADR-007：Asset/Blob 外部副本不是下载或 ACL 权威。
- 已验收前置：TC-SEC-002A～I、ARCH-GATE-HULY-001/002、ARCH-GATE-RECOVERY-001。

## 必须保持的不变量

1. 每次外部调用前，在同租户当前产品状态上解析 Task/Asset 的 project、ownerNodeId、securityDomainId/securityEpoch 与开放 Migration；只用权威 parentId/ownerNodeId，不信任 job payload、Huly hierarchy 或旧 external binding。
2. 对 active/verifying/retryable/recovery_required 范围内对象，任何 Huly Task、Blob、Attachment 创建/更新/附加均不得发生；范围无法唯一确定、根/owner 缺失、跨项目边或对象安全归属漂移同样 fail-closed。
3. 安全冻结是可恢复 defer，不是外部失败：不得增加 provider attempt、不得进入 dead letter/recovery_required、不得创建部分 IntegrationOperation step 或伪造投影成功水位。
4. Migration committed/rolled_back 后只能在重新读取当前对象并通过正常投影守卫后继续；planned 是否允许投影必须沿用 ADR-006 状态语义，不得误当双域窗口。
5. 冻结前已经存在的 Huly 副本不因本片自动变得安全；报告与状态必须明确该残余，不得作为 committed 证据。
6. 不改变 Product Task/Asset 权威事实、下载通道、Grant/Membership、迁移对象写、最后管理员或 Huly 数据模型。

## 允许修改

- collaboration projection processor 的迁移范围预检
- Job/processor 必要的非失败 defer 语义与 Memory/SQLite 行为
- 直接 processor、adapter spy、重启/并发测试
- Phase/Report/Evidence/checkpoint

## 明确不做

- Huly 端 ACL/space 设计、既有 Issue/Attachment 迁移或删除。
- 搜索、通知、实时、ZIP/导出。
- Migration committed/rollback/recovery 命令、迁移创建 API/UI。
- 新的外部 provider 或产品功能。

## 验收

- source/target 当前归属上的 Task 与 Asset 在四个开放状态均零外部调用、零部分 operation/step，并以可恢复 defer 保留原 job。
- 范围外、planned、committed/rolled_back 仅按既有投影规则运行；invalid root/owner/project/epoch fail-closed。
- freeze→恢复、进程重启与并发 Worker 不重复 Issue/Blob/Attachment，不消耗失败预算，不泄露名称/reference/迁移进度。
- 明确记录既有 Huly 副本仍需后续 ACL/收敛方案，本片不得使 Migration committed。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再进入外部可见性收敛或下一通道。
