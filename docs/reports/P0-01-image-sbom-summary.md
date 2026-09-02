# P0-01 部署镜像 SBOM 摘要

- 生成日期：2026-09-02
- 工具：Anchore Syft 1.51.1（官方发布包 SHA-256 校验通过）
- 输入：`infra/huly/image-lock.arm64.json` 中 14 个 Linux ARM64 平台 digest
- 格式：CycloneDX JSON
- 本地汇总：`artifacts/huly/image-sbom-summary.json`（不提交仓库）
- 汇总 SHA-256：`05e06d050d9c4a1f7d3dd2c01909e4316422804f75c34603a91aa2afed53d79b`

## 覆盖结果

| 项目 | 数量 |
|---|---:|
| 锁定镜像 | 14 |
| 各镜像组件数之和 | 105,840 |
| 各镜像含许可证元数据组件数之和 | 4,412 |
| 跨镜像去重组件键 | 33,128 |
| 跨镜像去重 npm purl | 271 |
| 跨镜像去重 deb/rpm/apk purl | 1,536 |
| 跨镜像去重且含许可证元数据组件键 | 1,978 |

“各镜像之和”会重复计算共享基础层和相同应用依赖；“去重组件键”以 purl 为主，purl 中的发行版限定也会保留，因此这些数字用于覆盖核对，不代表法律意义上的独立作品数量。

## 每个镜像的证据

| 镜像 | 组件 | 含许可证元数据 | SBOM SHA-256 |
|---|---:|---:|---|
| `elasticsearch:7.14.2` | 11,512 | 447 | `bae5d41fc0aaf633730d7f0730819d452683c803caf42d96320c53241b5e531a` |
| `cockroachdb/cockroach:latest-v24.2` | 3,226 | 112 | `09535c3813eb792d80c03a163f963c23ac09e2409e023af4a2c0f94fa1079ba2` |
| `hardcoreeng/account:v0.7.426` | 3,686 | 306 | `9c5b5a19cacb16190ef4004013df73fbdc66ef0d50d448d660498d657f216392` |
| `hardcoreeng/hulykvs:v0.7.426` | 3,249 | 91 | `db6923e15ec1f1c9aba5529659cfacc33883ae5633bfe85e0f310a58e29e0e00` |
| `hardcoreeng/transactor:v0.7.426` | 20,400 | 639 | `0f14e5beaa5b150adb3f459da46dcf762cbe2ccc84d40f6d58a38a9500c87de0` |
| `hardcoreeng/fulltext:v0.7.426` | 3,686 | 306 | `32b96dbd154bc9bff09534b6337b2aa9105ea91a8e877252801b33104dcda09a` |
| `nginx:1.21.3` | 3,537 | 135 | `9a40221131260c60a5e4f270f95d7fe6c590f79409dc27a6624dbaf319a41a19` |
| `hardcoreeng/workspace:v0.7.426` | 3,686 | 306 | `bc42f293362829586f0a0b3aea6478dec128026e6b36894fd5961b0086c4f98f` |
| `hardcoreeng/rekoni-service:v0.7.426` | 20,580 | 665 | `728673409fd788e15b98f5a3146c7ac05aa07562e59bae3341318018c4111d44` |
| `hardcoreeng/collaborator:v0.7.426` | 3,686 | 306 | `b0eccaf62969d9f1c2f817faa82725def834e1fe6dd2b6a179447ea7d420420e` |
| `minio/minio` | 806 | 24 | `2757ea7e6726c8810bec7b3ce3d30ecbca9c220e2120930a56b28b42bb8fb69e` |
| `hardcoreeng/stats:v0.7.426` | 3,686 | 306 | `f8a873e1cc4a5c93e1023e4f3c9c365654997ff550e3152b36a8a59526957ac0` |
| `docker.redpanda.com/redpandadata/redpanda:v24.3.6` | 3,684 | 122 | `3a449e2b467102163cb4d7daac6d9e7a75002e8fce19e86f2323c5d59691a91c` |
| `hardcoreeng/front:v0.7.426` | 20,416 | 647 | `9973b8f221ee9ca48fb09f38a658cdc22c275dfcd0f82f7fefbb21b6e4b7f233` |

## 需人工复核的镜像发现

- Elasticsearch 7.14.2 镜像内的 Elasticsearch 核心和多个插件声明 `SSPL-1.0`。必须单独确认服务提供、修改和分发场景下的义务。
- Debian 图像处理链中识别到 `libwmf`/`libwmflite` 的 `AGPL-3.0-only` 元数据；大量基础系统包还含 GPL/LGPL 声明，需要形成镜像交付通知与源码提供流程。
- `@img/sharp-libvips-linux-arm64@1.2.0` 在实际镜像中被识别为 `LGPL-3.0-or-later`，说明平台 optional 依赖在目标架构命中后不能忽略。
- 源码目录中标出的 `ua-parser-js@2.0.6`、`@cryptography/aes@0.1.1`、`@livekit/krisp-noise-filter@0.3.4` 未被本次 Syft 镜像扫描识别。可能是未进入部署物、被打包后不可识别或扫描盲区，需结合构建依赖图确认，不能直接判定不存在。

## 闸门结论

14 个锁定镜像均已生成完整本地 SBOM，复现入口为 `SYFT_BIN=/path/to/syft pnpm huly:image-sboms`。项目负责人于 2026-09-02 接受已知风险并批准继续 Phase 0 技术开发，基线决策改为 `go`；生产发布前仍必须完成正式法务/合规复核。
