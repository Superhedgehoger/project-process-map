# Phase 0 状态

更新日期：2026-09-02

| 任务 | 状态 | 当前证据 | 下一闸门 |
|---|---|---|---|
| P0-01 Huly 基线 | 进行中 | HEAD、迁移、Node 22、源码与 14 镜像 SBOM、ARM64 digest、2,887 项 npm 许可证声明已核对 | 人工复核未解析项、强 copyleft、SSPL 与自定义条款 |
| P0-02 自托管环境 | 证据就绪，等待前置闸门 | 两个隔离实例均以 14 个 digest 镜像启动并返回 HTTP 200；登录页完成真实浏览器渲染 | P0-01 许可证复核通过后正式验收 |
| P0-03 API/Worker/Adapter | 预备骨架已验证 | API `/health`、Worker、内存 Adapter、5 项测试 | P0-02 后连接真实 Huly 环境复验 |

## 启动条件

- [x] 已登记 Huly Platform 与 Selfhost 完整 commit 候选
- [x] 可重复的 Huly 自托管部署说明与 ARM64 镜像锁
- [ ] 普通成员、无敏感权限成员两组测试身份
- [x] 200 节点、300 关系、2,000 任务的脱敏数据生成器
- [x] 最小签字模板 fixture
- [x] 源码仓库、工作约定与验证命令
- [x] GitHub Actions CI 入口

P0-03 的代码当前只是无外部依赖的预备骨架，不能绕过 P0-01/P0-02 宣称技术闸门通过。

当前 P0-01 差异详见 `docs/reports/P0-01-source-audit.md`；部署复跑见 `docs/reports/P0-02-selfhost-replay.md`。P0-02 虽已有运行证据，仍按依赖顺序等待 P0-01 正式通过。
