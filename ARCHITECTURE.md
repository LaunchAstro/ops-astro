# Architecture

The application is planned as a container package with an organisation-owned
database. The foundation has no product implementation. The
[current decisions](docs/current-decisions.md) distinguish selected direction
from proposals and pending proof.

## Product structure

| Responsibility              | Planned home               | State     |
| --------------------------- | -------------------------- | --------- |
| Runtime and agent execution | `packages/core-runtime`    | Not built |
| Records engine              | `packages/core-records`    | Not built |
| Credential broker           | `packages/core-custody`    | Not built |
| Provider operations         | `packages/core-connectors` | Not built |
| Shared interface components | `packages/ui`              | Not built |
| Web application             | `apps/web`                 | Not built |
| Worker                      | `apps/worker`              | Not built |
| Declarative presets         | `presets`                  | Not built |

The directories are placeholders. Development scripts and their tests exist;
an empty product build does not verify any row above.

## Runtime and data

TypeScript, React, Vite, and Hono are the selected application baseline.
Supabase/Postgres owns operational records. Supabase Auth is the first login
provider behind the product's permissions contract. A person remains in the
business record when their login is removed.

Tasks use the fixed-slot records engine. Human tasks remain separate from
machine runs and steps. Permissions are resource- and action-specific;
assignment and clearance alone never grant access. Each business has a
structural isolation boundary across database relationships and derived keys.
See the [stack](docs/adr/0019-app-layer-vite-react-hono.md),
[records](docs/adr/0030-fixed-typed-slots-no-runtime-ddl.md), and
[identity and permissions](docs/adr/0014-business-id-on-every-table-and-key.md)
decisions.

## Execution and review

A gate definition creates an instance against a versioned proposal. An
append-only decision records the authorised response. Execution checks current
permission, approval freshness, and the available budget before an effect.
Revisions retain valid completed work and prior costs. Rejection stops work
until an authorised restart.

A small execution module owns claim, apply, and settlement. Recovery must not
introduce a second effect. An uncertain external result stays uncertain until
reconciled. The execution graph projects stored facts and grants no authority.
See the [task and gate contract](docs/adr/0013-gate-triple.md).

The credential broker, egress controls, sandbox, and database roles provide
containment. A human decision alone provides no process isolation. The
[sandbox approval hold](docs/adr/0048-sandbox-launcher-contract-drafted-reviewed-not-built.md)
applies before its implementation.

## Knowledge, diagnostics, and analytics

Postgres is the canonical knowledge store. The document-body format remains
open for rich-document fidelity review. A Markdown export is a projection,
with no implicit writeback.

Langfuse is selected for optional diagnostic tracing. It does not own task
state, decisions, or budget enforcement. Its ClickHouse schema and credentials
remain separate from business analytics. The initial data design must name
both roles, their access rules, retention, and recovery. No deployment or
integration is proven here. See the
[knowledge](docs/adr/0031-postgres-canonical-knowledge.md) and
[tracing decisions](docs/adr/0069-tracing-and-analytics.md).

## Shared contracts and acceptance

[Design-system ownership](docs/design-system.md) and the
[capability-map contract](docs/capability-map.md) are foundation contracts.
Transfer only the shared components needed by the first product slice, then
prove their behaviour and visual fidelity. The typed registry and independent
code-discovery checks start with that transfer. Neither exists as a working
product feature in this foundation.

Use these evidence states consistently: **not built**; **written, not
applied**; **built, not enabled**; **live, verified against a named revision
and environment**. A test of a fixture does not change a production component's
state. Missing operational facts must remain visibly missing.
