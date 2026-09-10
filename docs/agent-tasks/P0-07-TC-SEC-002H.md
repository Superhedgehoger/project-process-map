# P0-07 / TC-SEC-002H：核心读取 API 的迁移期权限交集

## 目标

把核心 Node/Task/Asset 读取路径从“项目存在开放迁移即整体冻结”收紧为逐对象的旧域∩新域授权：迁移范围内无论对象当前处于 source 还是 target，调用者都必须同时满足两个安全域的 view；范围外对象保持原有授权。所有写路径继续冻结。

## 直接依据

- ADR-005：对象是否位于迁移范围只由产品 Node.parentId 与 Task/Asset ownerNodeId 决定。
- ADR-006：active 至 committed 前，所有读取通道要求旧域与新域权限交集；失败不放宽。
- ADR-007：Asset owner/security 快照由产品域权威维护。
- 已验收前置：TC-SEC-001、TC-SEC-002A～G、TC-SEC-003A/B/C。

## 必须保持的不变量

1. 只从同租户持久 Migration 与权威 parentId/ownerNodeId 判断对象是否属于迁移根子树；不得信任客户端、Relation 或 Huly hierarchy。
2. active/verifying/retryable/recovery_required 范围内对象必须对 source 与 target domain 分别执行当前时刻 view 授权，并取逻辑 AND；任一域 missing、legacy 不可判定、Grant 过期/撤销、成员或 principal 失效均 fail-closed。
3. 对 source→public 或 public→target 同样执行两侧语义：public 一侧仍要求 active 项目成员，敏感一侧要求有效 Grant；不得把 null 当作跳过全部身份检查。
4. 已迁与未迁对象返回完全相同的授权结果；无权与不存在保持相同 404/过滤行为，不泄露名称、数量或迁移进度。
5. 不在迁移范围的对象沿用其当前安全域授权；planned/committed/rolled_back 不得被误判为双域迁移窗口。
6. create/update/action/Grant/Membership/结构写等所有现有写路径继续调用项目稳定性守卫并冻结；本片不得借读取交集开放任何写入。
7. 多个迁移、跨项目 parent 边、嵌套迁移或范围无法唯一确定时 fail-closed。

## 允许修改

- application access 层的迁移范围解析与逐对象 view 判定
- Product API Node/Task/Asset collection/detail 读取接入
- 必要的只读端口、错误映射与直接测试
- Phase/Report/Evidence/checkpoint

## 明确不做

- 任何写路径解冻。
- 搜索、通知、实时、Blob 下载、ZIP/导出或 Huly 投影通道。
- committed/rollback/recovery、迁移创建授权、Job、事件/Outbox、UI、嵌套域或 U2/U7/U8。

## 验收

- 固定身份矩阵证明 only-old、only-new 均看不到迁移范围对象，both 可见；source/target 当前归属不影响结果，source↔public 两向覆盖。
- Node collection/detail 与其 Task/Asset 不泄露名称、数量或存在性；范围外对象行为不变。
- Grant 撤销/过期、成员/principal 失效与 active→verifying/retryable/recovery_required 全部即时 fail-closed。
- 所有写 API 在开放迁移期间仍返回现有冻结错误；跨租户/项目/子树与并发读取安全。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再扩展下一读取通道。
