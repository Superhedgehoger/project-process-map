# P0-07 / TC-SEC-002I Asset/Blob 内容下载的迁移期权限交集

- 日期：2026-09-10
- 状态：独立安全 Review PASS；通过子切片验收；P0-07 总项保持进行中
- 架构依据：ADR-005、ADR-006、ADR-007
- 前置依据：TC-SEC-001、TC-SEC-002A～H、TC-SEC-003A/B/C、ARCH-GATE-ASSET-001～005

## 本切片交付

- 新增 `GET /api/assets/{assetId}/content` 与独立 application 下载服务，只接受租户、principal 与产品 Asset ID，不接受客户端 Blob/Huly reference。
- 下载要求同租户 Asset 为 available 且未删除、owner Node 有效、调用者通过 TC-SEC-002H 的逐对象 view 交集、`blob_replica` 为同步完成的本地权威绑定。
- `AssetContentPort` 增加 tenant-aware reference ownership 判定；Memory 持有 tenant 元数据，Filesystem sidecar 持久 tenant，foreign-tenant 与旧 tenantless sidecar 均 fail-closed。
- 内容读取前验证 binding、tenant ownership、元数据/reference/scan state/content type/size/SHA-256，读取后再次验证元数据、字节哈希，并重新授权、比较 Asset 与 binding 快照。
- 所有不存在、无权、不可下载、binding/content/owner/完整性或竞态失败统一为最小 `404 NOT_FOUND`，不返回 displayName、hash、size、authority reference、迁移状态或内部错误。
- 成功响应固定 `Content-Disposition: attachment`（无用户文件名），并设置 `no-store`、`nosniff` 与精确长度；HTML 等主动内容不会作为内联同源页面渲染。
- 未修改上传、扫描、删除、Huly 投影、ZIP/导出、搜索、通知、实时、迁移写或 committed。

## 自动验收证据

- 普通 Asset 与迁移 source/target 两侧的双域授权下载返回精确字节；source-only 在两侧均得到同一 404。
- 双租户测试把 tenant A 的真实 reference 替换进 tenant B 的匹配 Asset/binding，仍由持久 tenant ownership 拒绝；Filesystem 重启保留归属，legacy tenantless sidecar 拒绝。
- initiated/uploading/scanning/quarantined/failed/deleted，missing content、metadata/hash/bytes/binding 漂移均返回与 missing Asset 相同的最小失败。
- Principal、Asset 与 binding 在内容读取中变化均由二次授权/快照检查 fail-closed；未宣称文件系统与数据库跨资源强一致。
- 畸形编码 Asset ID 也收敛为下载专用最小 404；HTML 响应验证 attachment/no-store/nosniff。
- 独立安全 Review 首轮 BLOCKER 指出 tenant ownership 不可证明、主动内容可内联渲染及负面矩阵不足；修复后复审 PASS。
- Lead 可复现定向组合 26/26；Worker 扩展组合 29/29；最终 `pnpm check`：TypeScript、150/150 测试、14 个 Huly ARM64 镜像锁与扩展边界全部通过。
- `git diff --check` 通过。
- 当前变更文件的凭据、API key 与私钥特征扫描无命中。

## 剩余项

- 数据库最终授权与 HTTP 发送之间仍有不可消除的小窗口；当前实现不宣称跨数据库、文件系统和网络的原子授权。
- tenant ownership 在读取前检查一次；当前 adapter 中 reference ownership 不可变，绕过端口直接篡改 sidecar 属物理存储越权边界。
- 下载集成复用 TC-SEC-002H 对 source↔public、四个开放状态、invalid root/domain 的直接测试，没有为每个组合重复 HTTP 用例。
- 搜索、通知、实时、ZIP/导出及外部协作投影仍未完成，Migration 不得 committed。

本片只验收单 Asset 本地内容下载通道，不宣称所有读取/外部通道或 P0-07 已完成。
