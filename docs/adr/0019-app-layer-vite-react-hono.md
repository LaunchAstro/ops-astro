# TypeScript, React, Vite, Hono, and Postgres

Accepted 6 September 2026; current baseline confirmed 7 September.

Use TypeScript for the application and domain logic, React with Vite for the
web interface, and Hono for the HTTP boundary. This keeps the client and
server contracts in one typed application model without adopting a second
application framework for an unproven need.

Operational records, people, permissions, tasks, decisions, budgets, and
execution outcomes belong in organisation-owned Supabase/Postgres. A
container package and a supported Australian hosting profile are the intended
installation direction. The concrete pinned profile, sizing, backups, and
installer remain to be specified and proved. Plain Postgres portability is a
required test target; it is not a supported installation proven by this
foundation.

Object storage sits behind a provider contract for uploads, backups, logs,
and artefacts. The Australian profile uses Supabase Storage or S3 Sydney,
with a separate immutable archive target where required. Each installation
needs its own data-flow and location statement; a region choice is not proof
that every external service or diagnostic copy stays there.

Model, connector, custody, and storage interfaces have explicit ownership.
Deep Agents, LangGraph, LangChain, and Langflow remain unselected. A bounded
comparison must demonstrate a named benefit without taking over product
permissions, decisions, budget control, or effect recovery.

The initial task demo requires real local Postgres and a deterministic worker.
It does not require optional tracing or an analytics deployment. See
[Architecture](../../ARCHITECTURE.md) and the
[tracing decision](0069-tracing-and-analytics.md).
