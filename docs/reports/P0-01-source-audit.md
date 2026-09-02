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

## 镜像不可变性结果

锁定的 Selfhost `compose.yml` 原本包含浮动或可变 tag。现已把 14 个 Linux ARM64 镜像解析为平台 digest，并由 `infra/huly/compose.digest.arm64.yml` 在本地验证时覆盖；`pnpm huly:images` 会检查服务覆盖完整性与 digest 一致性。上游文件保持不变。

该锁只覆盖 2026-09-02 解析的 Linux ARM64 验证环境；其他架构或生产升级必须重新解析并复验，不能复用平台 digest。

## 本地环境差异

- 默认 Node 为 24.15.0；已通过 nvm 安装隔离的 Node 22.23.2，供 Huly 构建使用。
- Docker Desktop 28.3.2 已启动，分配 10 CPU、约 8.22 GB 内存，接近最低线且低于推荐余量。
- 已用临时、经 SHA-256 校验的 Syft 1.51.1 生成源码 SBOM；另从 npm 官方注册表补取 2,887 个精确包版本的声明许可证，详见许可证摘要。
- Platform 开发依赖可能需要 GitHub Packages `read:packages` 授权；任何令牌只能通过环境或登录助手注入，不得写入仓库。

## 下一步通过条件

1. 人工复核 2 个未解析包、18 个 `UNKNOWN`、强 copyleft 与自定义服务条款。
2. 明确部署镜像自身的软件清单与许可证交付方式；源码 npm 目录不能替代镜像清单。
3. 法务/合规结论和两次部署证据一起通过后，再决定 ADR-001 是否 Accepted。

## 第一次启动发现

- 官方 `setup.sh --quick` 在缺少 `envsubst` 时不会失败退出，仍会打印完成信息；同时会尝试执行不适用于本地验证的 sudo nginx 操作。
- 官方 Compose 的 Redpanda 健康检查携带 SASL 用户名/密码，但对应启动命令没有启用 SASL，持续返回 `ILLEGAL_SASL_STATE`；无凭据 `rpk cluster info` 成功且 6 个 Huly topics 均存在。
- 本仓库的本地 override 仅修正该健康检查假阴性，不改变生产认证决策。
- Cockroach、Account 与 KVS 的密码哈希一致；启动早期的连接拒绝/认证错误在数据库初始化后停止，KVS 最终恢复运行。
- Huly 登录页已通过 HTTP 200 与 Cindy 浏览器真实渲染验证。
