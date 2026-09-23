// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal register. One table of codes, and the visibility rule.
//
// Three parts before this one each carried their own refusal type and each
// said the same thing in a comment: the register itself is T1f's. This is it.
// It does not replace those three unions — a module keeps the codes it can
// produce, which is what lets its own types stay narrow — it is the one place
// that says a code exists, what it means, which contract row owns it, and
// whether a caller may see it at all.
//
// **Why a table rather than a union alone.** A union stops a typo. It cannot
// say that `WRONG_BUSINESS` is never returned to a caller, and that rule is
// the whole of case T1-N5: a cross-business read is `NOT_FOUND`, and it must
// be indistinguishable in status, code, body and timing from a read of an
// identifier nobody ever issued. A boolean beside the code makes that a fact
// the envelope enforces once, rather than a rule every command remembers.
//
// **Why codes nothing produces yet are in it.** The contract's register is
// twenty-four codes (minimum contract 4.4) and its command table names seven
// more. Several belong to gates, leases and delegations, which land in later
// parts. Registering them now costs a line each; leaving them out means the
// part that builds those commands invents its own spelling of a code the
// contract already named. `UNPRODUCED_CODES` names them, so a later part
// closing one shows as a diff to this file rather than as nothing at all.

export type Visibility = 'caller' | 'audit';

export type RefusalCode =
  // Identity, T1b.
  | 'AUTH_UNKNOWN_LOGIN'
  | 'AUTH_NO_MEMBERSHIP'
  | 'ACTOR_INACTIVE'
  // Authority, T1c.
  | 'SCOPE_NOT_GRANTED'
  | 'GRANT_WIDENS'
  | 'GRANT_DEEPENS'
  // The records engine and the task type, T1d and T1e.
  | 'NOT_FOUND'
  | 'FIELD_NOT_SLOTTED'
  | 'FIELD_NOT_GROUPABLE'
  | 'FIELD_UNKNOWN'
  | 'FIELD_NOT_WRITABLE'
  | 'VIEW_HOP_LIMIT'
  | 'SLOT_RESERVED'
  | 'SLOT_TYPE_EXHAUSTED'
  | 'SLOT_INDEX_ABSENT'
  | 'SLOT_UNKNOWN'
  | 'TRANSITION_PROTECTED'
  | 'PLACEMENT_IS_DERIVED'
  | 'PARENT_TRASHED'
  | 'ALREADY_TRASHED'
  | 'UNIQUE_VALUE_TAKEN'
  | 'RETENTION_CLASS_PROTECTED'
  // The command envelope, T1f.
  | 'OPERATION_ID_REQUIRED'
  | 'EXPECTED_REVISION_REQUIRED'
  | 'OPERATION_ID_REUSED'
  | 'VERSION_STALE'
  | 'SOURCE_SPOOFED'
  | 'FIELD_VALUE_INVALID'
  | 'TRANSITION_NOT_PERMITTED'
  | 'DEPENDENCY_NOT_LANDED'
  | 'COMMAND_BODY_INVALID'
  | 'WRONG_BUSINESS'
  // The agent's own identity, L2's `identity/agent-login.ts`. An agent login
  // and a person's login are two credentials and resolve through two paths, so
  // "no agent identity" is its own answer and never `AUTH_UNKNOWN_LOGIN`.
  | 'AUTH_NO_AGENT_IDENTITY'
  | 'AUTH_SESSION_EXPIRED'
  // Delegation and lease, T1's pickup and handback. No table yet.
  | 'DELEGATION_EXCLUDES_OPERATION'
  | 'DELEGATION_EXCLUDES_DECISION'
  | 'DELEGATION_EXCLUDES_INTAKE'
  | 'DELEGATION_NARROWED'
  | 'DELEGATION_OUT_OF_PURPOSE'
  | 'DELEGATION_NOT_LIVE'
  | 'DELEGATION_WIDENS'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_REVOKED'
  | 'LEASE_HELD'
  | 'LEASE_EXPIRED'
  | 'LEASE_NOT_OWNED'
  | 'TASK_NOT_PICKABLE'
  // Comments, T1's fourth observable result. No record type yet.
  | 'AUDIENCE_NOT_PERMITTED'
  // The preset planner, L2's `records/preset-plan.ts`.
  | 'PRESET_FIELD_UNCLASSIFIED'
  | 'PRESET_TYPE_UNKNOWN'
  | 'PRESET_FIELD_UNPLACEABLE'
  | 'PRESET_FIELD_DUPLICATE'
  // Gates and proposals, T2.
  | 'GATE_PENDING'
  | 'GATE_ALREADY_DECIDED'
  | 'GATE_NOT_APPROVED'
  | 'PROPOSAL_SUPERSEDED'
  | 'PROPOSAL_SCOPE_EXCEEDED'
  | 'FOUR_EYES_REQUIRED'
  // L4's bounded runtime, `core-runtime/src/refusals.ts`. Seven of its eighteen
  // are the six above plus `SCOPE_NOT_GRANTED`, already registered by the
  // parts that named them first; these eleven are new spellings and they come
  // in here rather than being invented a second time in a handler. The last
  // three arrived with L4's review fixes (R2, R3 and R6) and are registered on
  // the same terms as the eight before them.
  | 'VERSION_SUPERSEDED'
  | 'EVIDENCE_MISMATCH'
  | 'GATE_NOT_FOUND'
  | 'GATE_EXPIRED'
  | 'LINEAGE_TERMINAL'
  | 'CHANGE_ROUNDS_EXHAUSTED'
  | 'PROPOSAL_OUT_OF_SCOPE'
  | 'RESERVATION_NOT_CLAIMABLE'
  | 'LINEAGE_NOT_ON_TASK'
  | 'CAP_BINDING_MISMATCH'
  | 'ACTUAL_EXPENDITURE_UNSUPPORTED'
  // Budget, T1k.
  | 'BUDGET_UNAVAILABLE'
  | 'BUDGET_EXHAUSTED';

export interface RegisterEntry {
  readonly code: RefusalCode;
  /** `audit` means the caller is shown something else. Exactly one code is. */
  readonly visibility: Visibility;
  /** One line, so a register a person reads is the same one the code reads. */
  readonly meaning: string;
  /** The contract row that owns the code, so a reader can go and check it. */
  readonly source: string;
}

function entry(
  code: RefusalCode,
  meaning: string,
  source: string,
  visibility: Visibility = 'caller',
): RegisterEntry {
  return { code, visibility, meaning, source };
}

export const REFUSAL_REGISTER: readonly RegisterEntry[] = [
  entry('AUTH_UNKNOWN_LOGIN', 'The credential is not recognised', 'contract 4.4'),
  entry('AUTH_NO_MEMBERSHIP', 'Verified login, no active person in this business', 'contract 4.4'),
  entry('ACTOR_INACTIVE', 'The actor row is deactivated', 'contract 4.4'),

  entry('SCOPE_NOT_GRANTED', 'In business, exists, no grant for this action', 'contract 4.4'),
  entry(
    'GRANT_WIDENS',
    'A derived grant would exceed the grant it is cut from',
    'T1c, unregistered',
  ),
  entry('GRANT_DEEPENS', 'A derived grant would pass on more than it holds', 'T1c, unregistered'),

  entry('NOT_FOUND', 'It does not exist, or exists in another business', 'contract 4.4'),
  entry(
    'FIELD_NOT_SLOTTED',
    'A view filters, sorts or groups on a field with no slot',
    'spec T1-N9',
  ),
  entry(
    'FIELD_NOT_GROUPABLE',
    'A grouping names a field whose values are unbounded',
    'T1d, unregistered',
  ),
  entry('FIELD_UNKNOWN', 'The record type has no field by that key', 'T1d, unregistered'),
  entry('FIELD_NOT_WRITABLE', 'A payload carried a derived field', 'contract 4.3'),
  entry(
    'VIEW_HOP_LIMIT',
    'A view clause traverses more link hops than are allowed',
    'T1d, unregistered',
  ),
  entry('SLOT_RESERVED', 'A preset field named a slot the task spine holds', 'spec T1-N10'),
  entry('SLOT_TYPE_EXHAUSTED', 'No free slot of the needed type remains', 'spec T1-N10'),
  entry(
    'SLOT_INDEX_ABSENT',
    'The free slot carries no index, so filtering it would scan',
    'spec 9.3',
  ),
  entry(
    'SLOT_UNKNOWN',
    'The named slot is not in the catalogue, or is the wrong type',
    'T1d, unregistered',
  ),
  entry(
    'TRANSITION_PROTECTED',
    'The generic editor reached a field an operation owns',
    'spec T1-N3',
  ),
  entry(
    'PLACEMENT_IS_DERIVED',
    'A create payload chose placement the server derives',
    'T1e, unregistered',
  ),
  entry('PARENT_TRASHED', 'The parent is still in the trash, in the batch named', 'spec 14.3'),
  entry('ALREADY_TRASHED', 'The subtree root is already in the trash', 'T1e, unregistered'),
  entry(
    'UNIQUE_VALUE_TAKEN',
    'Someone claimed the unique value while this was away',
    'T1e, unregistered',
  ),
  entry(
    'RETENTION_CLASS_PROTECTED',
    'A purge named a table outside the work class',
    'T1e, unregistered',
  ),

  entry(
    'OPERATION_ID_REQUIRED',
    'A mutating command carried no repeat-request identity',
    'spec 6, T1f',
  ),
  entry(
    'EXPECTED_REVISION_REQUIRED',
    'A write to an existing record named no revision',
    'spec 6, T1f',
  ),
  entry('OPERATION_ID_REUSED', 'The same identity arrived with a different payload', 'spec T1-N2'),
  entry('VERSION_STALE', 'The expected revision is behind the current one', 'spec T1-N1'),
  entry('SOURCE_SPOOFED', 'The payload carried a system-derived field', 'spec T1-N4'),
  entry('FIELD_VALUE_INVALID', 'A value is not of the type the field is', 'T1f, unregistered'),
  entry('TRANSITION_NOT_PERMITTED', 'The lifecycle does not allow this transition', 'contract 4.3'),
  entry(
    'DEPENDENCY_NOT_LANDED',
    'The command exists; the part it rests on has not',
    'T1f, unregistered',
  ),
  entry(
    'COMMAND_BODY_INVALID',
    'The request body is not an object of the command’s fields',
    'T1f, unregistered',
  ),
  entry('WRONG_BUSINESS', 'The record belongs to another business', 'contract 4.4', 'audit'),

  entry(
    'AUTH_NO_AGENT_IDENTITY',
    'The credential is not an agent login in this business',
    'L2 AUTHORITY.md',
  ),
  entry('AUTH_SESSION_EXPIRED', 'The verified token has expired; sign in again', 'L2 AUTHORITY.md'),

  entry('DELEGATION_EXCLUDES_OPERATION', 'Outside the delegation’s permitted set', 'contract 4.4'),
  entry(
    'DELEGATION_EXCLUDES_DECISION',
    'A decision is excluded from every delegation',
    'contract 4.4',
  ),
  entry('DELEGATION_EXCLUDES_INTAKE', 'Intake is reachable only inside a decision', 'contract 6.1'),
  entry('DELEGATION_NARROWED', 'The person’s grant no longer covers this call', 'contract 4.4'),
  entry(
    'DELEGATION_OUT_OF_PURPOSE',
    'The call is outside the purpose the delegation was minted for',
    'L2 AUTHORITY.md',
  ),
  entry('DELEGATION_NOT_LIVE', 'The delegation is expired, revoked or settled', 'L2 AUTHORITY.md'),
  entry(
    'DELEGATION_WIDENS',
    'A mint would exceed what the delegating person holds',
    'L2 AUTHORITY.md',
  ),
  entry('DELEGATION_EXPIRED', 'The delegation minted at pickup has run out', 'contract 4.4'),
  entry('DELEGATION_REVOKED', 'The delegation was withdrawn', 'contract 4.4'),
  entry('LEASE_HELD', 'Another worker holds the lease on this work', 'contract 4.4'),
  entry('LEASE_EXPIRED', 'The lease ended before the handback arrived', 'contract 4.4'),
  entry('LEASE_NOT_OWNED', 'The lease belongs to another holder', 'contract 4.4'),
  entry('TASK_NOT_PICKABLE', 'The task is not in a state a worker may pick up', 'contract 4.3'),

  entry('AUDIENCE_NOT_PERMITTED', 'The caller may not write in that audience', 'contract 4.3'),

  entry(
    'PRESET_FIELD_UNCLASSIFIED',
    'A preset field carries no write mode, or one the model does not have',
    'spec D05',
  ),
  entry('PRESET_TYPE_UNKNOWN', 'This business has no record type by that key', 'spec D05'),
  entry('PRESET_FIELD_UNPLACEABLE', 'No free indexed slot of the field’s type remains', 'spec D05'),
  entry(
    'PRESET_FIELD_DUPLICATE',
    'One preset names the same new field key more than once',
    'spec D05',
  ),

  entry('GATE_PENDING', 'A blocking gate instance is open on this record', 'contract 4.3'),
  entry('GATE_ALREADY_DECIDED', 'The gate instance carries a decision already', 'contract 4.4'),
  entry('GATE_NOT_APPROVED', 'The named decision is not an approval', 'contract 6.1'),
  entry('PROPOSAL_SUPERSEDED', 'A later version of the proposal exists', 'contract 4.4'),
  entry('PROPOSAL_SCOPE_EXCEEDED', 'The proposal reaches past what was authorised', 'contract 4.3'),
  entry('FOUR_EYES_REQUIRED', 'The gate needs a second approver', 'contract 4.4'),

  entry('BUDGET_UNAVAILABLE', 'No committed reservation covers this attempt', 'contract 4.4'),
  entry('BUDGET_EXHAUSTED', 'The reservation is spent', 'contract 4.4'),

  entry('VERSION_SUPERSEDED', 'A later version of this proposal is the live one', 'L4 RUNTIME.md'),
  entry(
    'EVIDENCE_MISMATCH',
    'The gate\u2019s digest and the version\u2019s disagree',
    'L4 RUNTIME.md',
  ),
  entry('GATE_NOT_FOUND', 'No gate by that identity in this business', 'L4 RUNTIME.md'),
  entry('GATE_EXPIRED', 'The gate\u2019s decision window has closed', 'L4 RUNTIME.md'),
  entry('LINEAGE_TERMINAL', 'The lineage is rejected or cancelled', 'L4 RUNTIME.md'),
  entry('CHANGE_ROUNDS_EXHAUSTED', 'Two formal rounds are used and there is no third', 'spec G08'),
  entry(
    'PROPOSAL_OUT_OF_SCOPE',
    'The proposal reaches past the caller\u2019s authority',
    'L4 RUNTIME.md',
  ),
  entry(
    'RESERVATION_NOT_CLAIMABLE',
    'The reservation is not approved, held and unpicked',
    'L4 RUNTIME.md',
  ),
  entry(
    'LINEAGE_NOT_ON_TASK',
    'The proposal names a lineage opened on another task',
    'L4 RUNTIME.md R3',
  ),
  entry(
    'CAP_BINDING_MISMATCH',
    'The decision names a cap or a currency the task’s envelope does not hold',
    'L4 RUNTIME.md R2',
  ),
  entry(
    'ACTUAL_EXPENDITURE_UNSUPPORTED',
    'The handback reports spending nothing in this head could have made',
    'L4 RUNTIME.md R6',
  ),
];

const BY_CODE = new Map(REFUSAL_REGISTER.map((row) => [row.code, row]));

export function registeredRefusal(code: RefusalCode): RegisterEntry | undefined {
  return BY_CODE.get(code);
}

/** The codes a caller may be shown. Everything else is translated by the envelope. */
export const CALLER_VISIBLE: ReadonlySet<RefusalCode> = new Set(
  REFUSAL_REGISTER.filter((row) => row.visibility === 'caller').map((row) => row.code),
);

/**
 * Registered, and nothing in the tree can produce one yet.
 *
 * Each waits on something this part does not build: a delegations table for
 * pickup and handback, a comment record type, and the gate triple for a
 * proposal and a decision.
 *
 * Three came off the list when T1k landed the budget tables, which is the
 * visible diff this list exists to produce. `BUDGET_EXHAUSTED` is what the
 * enforcing path returns when an attempt would cross a ceiling a person
 * approved. `GATE_NOT_APPROVED` and `FOUR_EYES_REQUIRED` came with it, not
 * from the gate engine: a top-up and a write-off are gated money decisions,
 * so the first part to need an approval to be an approval was the budget one.
 * Asserted by name in `tests/commands/refusal-register.test.ts`, so a part
 * that closes one has to come here and take it off the list.
 * `AUTH_UNKNOWN_LOGIN` was on this list until a review pointed out that the
 * HTTP boundary produces it: a request nothing verified is refused with it
 * before any command runs.
 *
 * **`WRONG_BUSINESS` is on this list and that is a finding rather than a
 * shortcut.** Minimum contract 4.4 says the audit records it while the caller
 * sees `NOT_FOUND`. Telling "another business holds this identifier" from "no
 * such identifier" needs a read that is not scoped to the caller's business,
 * and the tenancy law forbids one: row security is forced, the application
 * role owns nothing, and a definer-rights function that answered the question
 * is exactly what case T1-N14 exists to attack. So a cross-business probe is
 * recorded as `NOT_FOUND` — the same thing the caller is told — and the code
 * stays registered, audit-only and unreachable. The translation mechanism it
 * exists for is tested; what is missing is a reader outside the tenant, and
 * the isolation suite (T1h) is the one place in the slice that has one.
 */
export const UNPRODUCED_CODES: ReadonlySet<RefusalCode> = new Set([
  'WRONG_BUSINESS',
  'AUDIENCE_NOT_PERMITTED',
  // Delegation codes no reachable operation raises. `DELEGATION_NARROWED`
  // needs the delegating person's grant revoked between a pickup and the
  // agent's next call, and there is still no authenticated grant-control
  // route to revoke it through. `DELEGATION_WIDENS` is a mint refusal and
  // `task.pickup` mints from the authorising person's own live grants, so it
  // cannot construct a widening one. The other three name a delegation
  // lifecycle — excluded operations, intake, an explicit revocation — that
  // this head's one-task purpose does not distinguish.
  'DELEGATION_NARROWED',
  'DELEGATION_WIDENS',
  'DELEGATION_EXCLUDES_INTAKE',
  'DELEGATION_EXCLUDES_OPERATION',
  'DELEGATION_EXPIRED',
  'DELEGATION_REVOKED',
  // T2 spellings the runtime did not adopt. It raises `GATE_ALREADY_DECIDED`
  // where these say pending and superseded, and nothing produces these two.
  'GATE_PENDING',
  'PROPOSAL_SUPERSEDED',
  'PROPOSAL_SCOPE_EXCEEDED',
  'TASK_NOT_PICKABLE',
  // The four L4 codes that need something no caller can reach.
  //
  // `EVIDENCE_MISMATCH` needs a gate whose stored digest and version's own
  // disagree, and `propose` writes both from one value, so only an amended row
  // produces it. `GATE_EXPIRED` and `LEASE_EXPIRED` need the wall clock to
  // pass an expiry the server chose, between two calls. `LEASE_HELD` needs a
  // second pickup of a reservation already leased, and the second pickup meets
  // `RESERVATION_NOT_CLAIMABLE` first: the reservation has left `held` by
  // then. `CHANGE_ROUNDS_EXHAUSTED` is reachable and proven in
  // `tests/runtime/gate.test.ts` against the module rather than through a
  // command, so it stays named until a command case reaches it.
  'EVIDENCE_MISMATCH',
  'GATE_EXPIRED',
  'LEASE_EXPIRED',
  'LEASE_HELD',
  'CHANGE_ROUNDS_EXHAUSTED',
  // L4's three review-fix codes are deliberately **not** on this list, and
  // each is a command path rather than a module one.
  //
  // `LINEAGE_NOT_ON_TASK`: `task.propose` takes `lineageId` from the caller,
  // so naming a live lineage opened on another task of the same business is an
  // ordinary request, and R3 refuses it.
  //
  // `CAP_BINDING_MISMATCH`: the cap half of R2 is not command-reachable, since
  // `readBusinessCapId` hands every decision on a business the same cap. The
  // currency half is. `task.propose` takes `currency`, the first approval opens
  // the envelope in the version's currency, and a second proposal on that task
  // in another currency is refused when it is decided.
  //
  // `ACTUAL_EXPENDITURE_UNSUPPORTED`: `task.handback` refuses any non-null
  // `actualMinor`, so a caller reporting a cost — including zero — produces it.
]);
