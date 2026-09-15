# Serialise audit writes per business

Accepted 6 September 2026; implementation pending.

Use one append-only audit chain per business, with writes serialised by a
business-scoped advisory lock. Keep the signing key outside the database and
revoke update and delete privileges on audit rows. A verifier checks the chain;
periodic head hashes are exported to an immutable external target.

This gives concurrent writers a defined ordering point. A hash chain alone is
not proof against an actor that controls both the database and its signing
key; external custody and anchors are part of the intended control.

The recorded performance trigger is p95 lock wait above 50 ms in the planned
50-user test. If that test justifies it, evaluate per-run subchains and a
business-level root. These figures are test criteria, not measured performance
or recovery promises. The verifier, external anchoring, and contention tests
are all unbuilt.
