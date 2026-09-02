# P0-01 SBOM 初稿摘要

- 生成日期：2026-09-02
- 工具：Anchore Syft 1.51.1（官方发布包 SHA-256 校验通过）
- 格式：CycloneDX JSON

| 来源 | 组件数 | 含许可证元数据 | SBOM SHA-256 |
|---|---:|---:|---|
| Platform `ccefccd8…` | 7,560 | 0 | `3d5265579bc3560f8a53fd6b325215a0498795ce4463038696de2051c0ee2234` |
| Selfhost `8655845…` | 5 | 0 | `cbb56c3feeefa11d98e87837912e3b7980be7246f3090e3a1806bf17b1f7ae9d` |

完整 SBOM 作为本地 Phase 0 证据保存在 `artifacts/huly/`，不提交到业务源码仓库。两个结果均没有许可证元数据，因此许可证清单仍未通过；后续必须结合 Rush/pnpm lockfile、镜像 SBOM 和许可证扫描补全，不能依据根目录 EPL-2.0 推断全部依赖均为 EPL-2.0。

Selfhost 的 14 个镜像已在 2026-09-02 解析到 Linux ARM64 digest，清单见 `infra/huly/image-lock.arm64.json`，验证覆盖文件见 `infra/huly/compose.digest.arm64.yml`。
