# P0-ND-01 无 Docker 原生发行验证

日期：2026-09-04（架构修正后复验）

结论：通过可行性闸门，不等同于生产 SaaS 验收。

## 交付内容

- `pnpm start`：从源码启动同一进程内的 Product API、Worker 与自包含浏览器入口。
- `pnpm build:native`：把应用与内部包编译为 JavaScript，生成 `project-process-map-0.0.1-node24.tar.gz`、启动器和 `SHA256SUMS`。
- `pnpm smoke:native`：校验 SHA-256，在系统临时目录解包，通过发行包启动，并验证健康、首页、六节点和任务创建。
- 浏览器入口与 CSS/JavaScript 均内联，不依赖同目录前端资源。

## 验证证据

本机验证结果：

```json
{"status":"ok","release":"project-process-map-0.0.1-node24.tar.gz","dockerInvoked":false,"verticalPath":"page -> nodes -> task -> asset + two-cycle review -> restart -> readback","persistence":"sqlite+filesystem"}
```

冒烟测试把一个必定失败并留下标记的伪 `docker` 命令放到 `PATH` 首位；启动、请求和停止结束后标记不存在。由此证明 P0-ND-01 产品发行路径没有调用 Docker。该证据不证明完整 Huly 已能脱离容器运行。

自动测试新增：

- 浏览器首页、CSP 与六节点集合契约。
- 显式验收人任务的开始、首轮提交、退回、再次提交、通过和重启后完整历史回读。
- Worker 独立启动、停止与配置校验。
- 编译、压缩包校验、临时目录启动和 HTTP 纵向冒烟。

## 已知边界

- 发行物需要 Node.js 24 或更高版本。
- 默认使用 SQLite 与文件目录；已验证重启回读，尚未完成备份/恢复演练。
- 已有可信 TenantContext 和持久外部身份映射，独立页面尚未实现正式 SaaS 登录界面。
- P0-07 通过前只允许 loopback 监听；非本机监听会在打开数据库和文件目录前失败，不能把当前可行性包当作公网服务。
- Huly 仍只在 Docker 开发验证轨运行，尚未形成原生生产拓扑。
- 未完成制品签名、发行 SBOM、systemd 单元、备份恢复、升级或回滚。

这些边界由 CR-002 明确留给 P0-ND-02，不能把本报告描述成最终 SaaS 已交付。
