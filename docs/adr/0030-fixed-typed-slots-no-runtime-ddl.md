# Fixed typed slots for records and tasks

Accepted 6 September 2026; the first task scope was refined on 8 September.

Indexed fields use predeclared typed slot columns, with one field-definition
record owning each slot assignment. Updating metadata and a bounded backfill
changes indexing behaviour without runtime schema changes. A single write
path must keep slots and the record body consistent.

Generated columns and per-field index creation were rejected because they
turn ordinary field configuration into DDL and can require disruptive locks
or rewrites. Runtime code has no DDL privilege. Only supported slotted fields
are filterable, sortable, or groupable. A uniqueness table keyed by business,
record type, field, and canonical value is maintained in the record transaction.

A task is a built-in record type, not a separate physical tasks table. Task
relations use record links and the same views and permission path. Runs,
steps, decisions, and cost entries remain explicit operational records with
their own contracts. A storage adapter allows later measured optimisation
without introducing another view engine.

Slot sizing is unfinished. Count required fields and reserve task fields
before preset allocation; do not treat an old illustrative slot count as a
completed inventory. A schema must not land until that sizing and its tests
are reviewable. Non-human intake defaults to `pending_triage`; the first demo
starts with human-created tasks and derives provenance from authenticated
context rather than a request body's claimed source.
