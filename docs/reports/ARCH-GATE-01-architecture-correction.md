# ARCH-GATE-01 架构修正验收

- 日期：2026-09-04
- 决策来源：CR-003、ADR-003～ADR-008
- 结论：代码闸门通过；允许继续下一条业务纵向切片

## 已消除的返工源

| 风险 | 修正结果 |
|---|---|
| Huly/Product Task 双权威 | ProductTask 持有标题、执行、验收和版本；Huly 仅为异步协作投影 |
| 项目树双写 | `ProjectNode.parentId` 为唯一写权威，parent-child Relation 禁止写入 |
| God Store 与同步事务 | 应用层窄 Repository/Persistence 端口；SQLite 与 Memory 分别实现；网络调用不进入本地事务 |
| 进程内 Outbox/Job | SQLite claim/lease/ack/retry/dead-letter，API 与 Worker 跨进程共享 |
| 文件字段散落 | Asset/AssetBinding 统一承载哈希、扫描、隔离、删除墓碑与业务绑定 |
| 外部 ID 锁定领域主键 | TenantId/PrincipalId 为内部键；Huly workspace/subject 经可撤销持久映射关联 |
| 脆弱 authority 字符串 | 外部引用固定为 provider/kind/externalId/schemaVersion，并以同步水位做条件删除 |
| 外部部分成功 | 确定性 request ID、逐步 Integration Operation、超时分类、回查、续跑与死信恢复 |
| API/UI 契约漂移 | 全量任务状态契约、运行时解码、唯一内联浏览器客户端；Huly UI 缩为 SaaS 启动入口 |
| 巨型 HTTP 条件链 | 项目路由、恢复路由和通用 HTTP 解析分离；Product API 入口不依赖 Adapter 实现 |
| 不完整状态机 | Task 直接完成/验收/拒绝/撤回/取消/转正式、Asset、Security Migration、Integration Operation 均限制合法转换 |

旧的同步 Node→Huly Task→File God Service、领域层具体内存 Store、基础设施端口和对应平行测试已删除，避免后续开发继续引用被否决的抽象。

## 事务与失败语义

- 本地命令在一个 SQLite 事务提交领域状态、最小事件、Outbox、Job、幂等回执及必要的集成意图。
- 客户端重复调用通过 `(tenant, principal, operation, idempotencyKey)` 回放；同键异载荷拒绝。
- Huly 成功但响应丢失时，以确定性 ID 回查，不创建第二份 Issue/Blob/Attachment。
- Blob 成功、Attachment 失败时保存 Blob 检查点；下一次只续跑 Attachment。
- 非重试错误直接死信；重试耗尽后死信。恢复列表默认拒绝访问，只有配置的 operator principal 可用 expectedVersion、reason 和幂等键原子重排原 Job，并写审计事件与 Outbox。
- 安全域迁移保存 hierarchy revision、旧/新 epoch、cursor 和进度；重启后续跑，过期 Worker 的 CAS 更新失败，提交前始终按旧/新域权限交集设计。

## 未来 6～12 个月功能套入结果

| 未来模块 | 进入当前架构的位置 | 是否需要拧着架构写 |
|---|---|---|
| 任务看板 | ProductTask 的查询/视图投影；拖拽仍调用任务命令 | 否 |
| 交付物与证据 | Deliverable 聚合引用 AssetBinding；不复制 File 表 | 否 |
| Blocker/Decision/Record | 各自聚合，文件统一走 AssetBinding，事件走同一 Outbox | 否 |
| 通知/实时/搜索 | 消费最小领域事件建立可重建投影，并执行同一安全域策略 | 否；实现前须补全通道级 ACL 测试 |
| ZIP/导出 | 后台 Job + 权限快照 + Asset 读取，不在请求事务内拼装 | 否 |
| 多协作工具 | 新增 Task/Blob/File Projection Adapter 与 ExternalBinding provider | 否 |
| PostgreSQL/多副本 | 新增 Persistence 适配器并复用行为契约 | 否；水平扩展前是硬门槛 |
| 计费/套餐 | 独立 Billing/Entitlement 边界，以幂等 Saga 处理支付回调 | 否；不得写进 Project/Task Service |
| AI Agent | 独立 AgentRun/Step/ToolInvocation/Approval/Artifact/SecretReference；只经应用命令改领域事实 | 否；不得让 Tool 直接写表 |

## 继续开发时的修改半径

一个普通新命令通常只需要：所属领域规则、一个应用 Handler、对应路由/契约和行为测试。它不需要修改 SQLite/Huly Adapter；只有新增持久实体、外部 provider 或新查询投影时才触及相应基础设施。Provider 分支集中在组合根和 Job dispatcher，不允许散布到领域代码。

## 自动证据

- `pnpm check`：TypeScript、42 项行为/故障测试、14 个 Huly ARM64 镜像锁、Huly 薄宿主边界全部通过。
- `pnpm build:native`：生成 Node 24 原生发行包与 SHA-256。
- `pnpm smoke:native`：`page -> nodes -> task -> asset -> restart -> readback` 通过，`persistence=sqlite+filesystem`，`dockerInvoked=false`。

仍属于后续功能/发布闸门而非当前架构缺陷的事项：正式 SaaS 登录 UI、P0-07 全通道 ACL 传播 Runner、PostgreSQL 多副本、备份恢复、TLS、发行签名、升级/回滚。它们已有明确端口和进入条件，不得用 Phase 0 默认值冒充生产完成。
