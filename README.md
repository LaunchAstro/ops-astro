# Ops Astro

By Launch Astro.

Pre-alpha foundation for a portable organisational system: records, knowledge,
tasks, and agent work with explicit human decisions before consequential actions.
Organisations retain control of their data and provider accounts.

Nathan Mulligan maintains this project and accepts responsibility for merged
changes. AI agents assist with authoring. [AI policy](AI_POLICY.md) defines
attribution and independent review.

## Status

The tree holds a local task slice a person can start and use on their own
machine: a React and Vite web application, a Hono API that runs as TypeScript
source under Node 24, a real local Postgres with the tenancy and record
migrations applied, a Supabase Auth (GoTrue) adapter for sign-in, and
fixed-slot task records. Sign in, create a task, assign it, change its state
and reload, and the saved result is still there, because it is in Postgres.

Nothing is deployed and nothing is released. There is no installer, no hosted
service, and no published package. The proposed L1-L6 sequence is not
complete. Local tooling checks prove that this checkout builds, types, lints
and passes its own tests. They prove nothing about a hosted deployment or
hosted enforcement, and neither does a green `pnpm check`. Outside
contributions remain closed.

The proposed sequence is foundation, tasks and basic approval, agent work,
Docs, richer review, then CRM. [The local slice](docs/local/README.md) marks
the edge of what is built. It says what the slice does, which command proves
each part, and where it falls short.
[Current decisions](docs/current-decisions.md) carries the direction it was
built against. The
[first task specification](docs/plan/first-task.md) is the earlier 8 September
proposal and differs from what was built, so read it as history.

## Run the local slice

[The local slice](docs/local/README.md) has the prerequisites, the start
sequence, the local address, where the synthetic credentials live, the verify
commands, and the exact limitations. In short, with Node 24, pnpm through
corepack and Docker present, run `corepack pnpm install`, then

```
corepack pnpm db:up && corepack pnpm db:migrate && corepack pnpm auth:up \
  && corepack pnpm auth:seed && corepack pnpm db:seed
```

then `corepack pnpm api:up` and `corepack pnpm web:up`. Everything it starts
is a container or a process on a loopback port of your own machine.
`corepack pnpm build` builds the web bundle. It packages and deploys nothing.

## Start here

- [Architecture](ARCHITECTURE.md) describes the selected stack and what remains unbuilt.
- [Vocabulary](CONTEXT.md) defines the domain terms.
- [Contributing](CONTRIBUTING.md) explains the single build and review workflow.
- [Plan and evidence](docs/plan/README.md) separates decisions from proof still outstanding.
- [Security](SECURITY.md), [governance](GOVERNANCE.md), and [support](SUPPORT.md) state the project's policies.

## Check the foundation

Use the Node major in `.nvmrc`, the pnpm version in `package.json`, Python
3.11 or newer, Git, and Gitleaks. Install the pinned development dependencies
in a working checkout, then run `corepack pnpm check`. Gitleaks is a
prerequisite because `pnpm check` runs it over the working tree, along with
the public-content policy. The separate full-history scan stays in continuous
integration. The public-content step reads the staged tree, so stage your
changes before running it.

[Local verification](docs/plan/local-verification.md) explains how to check
and export an exact candidate without creating a commit. Hosted and runtime
proof remain separate.

## Product name

[product.json](product.json) holds the public name. To change it, update that
file and run `corepack pnpm brand:sync`, then `corepack pnpm check`.
[Product identity](docs/product-identity.md) separates branding from technical
identifiers and deployment addresses.

## Licence

The project is AGPL-3.0-only. [LICENSE](LICENSE) contains the complete text,
and [NOTICE](NOTICE) records third-party attribution. The
[preset and skill exception](LICENSE-EXCEPTIONS.md) is drafted and ungranted.
The [contributor agreement](CLA.md) is also a draft. Legal review remains
outstanding. [Licensing](LICENSING.md) describes the intended boundaries.
