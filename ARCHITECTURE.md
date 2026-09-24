# Architecture

The application is planned as a container package with an organisation-owned
database. Part of it now exists as a local task slice.
[The local slice](docs/local/README.md) describes what that slice does, what
proves it, and where it falls short. The
[current decisions](docs/current-decisions.md) separate selected direction
from proposals and pending proof.

Read the state column below as implemented and tested on one machine. No
review of the integrated head has been recorded, so nothing here is accepted.

## Product structure

| Responsibility              | Home                       | State                                                                                                             |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Runtime and agent execution | `packages/core-runtime`    | Propose, decide, pick up, hand back and the recovery classifier, with tests. Nothing dispatches and nothing acts. |
| Records engine              | `packages/core-records`    | Tenancy, identity, authority, fixed-slot records, task commands and reads, with tests.                            |
| Credential broker           | `packages/core-custody`    | Not built                                                                                                         |
| Provider operations         | `packages/core-connectors` | Not built                                                                                                         |
| Shared interface components | `packages/ui`              | Primitives, state, styles and the slice's surfaces, with tests.                                                   |
| HTTP boundary               | `apps/api`                 | Hono, one route per declared command, with tests.                                                                 |
| Command line                | `apps/cli`                 | A client of that same API, holding no privileged path.                                                            |
| Web application             | `apps/web`                 | React and Vite: sign-in, task list, task detail, comments and settings, with tests.                               |
| Worker                      | `apps/worker`              | Not built                                                                                                         |
| Declarative presets         | `presets`                  | Not built                                                                                                         |

The four rows marked not built are empty directories holding only a
`.gitkeep`. The rest are source with tests beside them, run against a real
local Postgres on one machine. [The local slice](docs/local/README.md) holds
the commands, the evidence and the limits. A green tooling run proves this
checkout builds, types, lints and passes its own tests. It proves nothing about
a deployment, and there is no deployment.

No provider dispatch and no worker effect exist. The runtime makes no
provider call: `planned_steps.dispatched_at` carries a constraint keeping it
null, and an attempt names no provider and no model. An earlier proposal
described a deterministic worker that performs one local effect. That part
was not built. [The runtime](docs/local/RUNTIME.md) says where the seam is.

## Runtime and data

TypeScript, React, Vite, and Hono are the selected application baseline.
Supabase/Postgres owns operational records. Supabase Auth is the first login
provider behind the product's permissions contract. A person remains in the
business record when their login is removed.

Tasks use the fixed-slot records engine. Human tasks remain separate from
machine runs and steps. Permissions are resource- and action-specific;
assignment and clearance alone never grant access. Each business has a
structural isolation boundary across database relationships and derived keys.
All four hold in the tree. [The data layer](docs/local/DATA.md) has the slots,
the migrations and the tenancy suites, and
[authority](docs/local/AUTHORITY.md) has the credential, membership and grant
model the API resolves against.

A command's facts are one `COMMAND_SURFACE` row
(`packages/core-records/src/commands/surface.ts`): its authority target,
expected-revision rule, `untargetedIdentifiers`, `runtimeShaped` and `agent`
reach. `prepare.ts` reads the row. The handlers are a typed table keyed by the
same name (`HANDLERS` in `commands/handlers.ts`), kept off the row because the
web client imports the surface. A read's facts are one `READ_CATALOGUE` row
(`reads/catalogue.ts`): identifiers, operand check (`parse`), spine, subject,
authority mode, outsider-not-found and serve. A row is a `SpineRow`, handed the
task spine and its subject, both read before the grant check, or a
`BusinessRow`, handed neither. `reads/dispatch.ts` runs one pipeline over the
row. See the [stack](docs/adr/0019-app-layer-vite-react-hono.md),
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

`packages/core-runtime` implements that shape as five transactions and a
recovery classifier, described in [the runtime](docs/local/RUNTIME.md). The
effect at the end of it does not exist. Work is claimed under a fenced lease
and handed back, and nothing is dispatched to a provider.

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
prove their behaviour and visual fidelity. The components the slice needs have
been transferred into `packages/ui` with tests. The typed registry and the
independent code-discovery checks have not been built, so nothing enforces the
contract yet.
[The web application](docs/local/WEB.md) records the visual gaps that remain
against the pinned mockup.

Use these evidence states consistently: **not built**; **written, not
applied**; **built, not enabled**; **live, verified against a named revision
and environment**. A test of a fixture does not change a production component's
state. Missing operational facts must remain visibly missing.
