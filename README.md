# 项目过程图谱

本仓库是 PRD V1.3 / FC-1.2 的实现工作区。目前处于 Phase 0：验证 Huly 底座、自托管、适配器边界、权限与事件一致性，不代表生产架构已经批准。

GitHub：<https://github.com/Superhedgehoger/project-process-map>

## 当前可运行内容

- Product API 健康检查：`pnpm dev:api`
- Worker 健康检查：`pnpm dev:worker`
- Phase 0 大样例与最小签字模板：`pnpm fixtures:generate`
- Huly 基线文件检查：`pnpm huly:verify`
- 全部静态检查与测试：`pnpm check`

## 开发顺序

1. `P0-01`：锁定 Huly commit、许可证、SBOM 初稿与可重复构建命令。
2. `P0-02`：在干净环境完成自托管部署并保存证据。
3. `P0-03`：验证 Product API、Worker 和内存 Adapter 骨架。
4. `P0-04/P0-05`：Huly Shell 页面以及 Node → Task → File 纵向演示。

详见 `docs/phase0-status.md`。

## Antigravity IDE 接续入口

Antigravity IDE 只接收边界明确的任务，Cindy 以 Git 差异和自动测试回收结果。P0-01 的任务文件已准备在 `docs/agent-tasks/P0-01.md`：

```bash
antigravity-ide chat --mode agent --reuse-window \
  --add-file docs/agent-tasks/P0-01.md \
  "按任务文件继续核验，不扩大范围；完成后保留代码和测试证据供 Cindy 验收"
```

该命令会打开图形界面，且 CLI 没有可靠的无头完成回调，因此不会作为 CI 步骤运行。
