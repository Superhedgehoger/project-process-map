# ADR-008：最小领域事件与 Schema 演进

- 状态：Accepted
- 日期：2026-09-04
- 关联：CR-003、P0-06、C3、D

## 决定

- 当前系统不是 Event Sourcing；事件用于集成、审计关联和回顾投影，不承担完整聚合恢复。
- 删除通用 `before/after` 整实体信封。每个事件 payload 只含消费者需要的最小字段，并有 `(eventType, schemaVersion)` 注册项、敏感字段清单和兼容 fixture。
- `eventType` 不携带版本后缀；发布 topic 组合为 `eventType.v{schemaVersion}`，避免双重版本。
- 通用事件禁止包含联系方式、凭据、文件名、正文、外部引用和完整业务对象。通知从权限过滤后的投影生成，不直接广播 Outbox payload。
- 消费者遇未知版本必须停在对应项目序列并告警/死信，不能猜测字段或越过水位；需要升级时使用纯 upcaster。
- AuditEntry、ReviewCycle 等合规历史独立追加保存，并按数据保留/加密擦除策略处理 PII。

## 验收

- 每个事件有 Schema 注册、当前 fixture 与明确的升级策略。
- N/N-1 消费兼容，未知版本不能推进 checkpoint。
- 静态和运行时测试拒绝禁入敏感字段；领域状态、事件和 Outbox 仍在同一工作单元提交。

