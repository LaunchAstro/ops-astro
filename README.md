# Ops Astro

By Launch Astro.

Pre-alpha foundation for a portable organisational system: records, knowledge,
tasks, and agent work with explicit human decisions before consequential actions.
Organisations retain control of their data and provider accounts.

Nathan Mulligan maintains this project and accepts responsibility for merged
changes. AI agents assist with authoring. [AI policy](AI_POLICY.md) defines
attribution and independent review.

## Status

This repository contains documentation, development tooling, checks, vendored
skills, and empty product directories. There is no application, execution
engine, installer, release, or deployed service. Local tooling checks do not
prove product behaviour or hosted enforcement. Outside contributions remain
closed.

The proposed sequence is foundation, tasks and basic approval, agent work,
Docs, richer review, then CRM. The first product slice is a local task flow
with real persistence, a deterministic worker, and synthetic data.
[Current decisions](docs/current-decisions.md) and the
[first task specification](docs/plan/first-task.md) define its boundaries.
Product implementation waits for the full build-loop rehearsal.

## Start here

- [Architecture](ARCHITECTURE.md) describes the selected stack and what remains unbuilt.
- [Vocabulary](CONTEXT.md) defines the domain terms.
- [Contributing](CONTRIBUTING.md) explains the single build and review workflow.
- [Plan and evidence](docs/plan/README.md) separates decisions from proof still outstanding.
- [Security](SECURITY.md), [governance](GOVERNANCE.md), and [support](SUPPORT.md) state the project's policies.

## Check the foundation

Use the Node major in `.nvmrc`, the pnpm version in `package.json`, Python
3.11 or newer, Git, and Gitleaks. Install the pinned development dependencies
in a working checkout, then run `corepack pnpm check`.

[Local verification](docs/plan/local-verification.md) explains how to check
and export an exact candidate without creating a commit. Hosted and runtime
proof remain separate.

## Product name

[product.json](product.json) holds the public name. To change it, update that
file and run `corepack pnpm brand:sync`, then `corepack pnpm check`.
[Product identity](docs/product-identity.md) separates branding from technical
identifiers and deployment addresses.

## Licence

The project is AGPL-3.0-only. [LICENSE](LICENSE) contains the complete text;
[NOTICE](NOTICE) records third-party attribution. The
[preset and skill exception](LICENSE-EXCEPTIONS.md) is drafted and ungranted.
The [contributor agreement](CLA.md) is also a draft. Legal review remains
outstanding. [Licensing](LICENSING.md) describes the intended boundaries.
