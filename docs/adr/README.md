# Architecture decisions

This is a curated public technical record, consolidated 8 September 2026 and
amended since for later decisions, which carry their own dates where they
appear.
[Current decisions](../current-decisions.md) carries the present baseline and
C01 to C17. The retained numbers preserve references to earlier decisions;
missing numbers are intentionally not republished. Private planning and
commercial history stay in the original archive.

The records below are rewritten technical explanations, not verbatim copies
or evidence that their systems are implemented. The public technical evidence
digest and adjudicated verdicts remain outstanding.

| Decision                                                             | Responsibility                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| [0001](0001-pocock-loop-is-the-build-method.md)                      | One build workflow                                         |
| [0007](0007-licence-stack-agpl-with-preset-exception.md)             | AGPL core and a draft boundary exception                   |
| [0008](0008-dco-plus-cla-and-the-assisted-by-trailer.md)             | Separate provenance, human certification, and signatures   |
| [0013](0013-gate-triple.md)                                          | One task and gate contract                                 |
| [0014](0014-business-id-on-every-table-and-key.md)                   | Business isolation and enduring identity                   |
| [0019](0019-app-layer-vite-react-hono.md)                            | TypeScript, React, Vite, Hono, and Postgres                |
| [0028](0028-credential-broker-in-core.md)                            | A separate credential broker                               |
| [0030](0030-fixed-typed-slots-no-runtime-ddl.md)                     | Fixed typed slots for records and tasks                    |
| [0031](0031-postgres-canonical-knowledge.md)                         | Postgres owns knowledge; exports are projections           |
| [0039](0039-audit-chain-serialisation-point.md)                      | Serialise audit writes per business                        |
| [0046](0046-merge-mode-machine-proven-merges.md)                     | Merge commits after checks and reviews                     |
| [0048](0048-sandbox-launcher-contract-drafted-reviewed-not-built.md) | Approve the final sandbox contract before implementation   |
| [0049](0049-senior-engineer-signed-engagement-stop-authority.md)     | Superseded: the engineer gate, withdrawn 10 September 2026 |
| [0067](0067-no-recovery-figures-until-rehearsed-and-timed.md)        | Publish recovery figures only after measured rehearsal     |
| [0069](0069-tracing-and-analytics.md)                                | Separate diagnostics, analytics, and operational authority |
