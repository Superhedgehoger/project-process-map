# 项目过程图谱

本仓库是 PRD V1.3 / FC-1.2 的实现工作区。目前处于 Phase 0：验证 Huly 底座、自托管、适配器边界、权限与事件一致性，不代表生产架构已经批准。

GitHub：<https://github.com/Superhedgehoger/project-process-map>

## 当前可运行内容

- Product API 健康检查与内存纵向演示：`pnpm dev:api`
- Worker 健康检查：`pnpm dev:worker`
- 本地 Node/事件/Outbox 原子性与幂等原型：`pnpm test`
- Phase 0 大样例与最小签字模板：`pnpm fixtures:generate`
- Huly 基线文件检查：`pnpm huly:verify`
- Huly ARM64 镜像锁检查：`pnpm huly:images`
- Huly 本地镜像 SBOM：`SYFT_BIN=/path/to/syft pnpm huly:image-sboms`
- Huly Shell 扩展静态校验：`pnpm huly:extension:verify`
- 将 Shell 扩展装配到锁定源码：`pnpm huly:extension:apply`
- Huly 本地验证环境：`pnpm huly:up` / `pnpm huly:ps` / `pnpm huly:down`
- 全部静态检查与测试：`pnpm check`

P0-05 原型需要由同一锁定源码构建 Front、Transactor、Workspace 三个本地镜像。Transactor 是浏览器运行模型的权威提供者，不能只替换 Front 与 Workspace。P0-05 只更新 Front；Transactor 与 Workspace 继续复用已验证的 P0-04 镜像。镜像就绪后可用独立端口启动：

```bash
HULY_COMPOSE_OVERRIDE="$PWD/infra/huly/compose.shell-prototype.yml" \
HULY_INSTANCE_NAME=project_process_map_p0_shell \
HULY_HTTP_PORT=8089 \
pnpm huly:up
```

Front 使用 `project-process-map/huly-front:p0-05`，Transactor 与 Workspace 使用 `project-process-map/*:p0-04`。这些镜像仅在本地生成，未推送到公共镜像仓库。

启动 Huly 后，可另开终端让 Product API 连接一个专用测试工作区。浏览器页面会把当前 Huly 操作者令牌委托给 API；令牌不得写入环境文件或仓库：

```bash
ADAPTER_MODE=huly \
HULY_TRANSACTION_ENDPOINT=http://127.0.0.1:8089/_transactor \
HULY_FILE_ENDPOINT=http://127.0.0.1:8089/files \
HULY_WORKSPACE_ID=<test-workspace-uuid> \
HULY_PROJECT_ID=tracker:project:DefaultProject \
PRODUCT_UI_ORIGIN=http://127.0.0.1:8089 \
pnpm dev:api
```

本期 Product API 的本地投影仍为进程内存实现；重启后不会从 Huly 反推 Node 归属。物理数据库和 Task 权威的最终选择仍等待 Phase 0 ADR，不应把该命令用于生产。

## 开发顺序

1. `P0-01`：锁定 Huly commit、许可证、SBOM 初稿与可重复构建命令。
2. `P0-02`：在干净环境完成自托管部署并保存证据。
3. `P0-03`：验证 Product API、Worker 和内存 Adapter 骨架。
4. `P0-04`：Huly Shell 页面与六节点交互原型。
5. `P0-05`：Node → Huly Task → File 引用纵向演示。
6. `P0-05A`：任务验收与交付物完成守卫，不属于 P0-05。

项目负责人已批准 P0-01 许可证风险闸门，可继续本地 Phase 0 集成；该批准是项目风险接受，不替代生产发布前的正式法律审查。

详见 `docs/phase0-status.md`。

## Antigravity IDE 接续入口

Antigravity IDE 只接收边界明确的任务，Cindy 以 Git 差异和自动测试回收结果。P0-01 的任务文件已准备在 `docs/agent-tasks/P0-01.md`：

```bash
antigravity-ide chat --mode agent --reuse-window \
  --add-file docs/agent-tasks/P0-01.md \
  "按任务文件继续核验，不扩大范围；完成后保留代码和测试证据供 Cindy 验收"
```

该命令会打开图形界面，且 CLI 没有可靠的无头完成回调，因此不会作为 CI 步骤运行。
