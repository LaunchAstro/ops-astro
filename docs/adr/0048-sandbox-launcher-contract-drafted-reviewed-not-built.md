# Approve the final sandbox contract before implementation

Accepted 6 September 2026; final-version approval clarified 7 September. The
approver changed on 10 September, when the planned senior-engineer engagement
and its authority were withdrawn before anyone was engaged:
[ADR 0049](0049-senior-engineer-signed-engagement-stop-authority.md) records
the supersession, and the hold is now Nathan's.

The sandbox launcher requires a written contract covering accepted and refused
inputs, isolation, egress, socket-proxy operations, preflight, failure, and
degraded behaviour. Agents may draft the contract and run independent
adversarial reviews of it.

Nathan must approve the final contract after adversarial findings are
resolved and **before implementation**. Approval of an earlier draft is
insufficient. This is an additional hold beyond the conformance proof required
for protected-component changes before merge.

The intended isolation uses per-run gVisor containers. Arbitrary-code tools,
untrusted package installation, and headless execution remain unavailable
until the approved sandbox is implemented and verified. A registry entry must
report that unavailability; there is no unsandboxed fallback. No sandbox
implementation or final-contract approval exists in this foundation.
