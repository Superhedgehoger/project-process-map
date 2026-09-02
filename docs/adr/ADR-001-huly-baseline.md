# ADR-001：Huly 基线候选

- 状态：Proposed
- 日期：2026-09-02
- 对应任务：P0-01

## 候选

| 仓库 | 不可变版本 |
|---|---|
| `hcengineering/platform` | tag `v0.7.426` → `ccefccd8d0361d3c8612d508071b777aa833826d` |
| `hcengineering/huly-selfhost` | `865584594cc582d9e0f7013be66c22f153df1176` |

两个仓库的 GitHub 许可证接口均识别为 `EPL-2.0`。Selfhost 官方 README 指示生产版本使用 `v*` tag，并在升级前检查 `MIGRATION.md`；本候选 tag 是 2026-09-02 核验时的最新正式 Release。

锁定源码的 `MIGRATION.md` 对 `v0.7.426` 标注为 `No changes required`。这只证明该版本没有额外迁移步骤，不代表整个部署已通过。

## 当前决定

只锁定候选，不批准 Go。以下证据补齐后才能将 ADR 改为 Accepted：

1. 从锁定 commit 检查仓库内许可证边界并生成依赖、镜像 SBOM。
2. 确认 Selfhost commit 与 Platform `v0.7.426` 的迁移说明和镜像配置兼容。
3. 在干净环境运行 quick setup，保存镜像 digest、健康状态、日志和耗时。
4. 第二个干净环境复跑部署命令。
5. 完成 EPL-2.0 分发方式与修改文件义务复核。

当前已知阻塞：Platform 构建要求 Node 22，而本机默认是 Node 24；Selfhost Compose 仍包含浮动镜像标签，必须先解析并冻结为 digest。详见 P0-01 源码审计报告。

## 未在本 ADR 决定

生产数据库、Task 字段权威来源、敏感 ACL、实时同步机制和 Huly 核心补丁均保持未决。
