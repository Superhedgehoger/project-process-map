# ADR-002：无 Docker 的 SaaS 运行与发行边界

- 状态：Accepted
- 日期：2026-09-03
- 关联：CR-002、P0-ND-01

## 背景

已有 Huly Phase 0 证据来自 Docker Compose 的隔离自托管环境，Product API 与 Worker 只从 TypeScript 源码启动。项目负责人新增了明确交付约束：最终产品必须是 SaaS 和可运行程序，正式链路不能依靠 Docker。

## 决定

采用“双轨但不双写”的运行策略：

- 产品运行轨：Product API、Worker 与浏览器入口必须能够从版本化原生发行包启动，不引用 Docker 命令或 Compose 服务发现。
- 上游验证轨：锁定 Huly 的容器环境可以继续用于开发和回归，只作为 Adapter 证据，不作为生产拓扑。
- P0-ND-01 使用 Node.js 24 的平台无关 JavaScript 发行包验证产品进程；SaaS 通过 `HOST`、`PORT` 和显式环境配置绑定，由外部进程监督器管理。
- Huly、数据库、对象存储和消息能力不得被偷偷打包成不可维护的单进程。P0-ND-02 必须逐项决定采用托管服务、原生服务进程或替代实现。
- 浏览器入口由 Product API 同源提供，并保持为单个自包含 HTML，避免额外静态站点部署依赖。

## 约束

- Domain code 继续不导入 Huly SDK 类型。
- Huly 调用继续通过 Adapter 和幂等 Saga，不因部署方式变化产生双写。
- 监听地址默认 `127.0.0.1`；SaaS 环境必须显式设置 `HOST=0.0.0.0` 并在受控反向代理/TLS 后暴露。
- 发行包必须带版本和 SHA-256；生产前补齐签名、SBOM、升级/回滚与 clean-machine 证据。
- 内存实现只用于可行性验证，不能用于正式环境。

## 结果

P0-ND-01 可以不启动 Huly 或 Docker 即验证产品页面、API、Worker 与现有 Node → Task 逻辑。代价是现阶段还不能声称完成生产 SaaS：持久化、身份、租户隔离以及 Huly 原生运行策略都被显式保留到 P0-ND-02 和后续 ADR。

## 替代方案

- 继续以 Compose 作为唯一交付：违反 CR-002，拒绝。
- 直接承诺单一桌面可执行文件：与现有多进程服务及 SaaS 目标不匹配，拒绝在无产品形态决定时承诺。
- 立即重写全部 Huly 能力：Phase 0 证据不足、风险过大，暂不采用。
