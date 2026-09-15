# A separate credential broker

Accepted 6 September 2026; implementation pending. **Amended 10 September
2026**: the engineer review this record required was withdrawn and replaced by
the component's conformance proof, per
[ADR 0049](0049-senior-engineer-signed-engagement-stop-authority.md). That
proof is pending too.

A dedicated broker service owns credential custody and provider calls under
its own process identity. It holds the credential-store key and has a narrowly
scoped database role. Workers and model contexts use credential references,
not credential values. The broker has no Docker socket or shared writable
volume with execution workers.

A caller requests a catalogued operation with validated parameters, grant,
run identity, and reason code. The connector definition owns the host, path,
method, headers, redirect policy, response schema, and response-size limit.
Callers cannot submit arbitrary URLs or request templates. Credentials are
injected inside the broker, and the call produces audit evidence.

Money, identity, outbound-email, and DNS credentials never lease. Any approved
lower-risk lease is a single-use, audited exception capped at 300 seconds.
A copied bearer token can outlive that local timer, so a lease is not a general
revocation guarantee. SDKs that need direct credential access run within the
broker boundary as operation adapters.

Refresh serialises per grant. Encryption, key rotation, broker authentication,
redaction, and provider error handling require concrete contracts and tests.
The planned initial implementation uses encrypted values in Postgres with
external key custody; no credential store is active in this foundation.
Breadth adapters remain deferred until a named connector need justifies them.
