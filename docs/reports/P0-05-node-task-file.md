# P0-05 Node → Huly Task → File 验收

> 历史证据说明：本报告记录 2026-09-03 原型验收。当时的“Huly Task 权威、同步补偿、进程内 Store”已被 CR-003 和 ARCH-GATE-01 取代；当前实现以产品 Task/Asset 为权威，Huly 仅为持久后台投影。不得再按本报告中的旧实现扩展代码。

日期：2026-09-03
结论：通过

## 验收边界

本项只证明一个普通项目节点可以通过 Product API 创建 Huly Issue，并把文件 Blob 作为 Huly Attachment 关联到同一 Issue；任务和文件的公开 DTO 可从节点上下文回读。

本项不包含任务提交验收、验收周期、必需交付物、节点完成守卫、敏感节点全通道 ACL、搜索、通知、ZIP 下载或性能结论。这些能力仍分别属于 P0-05A、P0-07、P0-08 与 P0-09。

## 实现结果

- 当前产品域保存 Node、ProductTask、Asset/AssetBinding、业务事件、Outbox、Job 与 Integration Operation，不导入 Huly SDK 类型。
- Task 标题、执行与验收状态以产品域为权威；Huly Issue 是可重建的协作投影。
- Blob、Attachment 与 Issue 分属三个 Adapter 端口；公开 Node/Task/File DTO、领域事件和 Outbox 均不暴露 Huly ID、Blob ID 或不透明 authority reference。
- 本地 TaskMapping/FileMetadata、事件、Outbox 和幂等完成记录在同一事务边界写入。
- 跨 Huly 操作使用确定性 ID 与 Saga：响应丢失时回查；Attachment 失败时保留可重试 Blob；本地提交失败时先删除 Attachment、再删除 Blob；补偿失败明确进入 `recovery_required`。
- Product API 从 Huly 页面接受当前操作者 Bearer token，并由 Huly account 接口解析 actor；请求体不能指定 actor，未使用 system token。
- Huly Shell 继续保持六节点地图，但任务与文件区已从 P0-04 fixture 改为 Product API 实际数据；页面明确展示 P0-05 非目标。

锁定 Huly Platform 版本仍为 `ccefccd8d0361d3c8612d508071b777aa833826d`（`v0.7.426`）。该版本的 `@hcengineering/api-client@0.7.426` 未在公共 npm registry 发布，因此原型 Adapter 固定使用同版本源码验证过的 REST wire；如果依赖包可用或 wire 变化，应以受支持客户端替换。移除条件为：官方客户端可安装且通过同一组幂等、补偿与权限回归。

## 自动验证

P0-05 使用本地子测试 ID，不把整组 `FC-006` 或 `FC-008` 的 MVP 验收误标为完成：

| 测试 | 覆盖 |
|---|---|
| P0-05-CT-001 | Node → Task → File、节点/安全域继承、公开 DTO 不泄漏 authority refs |
| P0-05-CT-002 | 相同命令幂等重放、跨 Service 实例并发合并，不重复权威记录、事件或 Outbox；变更载荷拒绝 |
| P0-05-CT-003 | 不存在节点与 milestone 节点在调用权威侧前拒绝 |
| P0-05-CT-004 | Task 本地投影、事件、Outbox 三个失败点均整体回滚并补偿 Huly Task |
| P0-05-CT-005 | Attachment 暂时失败后复用同一 Blob，不产生孤儿或重复文件 |
| P0-05-CT-006 | File 本地提交失败时按 Attachment → Blob 顺序补偿 |
| P0-05-CT-007 | 补偿失败进入 `recovery_required` 并阻止不安全自动重放 |
| P0-05-CT-008 | Huly REST TotalArray envelope、Issue、Attachment、Blob 的创建、回查、幂等与删除契约 |
| P0-05-CT-009 | Product API 状态码、幂等键、Node/Task/File 路由、CORS 与 DTO 边界 |

根仓库 `pnpm check` 覆盖 TypeScript、全部 Node 测试、14 个 ARM64 镜像锁和 Huly 扩展静态约束。Huly 资源包另以兼容的 Node 22.23.2 完成 Svelte 检查与 Front bundle。

## 真实 Huly 验收

- 隔离 Compose 项目：`project_process_map_p0_shell`；入口 `http://127.0.0.1:8089`。
- 专用工作区：`P0-05 Validation`；使用 Huly 默认 Tracker 项目。
- 本地 Front 镜像：`project-process-map/huly-front:p0-05`，最终验收 digest `sha256:73cf9e047a57b30c1d7f44411a3061c489577f229741143a23bde3df5c675d3c`；未推送公共镜像仓库。
- Huly `find-all` 真实响应为 `{ dataType: "TotalArray", value: [...] }`，而不是裸数组。第一次写入前 Adapter 因结构不符拒绝；修正并加入 CT-008 后重试成功。
- 项目过程图谱在节点 `N-03` 创建 `P0-05 真实 Huly 任务`，页面回读为“未开始”，文件数从 0 变为 1。
- 上传无凭据、无生产数据的 `p0-05-evidence.txt`，页面显示“处理中”；这是保守的扫描状态，不虚构病毒扫描已完成。
- Huly Tracker 独立显示 `TSK-1`、相同任务标题、`Todo` 状态和附件计数 1。
- Huly Issue 详情独立显示同名 107B 附件、下载链接和上传活动，证明 Blob 与 Attachment 均真实存在。
- 最终镜像再次无缓存加载，页面显示“当前节点任务 1”、真实任务及 1 个处理中附件；验收后已关闭隔离浏览器任务空间和 14 个容器，命名数据卷与本地镜像保留供复核。

## 仍未决与后续闸门

- SQLite/文件持久化和重启恢复已由 ARCH-GATE-01 取代本报告的进程内实现。
- Task 权威已由 ADR-005 确定为产品域；Huly 仅证明 Adapter 可行性。
- `submitted` 不映射成 Huly `Done`，任务验收模型留给 P0-05A。
- Blob 下载的父对象 ACL 与敏感节点传播尚未证明，留给 P0-07；当前 UI 不把扫描中的文件宣称为可用。
- 测试工作区只含虚构测试身份与验收数据，不含 Google 登录数据、Huly 密钥或生产个人数据。
