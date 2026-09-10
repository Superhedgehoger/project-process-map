# P0-07 / TC-SEC-002I：Asset/Blob 内容下载的迁移期权限交集

## 目标

在不扩展到 ZIP/导出的前提下，建立单个 Asset 内容下载路径：只有 Asset 可下载且调用者通过其 ownerNodeId 对应的当前授权时才能读取本地 Blob；迁移窗口内必须执行 source∩target，且不得泄露 Blob authority reference、文件存在性或迁移进度。

## 直接依据

- ADR-005：Asset 的迁移范围只由产品 ownerNodeId 与 Node.parentId 判断。
- ADR-006：active 至 committed 前，下载通道要求旧域与新域权限交集。
- ADR-007：Asset 生命周期、删除墓碑与 Blob 副本由产品域权威维护；只有 available Asset 可下载，删除立即拒绝。
- 已验收前置：TC-SEC-001、TC-SEC-002A～H、TC-SEC-003A/B/C、ARCH-GATE-ASSET-001～005。

## 必须保持的不变量

1. 下载授权只读取同租户 Asset、权威 ownerNodeId/securityDomainId/securityEpoch、正式 Migration 与本地 `blob_replica` binding；不得接受客户端 Blob reference 或 Huly Attachment 作为权威。
2. active/verifying/retryable/recovery_required 范围内必须用 TC-SEC-002H 的逐对象 view 交集；已迁/未迁一致，任一域、Grant、membership、principal、迁移根或 owner 链不可判定即 fail-closed。
3. 只有 lifecycleState=available 且未删除、内容元数据与 Asset 的 size/contentType/sha256 一致时才读取字节；scanning/quarantined/failed/deleted、binding/content 缺失或哈希漂移均不得返回内容。
4. 无权、Asset 不存在、不可下载或本地内容不可判定不得暴露 displayName、哈希、大小、Blob reference、迁移状态或内部错误细节。
5. 内容读取前后必须防止 ACL/Asset/Binding 状态竞态造成越权；若现有事务与文件端口无法原子覆盖，采用可复核的二次授权/版本校验并 fail-closed，不自行声称强一致。
6. 不改变上传、扫描、删除、投影、迁移对象写、Grant/Membership 或最后管理员规则；所有写路径继续冻结。

## 允许修改

- application Asset 下载查询/授权服务
- Product API 单 Asset 内容下载路由与必要响应支持
- AssetContentPort 的必要只读校验能力及 Memory/Filesystem adapter
- 直接契约、Memory/SQLite、文件系统与 API 测试
- Phase/Report/Evidence/checkpoint

## 明确不做

- ZIP、批量下载、导出、预签名 URL、Range/断点续传、缓存/CDN。
- 搜索、通知、实时或 Huly Blob/Attachment 直链。
- 上传/扫描/删除工作流变更、committed/rollback/recovery、事件/Outbox、UI。

## 验收

- 普通与敏感 Asset 只有 available 且授权时返回精确字节和受控 content type；authority reference 永不出现在响应。
- only-old、only-new、both、neither 在 source/target 当前归属上符合交集；source↔public、四个开放状态、撤权/过期/成员失效即时生效。
- 不存在、无权、不可下载、binding/content/hash 漂移均采用统一最小失败语义，不产生内容或元数据侧漏。
- 文件读取期间发生 ACL、Migration、Asset 或 binding 变化时 fail-closed；跨租户/项目/owner 与重启覆盖。
- `pnpm check`、独立安全 Review、Evidence、commit/push 后再选择下一读取通道。
