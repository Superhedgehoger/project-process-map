# P0-02 Huly 自托管复跑证据

- 验证日期：2026-09-02
- Huly Platform：`ccefccd8d0361d3c8612d508071b777aa833826d`（`v0.7.426`）
- Huly Selfhost：`865584594cc582d9e0f7013be66c22f153df1176`
- 主机：Apple Silicon，10 CPU，Docker 可用内存约 8.22 GB
- 镜像：14 个 Linux ARM64 平台 digest

## 结果

| 运行 | 隔离方式 | 本地入口 | 结果 |
|---|---|---|---|
| A | 独立 Compose 项目、配置、密钥与 volumes | `127.0.0.1:8087` | 14 个容器运行，HTTP 200，登录页真实渲染 |
| B | 第二个干净 Selfhost worktree、独立项目与新 volumes | `127.0.0.1:8088` | 14 个容器运行，HTTP 200；除 KVS 启动阶段外无重启 |

两次环境均已执行 `down`，只停止并移除容器与网络，保留验证 volumes；没有创建业务账号或写入用户数据。

## 健康与已知现象

- Elasticsearch、MinIO、Redpanda 的 Compose 健康检查最终通过。
- Huly 前端经 Cindy 浏览器真实打开，登录、注册、验证码登录与访客入口可见。
- KVS 在首次等待 Cockroach 初始化时重启 5 次，数据库就绪后稳定；第二次复跑也出现同一启动竞争，因此保留为后续稳定性观察项。
- 上游 Redpanda 健康检查提供 SASL 凭据，但服务启动参数未启用 SASL，导致健康假阴性。本地 digest override 只把验证命令替换为无凭据 `rpk cluster info`，不代表生产安全决策。
- Account/Front 日志提示容器内 `STATS_URL=http://localhost:8087/_stats`，本轮核心登录页不受影响，但生产部署前必须核对容器内地址。

## 可重复命令

默认实例：

```bash
pnpm huly:up
pnpm huly:ps
pnpm huly:down
```

第二个隔离实例：

```bash
HULY_SELFHOST_DIR=artifacts/huly/huly-selfhost-replay \
HULY_INSTANCE_NAME=project_process_map_p0_b \
HULY_HTTP_PORT=8088 \
pnpm huly:up
```

`tools/huly-local.sh` 会拒绝非锁定 commit，生成本地权限收紧的密钥文件，并叠加 `infra/huly/compose.digest.arm64.yml`。它是开发验证入口，不是生产部署脚本。

## 闸门结论

P0-02 的两次运行证据已经具备，但产品计划规定 P0-02 必须在 P0-01 通过后验收。由于许可证与镜像级软件清单仍待复核，状态保持“证据就绪，等待前置闸门”，不提前标记完成。
