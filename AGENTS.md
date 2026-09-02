# Repository working agreement

## Product baseline

- Product baseline: PRD V1.3, functional contract FC-1.2, change record CR-001.
- The source documents are recorded in `docs/product-baseline.md`.
- Authority order: approved product decisions → functional contract → data and permission rules → approved ADRs → UI specification → backlog.
- Generated designs and code are proposals until tests and acceptance evidence pass.

## Phase 0 boundaries

- All Huly access goes through adapter interfaces. Domain code must not import Huly SDK types.
- A business fact has one authoritative source. Do not create Huly/product-domain dual writes.
- Keep the physical database, graph library, realtime mechanism, Task authority and sensitive ACL undecided until Phase 0 evidence is reviewed in ADRs.
- Cross-Huly operations use idempotent sagas and compensation; do not imply distributed atomicity.
- Core local commands write domain state, domain events and outbox messages in one transaction boundary.

## Changes and verification

- Work on one backlog item or one small vertical path at a time.
- Add or update tests with behavior changes.
- Run `pnpm check` before handoff.
- Never commit credentials, Google login data, Huly secrets or production personal data.
- Huly patches must record upstream commit, reason, regression coverage and removal condition.

