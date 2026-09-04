# 项目过程图谱

本仓库是 PRD V1.3 / FC-1.2 加 CR-002、CR-003 的实现工作区。目前处于 Phase 0：建立可持续开发的领域边界、无 Docker SaaS 发行、持久化恢复和可选 Huly 协作投影；尚未宣称完整 MVP 已交付。

GitHub：<https://github.com/Superhedgehoger/project-process-map>

## 当前可运行内容

- 无 Docker 产品入口（页面 + Product API + Worker）：`pnpm start`，打开 <http://127.0.0.1:4100>
- 无 Docker 原生发行包：`pnpm build:native`
- 从临时目录解包、启动和纵向冒烟：`pnpm smoke:native`
- Product API 健康检查与 SQLite/文件持久化纵向链路：`pnpm dev:api`
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

### 无 Docker 运行

开发机需要 Node.js 24 和 pnpm；运行产品入口不需要 Docker：

```bash
pnpm install --frozen-lockfile
pnpm start
```

生成可搬运的服务端发行包：

```bash
pnpm build:native
pnpm smoke:native
```

制品生成在 `dist/release/`，包含编译后的 JavaScript、自包含浏览器页面、`bin/project-process-map` 启动器和 `SHA256SUMS`。SaaS 监听示例：

```bash
HOST=0.0.0.0 PORT=4100 ./bin/project-process-map
```

发行制品依赖 Node.js 24，默认使用 `data/project-process-map.sqlite` 与 `data/assets/`，API 和 Worker 共享持久队列。冒烟已覆盖页面 → 节点 → 任务 → 文件 → 停止 → 重启 → 回读且确认没有调用 Docker。生产发布仍需补干净 Linux、TLS/反向代理、正式 SaaS 登录、备份、签名和升级/回滚演练。

### Docker 的保留范围

以下 Huly Compose 路径只用于开发验证和上游回归，不属于正式交付的安装或运行前置。P0-05 原型需要由同一锁定源码构建 Front、Transactor、Workspace 三个本地镜像。Transactor 是浏览器运行模型的权威提供者，不能只替换 Front 与 Workspace。P0-05 只更新 Front；Transactor 与 Workspace 继续复用已验证的 P0-04 镜像。镜像就绪后可用独立端口启动：

```bash
HULY_COMPOSE_OVERRIDE="$PWD/infra/huly/compose.shell-prototype.yml" \
HULY_INSTANCE_NAME=project_process_map_p0_shell \
HULY_HTTP_PORT=8089 \
pnpm huly:up
```

Front 使用 `project-process-map/huly-front:p0-05`，Transactor 与 Workspace 使用 `project-process-map/*:p0-04`。这些镜像仅在本地生成，未推送到公共镜像仓库。

Huly 是可选协作投影，不是产品 Task 权威，也不是正式运行前置。后台投影只使用部署环境中的受限服务身份；用户令牌只用于请求时验证外部身份，绝不进入数据库、事件或日志：

```bash
COLLABORATION_MODE=huly \
HULY_TRANSACTION_ENDPOINT=http://127.0.0.1:8089/_transactor \
HULY_FILE_ENDPOINT=http://127.0.0.1:8089/files \
HULY_WORKSPACE_ID=<test-workspace-uuid> \
HULY_PROJECT_ID=tracker:project:DefaultProject \
HULY_CONNECTION_ID=huly-primary \
HULY_SERVICE_TOKEN=<restricted-service-token> \
PRODUCT_UI_ORIGIN=http://127.0.0.1:8089 \
pnpm start
```

Huly 扩展现在仅作为 SaaS 启动入口，不复制任务 DTO、状态机、假进度或写操作。投影失败不会回滚产品事实：Worker 通过持久 Integration Operation、稳定引用、租约、重试、死信和受权恢复入口续跑。

## 开发顺序

1. `P0-01`：锁定 Huly commit、许可证、SBOM 初稿与可重复构建命令。
2. `P0-02`：在干净环境完成自托管部署并保存证据。
3. `P0-03`：验证 Product API、Worker 和内存 Adapter 骨架。
4. `P0-04`：Huly Shell 页面与六节点交互原型。
5. `P0-05`：Node → Huly Task → File 引用纵向演示。
6. `P0-ND-01`：无 Docker 产品发行包、浏览器入口和解包冒烟。
7. `ARCH-GATE-01`：修正租户/身份、Task/树权威、Asset、持久事务、集成恢复和 UI 契约边界。
8. `P0-ND-02`：无 Docker 干净 Linux、正式登录、备份和升级回滚。
9. `P0-05A`：架构闸门完成后恢复任务验收与交付物完成守卫开发。

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
