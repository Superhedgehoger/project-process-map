# P0-07 / TC-SEC-002A 敏感后代同域继承

- 日期：2026-09-09
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 产品依据：PRD V1.3、FC-013、TC-SEC-001/002
- 架构依据：ADR-003、ADR-004、ADR-006、ADR-008

## 本切片交付

- 普通 Node 创建请求仍只允许 `securityDomainId: null`；当父节点属于正式敏感域时，服务端在事务内继承父节点的 `securityDomainId` 与当前 `securityEpoch`。
- 敏感父节点路径要求 actor 为 active user、同项目 active project_manager，并持有父域当前有效的 `edit` 或更高 Grant。普通 member 的 edit Grant 与无 Grant 项目经理均不能创建。
- 回放前重新读取父节点、正式 Domain、根节点、actor Principal/Membership 与 Grant；原 Grant 撤销后旧成功回执不能继续使用。
- missing/existing 无权父节点返回同一最小 `PARENT_NODE_NOT_FOUND`；legacy-only 与嵌套域 fail-closed，开放 SecurityDomainMigration 时冻结写入。
- Node、`project-map.node.created` v1 事件、Outbox 与回执沿用原子事务；事件与 Outbox 的原始安全域/纪元等于实际继承值。
- 未修改领域模型、Persistence adapter 或 SQLite Schema；未开放新 HTTP/UI，也未启动既有子树换域迁移。

## 自动验收证据

- Memory/SQLite 敏感继承与合法回放通过；新敏感后代上的 Task 与 Asset 继续继承同域。
- member+edit、manager 无 Grant、missing parent 的错误码和消息一致。
- Grant 撤销后回放拒绝；legacy、nested、migration 三类范围均拒绝。
- 四个既有故障注入点均证明 Node、事件、Outbox、回执无部分提交。
- 两个 SQLite 连接并发重试只写一个敏感后代；重启后域、纪元与单一事件保持一致。
- 独立安全 Review 首轮发现正式根删除与父/根纪元漂移未拒绝；修复并加入 Memory/SQLite 回归后复审 PASS，无剩余阻断项。
- `pnpm check`：TypeScript、113/113 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 与高置信凭据/私钥特征扫描通过。

## 明确未完成

- 既有节点/非空子树换域及 ADR-006 批次迁移。
- 嵌套 SecurityDomain、Node Owner、organization/system_admin、Emergency Access。
- 节点移动、角色槽位、HTTP/UI 新入口与全通道 ACL。

本片只完成 TC-SEC-002 的“新建敏感后代”前置，不宣称完成整个 TC-SEC-002 或 P0-07。
