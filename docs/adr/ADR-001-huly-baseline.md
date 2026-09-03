# ADR-001：Huly 基线

- 状态：Accepted
- 日期：2026-09-02
- 批准日期：2026-09-02
- 对应任务：P0-01

## 候选

| 仓库 | 不可变版本 |
|---|---|
| `hcengineering/platform` | tag `v0.7.426` → `ccefccd8d0361d3c8612d508071b777aa833826d` |
| `hcengineering/huly-selfhost` | `865584594cc582d9e0f7013be66c22f153df1176` |

两个仓库的 GitHub 许可证接口均识别为 `EPL-2.0`。Selfhost 官方 README 指示生产版本使用 `v*` tag，并在升级前检查 `MIGRATION.md`；本候选 tag 是 2026-09-02 核验时的最新正式 Release。

锁定源码的 `MIGRATION.md` 对 `v0.7.426` 标注为 `No changes required`。这只证明该版本没有额外迁移步骤，不代表整个部署已通过。

## 决定

批准以下不可变基线进入后续 Phase 0 开发：

1. Platform `ccefccd8d0361d3c8612d508071b777aa833826d`。
2. Selfhost `865584594cc582d9e0f7013be66c22f153df1176`。
3. `infra/huly/image-lock.arm64.json` 中的 14 个 Linux ARM64 平台 digest。
4. `tools/huly-local.sh` 作为本地验证入口；它不是生产部署脚本。

批准依据包括源码与镜像 SBOM、npm 许可证目录、两次隔离自托管复跑、HTTP 200 和真实浏览器登录页验证。项目负责人于 2026-09-02 明确确认“通过、继续”。许可证报告中的 SSPL、AGPL/GPL/LGPL、自定义条款和未解析项作为已知风险继续保留；本 ADR 的 Accepted 表示允许继续 Phase 0 技术开发，不替代未来生产发布前的法务/合规审查。

任何架构、Huly tag、Selfhost commit 或目标平台变化都必须重新生成镜像锁、SBOM 并复跑部署，不能静默沿用本决定。

## 2026-09-03 范围修订

CR-002 将正式交付目标改为 SaaS 与无 Docker 原生发行。本文的 Huly commit、容器镜像和适配可行性结论继续有效，但 Docker Compose 不再构成生产部署证据；生产目标平台部分由 ADR-002 重开，并在 P0-ND-02 重新验证。

## 未在本 ADR 决定

生产数据库、Task 字段权威来源、敏感 ACL、实时同步机制和 Huly 核心补丁均保持未决。
