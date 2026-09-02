# P0-01 Huly 锁定源码审计

- 检查日期：2026-09-02
- 结论：候选版本可继续验证，P0-01 尚未通过

## 已证实

| 检查项 | 结果 |
|---|---|
| Platform 工作树 HEAD | `ccefccd8d0361d3c8612d508071b777aa833826d` |
| Selfhost 工作树 HEAD | `865584594cc582d9e0f7013be66c22f153df1176` |
| Platform 稳定标签 | `v0.7.426` |
| `v0.7.426` 迁移说明 | `No changes required` |
| Platform/Selfhost 根许可证 | GitHub 识别为 EPL-2.0 |
| Platform 构建工具 | Node 22、Rush 5.158.1、pnpm 10.15.1 |
| Selfhost 最低资源 | 2 vCPU / 8 GB RAM；推荐 4 vCPU / 16 GB RAM |

## 尚未满足的不可变性要求

锁定的 Selfhost `compose.yml` 包含以下非 digest 镜像引用：

- `cockroachdb/cockroach:latest-v24.2`
- `minio/minio`（未指定 tag）
- 其他固定 tag 或 `${HULY_VERSION}` 镜像也尚未解析为 digest

因此不能直接把官方 Compose 文件视为可重复部署证据。P0-02 前应生成一份仅用于验证环境的 digest override，不修改上游源码，并保存解析时间与目标架构。

## 本地环境差异

- 默认 Node 为 24.15.0；Huly Platform 文档要求 Node 22。
- Docker Client 为 28.3.2；本次检查没有可用的 Docker Server 版本。
- `syft` 与 `trivy` 未安装，尚未生成依赖和镜像 SBOM。
- Platform 开发依赖可能需要 GitHub Packages `read:packages` 授权；任何令牌只能通过环境或登录助手注入，不得写入仓库。

## 下一步通过条件

1. 为 Huly 构建准备隔离的 Node 22 环境，不改变本项目 Node 24 骨架。
2. 安装或使用容器化 SBOM 工具，对两个锁定工作树和部署镜像生成 CycloneDX 清单。
3. 将 Compose 镜像全部解析为不可变 digest，并生成验证环境 override。
4. 启动 Docker 服务后运行 quick setup，保存健康状态、镜像 digest、耗时和日志。
5. 在第二个干净环境复跑，再决定 ADR-001 是否 Accepted。
