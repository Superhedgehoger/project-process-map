# P0-07 / TC-SEC-002B：Task/Asset 安全归属不可变守卫

## 目标

关闭普通 `TaskRepository.update` 与 `AssetRepository.update` 可重写既有对象项目、所属节点、安全域或安全纪元的持久层旁路。普通生命周期写只能改变业务状态；安全归属只能由后续 ADR-006 专用迁移端口修改。

## 直接依据

- PRD V1.3、FC-013：敏感节点下 Task/Asset 继承节点安全域，不得通过普通业务更新降级。
- 数据与权限规格：对象 SecurityDomain、RBAC ∩ Grant、权限变化 fail-closed。
- TC-SEC-001/002：伪造 Grant、跨域、撤权立即生效与迁移期间旧域∩新域。
- ADR-003、ADR-004、ADR-006、ADR-007。
- 已验收前置：TC-SEC-001、TC-SEC-002A、TC-SEC-003A/B/C。

## 必须保持的不变量

1. 既有 Task 的 `tenantId/id/projectId/ownerNodeId/securityDomainId/securityEpoch/createdAtUtc` 对普通保存不可变。
2. 既有 Asset 的 `tenantId/id/projectId/ownerNodeId/securityDomainId/securityEpoch/uploaderPrincipalId/createdAtUtc` 对普通保存不可变；不得通过生命周期更新改变上传者或安全归属。
3. Memory/SQLite 持久层自身执行 CAS 与不可变字段校验，稳定拒绝 public→sensitive、sensitive→public、Domain A→B、epoch 重写、跨节点、跨项目和身份字段重写。
4. 即使事务回调捕获持久层错误，也不得留下部分写；SQLite 重启与并发 CAS 保留原始安全归属。
5. 普通 Task 生命周期、验收周期、负责人/验收人改派，以及 Asset initiated→uploading→scanning→终态转换继续工作。
6. TC-SEC-002A 新敏感后代上的 Task/Asset 继承行为不变。
7. 不得让后续迁移代码复用不受限的普通 update；若保留方法名，端口语义和静态测试必须明确安全归属不可变。

## 允许修改

- `packages/application/src/ports/persistence.ts`
- `packages/adapters/src/memory/persistence.ts`
- `packages/adapters/src/sqlite/persistence.ts`
- 必要的现有 Task/Asset 应用层调用点
- 直接相关测试、Task Packet、Phase/Report/Evidence/checkpoint

## 明确不做

- ADR-006 迁移计划、Job、cursor、批量对象换域或旧域∩新域传播。
- Node 移动、嵌套域、U2/U7/U8 身份模型。
- API/UI、搜索、关系、通知、实时、Blob/ZIP 等通道扩展。
- SQLite Schema 变化；若发现必须变更，先重新拆 Task。

## 验收

- Memory/SQLite 对 Task 与 Asset 的七类安全归属篡改稳定失败，存储行不变。
- 回调捕获错误、stale CAS、并发和 SQLite 重启均不能改变原始归属。
- 静态检查证明普通保存没有安全归属改写通道，未来迁移必须新增专用端口。
- Task/Review/Asset 全部既有生命周期测试与 TC-SEC-002A 继承测试通过。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再进入 ADR-006 迁移子片。
