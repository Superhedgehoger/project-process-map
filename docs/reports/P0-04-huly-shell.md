# P0-04 Huly Shell 验收

日期：2026-09-03
结论：通过

## 基线与边界

- Huly Platform：`ccefccd8d0361d3c8612d508071b777aa833826d`（`v0.7.426`）。
- Huly Selfhost：`865584594cc582d9e0f7013be66c22f153df1176`。
- 产品基线：PRD V1.3、FC-1.2、CR-001。
- 原型不修改 Workbench 内核，不在领域代码中引入 Huly SDK 类型，也不建立 Huly/产品域双写。
- 本项只证明 Huly Shell 页面可装配和运行；页面数据仍是 P0-04 展示 fixture，不代表 P0-05 的 Node、Task、File 纵向链路已经完成。

## 接入内容

扩展以四个独立私有包维护：

1. `@hcengineering/project-process-map`
2. `@hcengineering/project-process-map-assets`
3. `@hcengineering/project-process-map-resources`
4. `@hcengineering/model-project-process-map`

物化脚本只修改五个 Huly composition 文件：`rush.json`、`models/all/package.json`、`models/all/src/index.ts`、`dev/prod/package.json`、`dev/prod/src/platform.ts`。脚本绑定精确上游 commit，可重复执行且不会重复插入。

运行时必须同时替换三个服务：

- Front：加载资源包、图标与中英文字符串。
- Transactor：向浏览器提供包含新 Application 的运行模型。
- Workspace：为新建/升级工作区使用同一模型。

其余 11 个服务继续使用已锁定的 ARM64 digest 镜像。

## 缺陷与修正

真实环境验证发现并修正了两项装配缺陷：

1. 仅传入模型 builder 与插件 ID 时，Huly 会生成 `hidden=true / enabled=false` 的默认 PluginConfiguration。现已显式设置 `enabled=true`、`beta=false`，并以 `workbench.class.Application` 作为 UI 类过滤范围。
2. 仅替换 Front 与 Workspace 时，侧栏仍看不到应用。源码和运行诊断确认完整初始模型不会持久化到工作区表；浏览器模型由 Transactor 提供。因此部署覆盖加入本地 Transactor 镜像，并将三服务约束写入自动校验。

此外，语言加载器对 `zh` 使用中文资源，其他语言静态回退到英文，避免动态导入不存在的语言文件。

## 构建与静态证据

- `pnpm huly:extension:apply` 连续执行两次：成功，无重复注册。
- `pnpm huly:extension:verify`：通过。
- 定向 Rush build：84 个依赖操作和四个扩展包全部通过。
- `rush validate --to @hcengineering/model-all`：584 个操作通过。
- `rush svelte-check --to @hcengineering/project-process-map-resources`：通过。
- `rush bundle --to @hcengineering/model-all --to @hcengineering/pod-workspace`：通过。
- `rush package --to @hcengineering/prod`：通过。
- `rush bundle --to @hcengineering/pod-front --to @hcengineering/pod-workspace`：通过。
- `rush bundle --to @hcengineering/pod-server`：770 个依赖操作完成，目标 bundle 成功。
- 生成的 `model.json` 含 Application 与 PluginConfiguration 两条过程图记录；属性包括 `alias=project-process-map`、`hidden=false`、`enabled=true` 和 Application class filter。
- 前端产物包含页面 chunk、中英文字符串 chunk 和 `project-process-map` SVG symbol。

本地 ARM64 验收镜像：

| 服务 | Image ID |
|---|---|
| Front | `sha256:e922d5325315e46d3d5b23c44dd3b77a7aee25cd01bf3d25bb1662af23332129` |
| Workspace | `sha256:960304fba501e1ef309ca73c1f2ec46f49e85bb515e0a62326ee3d3919a0ba7e` |
| Transactor | `sha256:72cc54c175b47c6982d8a5774493bd750219ed0743886622e691afb9124ac671` |

这些镜像仅用于本地验收，未推送或分发。

## 真实 Shell 验收

- Compose 项目：`project_process_map_p0_shell`。
- 入口：`http://127.0.0.1:8089`，宿主机返回 HTTP 200。
- 新建无 demo 内容的隔离测试工作区 `projectprocessmapshell`，由修正后的 Workspace 创建。
- 新 Transactor 启动后从隔离浏览器删除该工作区的一条旧模型缓存记录，再重新登录；未删除或改写业务数据。
- 重新获取的该工作区模型缓存包含 9 处 `project-process-map` 标识，证明浏览器收到的是新 Transactor 模型。
- Huly 侧栏出现 `/workbench/projectprocessmapshell/project-process-map`。
- 页面标题为“项目过程图谱”，Huly 顶栏与侧栏保持可见。
- 页面渲染 6 个节点、项目摘要、任务、阶段交付物和“完成守卫”。
- 点击“开发与联调”后，详情切换为 `N-04`、`有风险`、`42%`，证明不是静态截图而是可交互的 Svelte 页面。

浏览器语义树与 DOM 断言均通过。CDP 全页截图在该设备上两次超过 15 秒超时，因此不把截图列为通过条件；页面 URL、语义内容、DOM 路由和交互状态作为验收证据。

验收后已关闭隔离浏览器任务空间，并通过 `pnpm huly:down` 删除 14 个验收容器和专用网络；命名数据卷与三个本地原型镜像保留，可用于复核。

## 回归与移除条件

- 根仓库 `pnpm check` 必须包含 Shell 扩展校验。
- Huly 上游 commit、包数量、composition 文件数量、显式启用配置、语言回退，以及 Front/Transactor/Workspace 三镜像覆盖均由静态脚本检查。
- 当 Huly 提供受支持的运行时插件注册机制，或本应用被上游正式接纳时，删除五处静态 composition 补丁；删除前必须保留等价的模型、资源与三服务回归覆盖。

项目负责人对 P0-01 风险闸门的批准允许继续本地 Phase 0 原型，不等同于生产发布的法律意见。
