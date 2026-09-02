# P0-01 npm 许可证目录摘要

- 生成日期：2026-09-02
- 输入：Platform CycloneDX SBOM 中的精确 npm 名称与版本
- 元数据来源：npm 官方注册表
- 本地完整目录：`artifacts/huly/npm-license-catalog.json`（不提交仓库）
- 完整目录 SHA-256：`f2d4b6c6bf172f308977cf4f779c0221ba39227748190cf61a520eaba4399634`

## 覆盖结果

| 项目 | 数量 |
|---|---:|
| SBOM 去重后的 npm 名称/版本 | 2,889 |
| 成功取得注册表元数据 | 2,887 |
| 注册表查询失败 | 2 |
| 声明为 `UNKNOWN` | 18 |
| 许可证表达式含 GPL/LGPL/AGPL 或自定义条款 | 21 |

数量按“名称 + 精确版本”计数，同一包的不同版本分别保留。此目录记录的是包元数据中的声明，不是法律意见，也没有证明镜像中所有二进制与系统包均已覆盖。

## 主要声明分布

| 许可证声明 | 数量 |
|---|---:|
| MIT | 2,136 |
| Apache-2.0 | 332 |
| ISC | 170 |
| BSD-3-Clause | 71 |
| BSD-2-Clause | 51 |
| EPL-2.0 | 36 |
| UNKNOWN | 18 |
| LGPL-3.0-or-later | 10 |

其余声明各少于 10 项，完整分布保存在本地目录中。

## 必须人工复核

- 查询失败：`@hcengineering/platform-rig@UNKNOWN`、`@hcengineering/scripts@0.7.3`，npm 官方注册表均返回 404。它们可能是第一方工作区/私有包，但不能据此自动继承仓库根许可证。
- 强 copyleft：`ua-parser-js@2.0.6` 声明 `AGPL-3.0-or-later`，是 `packages/analytics-providers` 的直接依赖；`@cryptography/aes@0.1.1` 声明 `GPL-3.0-or-later`，由 `telegram@2.22.2` 传递引入。两者都不是 OR 双许可。
- LGPL：10 个 `@img/sharp-libvips-*` 平台包、4 个 `@img/sharp-*` 组合声明及 `libheif-js@1.19.8` 需要结合实际分发方式复核。14 个 Sharp 平台包在锁文件中是按 OS/CPU 选择的 optional 依赖，但目标平台实际命中的包仍需履约。
- 自定义条款：`@livekit/krisp-noise-filter@0.3.4` 指向 LiveKit 服务条款，在锁文件中是直接且非 optional 的依赖。
- OR 表达式：`jszip` 与 `node-forge` 等允许在多个许可证中选择，不能把字符串里出现 GPL 等同于只能采用 GPL。
- 18 个 `UNKNOWN` 必须回到对应包源码或随包许可证文件确认。

## 闸门结论

许可证发现流程已可重复执行：`pnpm huly:licenses`。当前结果足以进入人工审查，但不足以把 P0-01 标记为通过，也不能据此批准生产分发。14 个部署镜像的 SBOM 已另行生成：三个源码目录高风险项未被 Syft 在部署镜像中识别，但这不等同于证明其不存在；镜像同时发现了 Elasticsearch SSPL 和操作系统级 AGPL/GPL/LGPL 组件，详见镜像 SBOM 摘要。
