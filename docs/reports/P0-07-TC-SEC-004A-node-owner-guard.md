# P0-07 / TC-SEC-004A ProjectNode 负责人 (Node Owner / U2) 领域模型与敏感安全守卫

- 日期：2026-09-14
- 状态：ACCEPTED / DONE（Codex R2 Cycle 6 Final Verdict: PASS）
- 风险评级：R2 PASS（残留风险 Low）
- 产品依据：PRD V1.3（第 67–68、72、164 行）、FC-006、FC-013、规格 03 第 3.2、3.3、5.1、5.3、5.4、11 节
- 架构依据：ADR-003、ADR-004、ADR-005、ADR-006、ADR-008
- 测试身份：U2（普通节点负责人）、U1（普通成员）、PM（项目经理）、U0（非成员）、U3（无权项目经理）

## Cycle 6 最终验收结论（Codex R2 Final Verdict: PASS）

- **最终评审结论**：**PASS**（准予提交与合并）
- **复审证据链**：
  - 定向 Finding 5 独立回归：**1/1 通过**（Memory 与 SQLite 双引擎 v9 历史回执非空负责人重放严格拦截、null/omitted 平滑向上转型、零副作用断言通过）；
  - 定向完整安全套件（`tests/node-owner.test.ts` 20/20 + `tests/task-upgrade-compatibility.test.ts` 6/6）：**26/26 通过**；
  - 独立 Lead 全量门禁（`pnpm check`）：**218/218 通过**，TypeScript 类型检查 clean（0 error），Huly 14 个 ARM64 镜像锁与 4 个扩展包校验通过（14/4 通过）；
  - 格式与代码差异检查：`git diff --check` Clean（无多余空白与冲突标记）；
  - 凭据扫描：0 凭据、私钥或密钥泄漏；
  - 残留风险评估：**Low**。生产 Huly 协同收敛保持 fail-closed（超出本切片范围，由既有架构守卫妥善隔离）。

## Cycle 5 Rework 核心闭环项（Single Narrow HIGH）

1. **v9 创建回执非空负责人重放严格拦截（Legacy Create Receipt Non-Null Leader Replay Guard）**：
   - 修复 Memory `persistence.ts`（第 388-391 行）与 SQLite `persistence.ts`（第 234-237 行）中 `v9Fingerprint` 回退机制的越权漏洞：`v9Fingerprint` 回退仅当传入 `command.leaderPrincipalId === null || command.leaderPrincipalId === undefined` 时才允许生效。
   - 若针对历史 v9 回执以相同幂等键重放并传入非空负责人（即使候选人完全符合 active user / active member 资质），严格拦截并抛出 `ApplicationError("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD")`。绝不返回 `replayed: true`，绝不分配负责人，事务彻底中止，绝不修改节点、不追加事件、不出队 Outbox、不修改回执、不消耗项目序列号。
   - 既有当前指纹计算行为保持完全不变，合法 v9 null 负责人向上转型（upcast null）兼容性完整保留。

2. **Memory + SQLite 双引擎回归测试矩阵**：
   - 在 `tests/node-owner.test.ts`（Finding 5）中针对 SQLite 与 Memory 分别建立初始 v9 历史回执与 null 负责人节点基线：
     - (a) 验证 null 负责人及省略（undefined）负责人的重放均成功并平滑向上转型为 `leaderPrincipalId: null`，返回 `replayed: true`；
     - (b) 验证以相同 idempotencyKey 传入非空合法候选人负责人（`leaderU2`）时，被精准拦截并抛出 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`；
     - (c) 验证拦截后零副作用：断言拦截前后 `node`（`leaderPrincipalId` 仍为 null、版本不变）、`receipt`（指纹不变）、`events` 计数、`outbox` 计数与 `projectSequence` 完全一致。

## Cycle 4 Rework 既有闭环项（持续保持有效）

1. **可信时间修复（Trusted Time at Authorization Time）**：
   - 修复 Memory `persistence.ts` 与 SQLite `persistence.ts` 在 `executeAssignNodeLeader` 中敏感域 Grant 判定误传 `command.occurredAtUtc` 的问题，全面改用持久化/事务可信时间 `this.nowUtc()`。
   - 在 `tests/node-owner.test.ts` 中增加回归用例（Grant 在伪造回拨的 `occurredAtUtc` 与当前受信任时间之间过期），证明伪造回拨时间无法绕过过期 Grant，鉴权严格 fail-closed 返回 404 `NODE_NOT_FOUND`。

2. **迁移 Oracle 修复与 U0/U1/U2/U3 等价矩阵（Migration Oracle Prevention）**：
   - 修复 Memory 与 SQLite 中 `assertProjectSecurityStable` 位于操作者身份/角色隐蔽及敏感 Grant 鉴权之前的判定倒置缺陷。
   - 调整判定顺序：先验证操作者是否为同租户、激活状态的项目经理，并在敏感节点下验证是否具备 `edit` 权限；若未满足，一律隐蔽返回 404 `NODE_NOT_FOUND`。
   - 确保 U0（非成员）、U1（普通成员）、U2（无 Grant 负责人/非 PM）、U3（无 Grant 项目经理）无法探测敏感节点是否处于迁移中（与不存在节点的 404 响应完全一致，经由 `assert.deepEqual` 断言响应体等价）；只有具备有效 Grant 的已授权 PM 才会获得 409 `SECURITY_MIGRATION_IN_PROGRESS`。

3. **创建节点幂等重放陈旧节点修复（Create Replay Stale Node Revalidation）**：
   - 修复 `executeCreateNode` 幂等回执重放时仅读取节点而未核验状态的缺陷：重放时通过 `transaction.nodes.get(command.nodeId)` 重新加载权威节点，严格核验节点存在、未被软删除（`deletedAtUtc === null`）、租户与项目匹配、父节点/标题/类型/安全域/纪元未发生漂移。
   - 重新校验调用者身份激活状态及 active `project_manager` 角色。
   - 在 Memory 与 SQLite 中增加针对软删除（`NODE_NOT_FOUND`）、状态漂移（`NODE_NOT_FOUND`）与操作者降级（`FORBIDDEN`）的重放负向用例。

4. **强化故障注入断言（Strengthened Failure Injection Assertions）**：
   - 针对 `executeAssignNodeLeader` 4 个故障注入点及 `executeCreateNode` 6 个故障注入点，全面增加回滚断言：核验故障发生后节点状态无部分修改、幂等回执未写入、事件计数（`events`）未递增、Outbox 计数（`outbox`）未递增、项目序列号（`projectSequence`）未消耗。

## Cycle 3 (Final Attempt 3/3) Rework 既有闭环项（持续保持有效）

1. **彻底消除所有公共底层变更权限（Zero Public Raw Mutation Authority）**：
   - 彻底删除 `getMemoryNodeLeaderMutator` 与 `getSqliteNodeLeaderMutator` 导出函数，禁止任何模块/调用方获取底层原始变更权。
   - 从 `ProductionSqliteBundle`、`TestMemoryBundle` 与 `TestSqliteBundle` 中彻底移除 `nodeLeaderMutations` 属性；彻底从应用层端口中删除 `NodeLeaderMutationRepository` 接口。
   - `executeCreateNode` 与 `executeAssignNodeLeader` 直接收敛为 `Persistence` 接口方法（`persistence.executeCreateNode` 与 `persistence.executeAssignNodeLeader`），由适配器内部私有方法 `#mutateNodeLeader` 在事务内原子调用，不再接受任何调用方传入的 mutation repository，彻底杜绝伪造仓储或绕过审计事件的途径。
   - 杜绝跨实例 A 事务 / B 自动提交破坏：每个 `Persistence` 实例独立封装事务与连接，跨实例操作其他实例节点严格隔离并 fail-closed（`NODE_NOT_FOUND`）。

2. **泛型 `nodes.insert` 拦截非空负责人（Generic Insert Non-Null Leader Guard）**：
   - 在 Memory 与 SQLite 泛型 `nodes.insert` 边界显式拦截 `node.leaderPrincipalId !== null`，直接抛出 `ApplicationError("NODE_LEADER_DIRECT_INSERT_FORBIDDEN")`。
   - 受保护创建命令 `executeCreateNode` 统一先以 `leaderPrincipalId: null` 插入节点（v1）并发布 v1 `node.created` 领域事件；若初始指定非空负责人，则在同一事务内经过 PM 鉴权与候选人校验后，通过内部私有原子赋权升至 v2，发布经审批的 v1 `node.leader_assigned` 领域事件、Outbox 消息与幂等回执。

3. **动态模块导出检查与架构探针加固**：
   - 自动化测试动态导入 `memory/persistence.ts`、`sqlite/persistence.ts` 及 `production-bundle.ts`，断言没有任何包含 `/mutat/i` 的导出符号，确保无任何 mutator 泄漏。
   - 验证 `ProductionSqliteBundle`、`TestMemoryBundle` 与 `TestSqliteBundle` 仅暴露受保护的 `createNode` 与 `assignNodeLeader`，不暴露任何底层原始仓储或变更新入口。

4. **U0/U1/U2/U3 节点详情隐蔽响应体 `assert.deepEqual` 完全等价**：
   - HTTP Product API 针对 U0（非成员）、U1（普通成员）、U2（无 Grant 负责人）、U3（无权项目经理）请求敏感节点详情时，测试使用 `assert.deepEqual` 严格对比响应 JSON，证明与不存在节点的 404 响应完全一致。

5. **迁移开放期全量节点插入无条件冻结（Gate Blocker Resolution）**：
   - `nodes.insert` 最外层无条件检查活跃迁移开放状态（`["active", "verifying", "retryable", "recovery_required"]`），受影响项目下所有节点插入（包括 `leaderPrincipalId: null` 与非空负责人）一律拦截并抛出 `SECURITY_MIGRATION_IN_PROGRESS`；非开放迁移状态（`planned`、`committed`、`rolled_back`）允许插入。

## Cycle 2 Rework 既有闭环项（持续保持有效）

1. **Task / File 权威职责与属主节点软删除即时失效**：
   - 普通节点仅 PM 或负责人可创建任务；敏感节点要求有效 Grant，否则严格返回 404 隐蔽响应。
   - 任务流转与附件上传重载属主节点，核验未软删除及域未漂移，失效统一返回 404 `TASK_NOT_FOUND`。

2. **真实多进程 SQLite v9→v10 迁移串行化**：
   - SQLite 迁移由 `BEGIN IMMEDIATE` 保护，设置 `busy_timeout = 10000`，两进程并发压力测试零竞争破坏。

3. **ADR-008 生产边界全量执行**：
   - `packages/domain/src/event-schema-registry.ts` 强校验 Schema 版本与黑名单字段，在真实写入边界拦截未知版本与敏感字段。

## 自动化验收证据

- **定向节点负责人与安全守卫测试**：`node --experimental-strip-types --test tests/node-owner.test.ts`
  - 结果：**20 passed, 0 failed, 0 skipped** (耗时 ~530ms)
  - 测试套件全量覆盖：
    1. `TC-TASK-005` ProjectNode 领域模型支持 `leaderPrincipalId` 与 helper 函数；
    2. `TC-TASK-005 / TC-SEC-004A` 项目经理创建节点指定有效负责人（正向用例）；
    3. `TC-TASK-005 / TC-SEC-004A` 非项目经理创建节点指定负责人被拦截（负向用例）；
    4. `TC-TASK-005 / TC-SEC-004A` 候选人资格校验矩阵（跨租户、未激活、撤销成员、服务身份、不存在者原子拒绝 `INVALID_NODE_LEADER`）；
    5. `TC-TASK-005 / TC-SEC-004A` `executeAssignNodeLeader` CAS 版本与置空验证；
    6. `TC-SEC-004A` RBAC ∩ Grant 双层授权交集矩阵与 404 权限隐蔽；
    7. `TC-SEC-004A` 敏感域最后管理员不变量零突破（U2 存在无法抵消最后管理员保护，无法写 Grant）；
    8. `TC-SEC-004A` SQLite schema v9→v10 升级、历史数据 null 回填、两连接并发 CAS 冲突与重启持久化；
    9. `TC-SEC-004A` 迁移期间写操作冻结与读取源/目标双 Grant 交集守卫；
    10. `TC-SEC-004A` 故障注入点（`after_aggregate`、`after_event`、`after_outbox`、`after_idempotency`）原子回滚；
    11. `Finding 1`: Trusted time - 授权与 Grant 到期使用事务可信时间，回拨时间安全拦截 404；
    12. `Finding 2`: Idempotent replay - 重放严格重验调用者、角色、Grant、软删除、候选人与迁移状态；
    13. `Finding 4`: Persistence bypass prevention - `tx.nodes.assignLeader` 为 undefined，直接调用报 TypeError；泛型 `nodes.insert` 拦截非空负责人（`NODE_LEADER_DIRECT_INSERT_FORBIDDEN`）；
    14. `Finding 5`: v9 receipt replay - 历史创建回执平滑向上转型，真实多进程并发 v9 迁移压力测试；
    15. `Finding 6`: ADR-008 schema registry - 事件架构定义、快照 fixture 与未知版本/敏感字段边界拦截；
    16. `Finding 7`: Last-admin invariant - U2 持有 permanent manage_access 仍无法豁免 PM 保护；
    17. `Finding 3`: Authoritative production wiring - HTTP Product API 针对 U0/U1/U2/U3 的端到端授权矩阵，普通节点 U1 403，敏感节点 U1 404 隐蔽，属主软删除后 Task/File 404 隐蔽；
    18. `Finding 4`: Initial non-null leader assignment - 原子发布事件、Outbox 与回执，全 6 个故障点原子回滚；
    19. `ARCH-PROBE / TC-SEC-004A`: 彻底消除底层变更新接口与导出函数，动态模块导出检查断言零 `/mutat/i` 符号暴露，生产与测试 Bundle 零 raw repository 暴露；泛型 `nodes.insert` 非空负责人拦截；跨实例 A/B 上下文隔离（对实例 B 变更实例 A 节点返回 404 `NODE_NOT_FOUND`）；真实 Memory 与 SQLite 生产级 `events.append` 与 `outbox.enqueue` Schema 拦截校验；
    20. `Finding 8`: Direct Memory and SQLite nodes.insert migration freeze matrix for null leader across all migration states（在 active / verifying / retryable / recovery_required 开放状态下，Memory 与 SQLite 的 nodes.insert 针对 null 负责人节点一律冻结拦截并抛出 SECURITY_MIGRATION_IN_PROGRESS；在 planned / committed / rolled_back 允许插入）。

- **全量生产机械门禁测试**：`pnpm check`
  - 结果：**218 passed, 0 failed, 0 skipped** (耗时 ~1.6s)
  - `pnpm typecheck`：通过（0 错误）
  - `huly:images`：通过（14 images）
  - `huly:extension:verify`：通过（4 packages）

- **静态与代码合规门禁**：
  - `git diff --check`: Clean，无空白问题与冲突标记。
  - 凭据扫描：无硬编码密钥、私钥或凭据泄漏。
  - Git 状态：未暂存、未提交、未推送。

## 明确未做（Non-goals）

- 未实现 `TemplateRoleSlot` 与 `ProjectRoleBinding` 模板角色槽位（归属 TC-SEC-004B）。
- 未实现任务验收人三级解析连调逻辑（归属 TC-SEC-004B / P0-05A-T1b）。
- 未伪造或引入 U7 组织管理员或 U8 紧急访问模型（归属 TC-SEC-004D / TC-SEC-004C）。
- 未改动交付物守卫与任务验收状态机（P0-05A）。
- 未改动地图前端 UI。
