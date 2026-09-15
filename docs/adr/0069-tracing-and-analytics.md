# Separate diagnostics, analytics, and operational authority

Langfuse selected 6 September 2026; ClickHouse responsibilities clarified by
C12 on 7 September. Deployment and integration proof remain pending.

Runs, steps, model calls, and decisions expose stable trace identifiers through
an owned interface. Langfuse is the selected optional diagnostic backend.
Task state, decisions, cost reservations, and hard budget ceilings remain
operational Postgres records. Langfuse cannot approve or settle spending.

ClickHouse has two distinct responsibilities in the initial data design:

- Langfuse owns its internal tracing schema, credentials, access, retention, and recovery profile.
- Business analytics has separate facts, source-account mappings, credentials, business-scoped access, freshness, deduplication, and deletion rules.

Any physical sharing requires explicit capacity and isolation review. Neither
role takes ownership of people, tasks, permissions, approvals, or operational
execution results. The first local task demo need not start either service.

Before deployment, inspect a pinned Langfuse release and complete its profile,
including web and worker processes, Postgres, ClickHouse, queue/cache services,
and object storage. Review distribution rights, OSS and enterprise boundaries,
and required notices. The prior claim that a deployed build contains no
enterprise code is unproven and must not be repeated.

Prove synthetic trace delivery, denied access, redaction, retention, deletion,
and restore. Diagnostic copies require their own protection. A no-op tracing
adapter emits and retains nothing; it proves no delivery. Tracing failure must
not prevent authoritative task records from being saved. The separate analytics
feed requires replay, deduplication, and business-isolation proof.
