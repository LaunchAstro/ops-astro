// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal register. One table of codes, their statuses, and the
// visibility rule.
//
// Three parts before this one each carried their own refusal type and each
// said the same thing in a comment: the register itself is T1f's. This is it.
// It does not replace those three unions — a module keeps the codes it can
// produce, which is what lets its own types stay narrow — it is the one place
// that says a code exists, what it means, which contract row owns it, which
// HTTP status carries it, and whether a caller may see it at all. A code is
// declared once, as a row: `RefusalCode` is read off the rows, the runtime's
// own union is read off the rows marked `runtime`, and the HTTP door reads the
// status column through `statusOf` (architecture review bbdf2b2, candidate 2).
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

/**
 * Which HTTP status a refusal is carried under.
 *
 * The code is the domain's and is the thing a client branches on; the status
 * is what an HTTP client, a proxy and a log reader see. Neither is derived
 * from the other, so each row decides both. A status is a required column
 * rather than a second table, so a code added without one is a type error
 * rather than a silent 500. That matters more than it sounds: an unmapped
 * refusal defaulting to 500 would turn a refusal into a fault, and case T1-N5
 * requires two different refusals to be indistinguishable in **status** as
 * well as in body. `apps/api/app.ts` reads this column through `statusOf`; it
 * declares nothing.
 *
 * By class: 401, not signed in, or signed in as nobody this business knows;
 * 403, signed in and not allowed; 404, it is not there, or it is not yours to
 * know about; 409, the request is understood and something else has moved;
 * 400 and 422, the request itself is wrong and repeating it will not help;
 * 501, the operation is declared and what it rests on is not built. 402 and
 * 410 are the runtime's, and the rows that carry them say why.
 */
export type RefusalStatus = 400 | 401 | 402 | 403 | 404 | 409 | 410 | 422 | 501;

/**
 * A row as it is declared. `visibility` is `caller` unless the row says
 * otherwise, and `runtime` marks the codes `core-runtime` returns as its own,
 * which is where `RuntimeRefusalCode` comes from; it changes nothing a caller
 * sees.
 */
interface Declared {
  readonly code: string;
  readonly status: RefusalStatus;
  readonly meaning: string;
  readonly source: string;
  readonly visibility?: Visibility;
  readonly runtime?: true;
}

const ROWS = [
  // Identity, T1b. Not signed in, or signed in as nobody this business knows.
  {
    code: 'AUTH_UNKNOWN_LOGIN',
    status: 401,
    meaning: 'The credential is not recognised',
    source: 'contract 4.4',
  },
  {
    code: 'AUTH_NO_MEMBERSHIP',
    status: 403,
    meaning: 'Verified login, no active person in this business',
    source: 'contract 4.4',
  },
  {
    code: 'ACTOR_INACTIVE',
    status: 403,
    meaning: 'The actor row is deactivated',
    source: 'contract 4.4',
  },

  // Authority, T1c. Signed in, and not allowed. Also one of the runtime's own.
  {
    code: 'SCOPE_NOT_GRANTED',
    status: 403,
    meaning: 'In business, exists, no grant for this action',
    source: 'contract 4.4',
    runtime: true,
  },
  {
    code: 'GRANT_WIDENS',
    status: 403,
    meaning: 'A derived grant would exceed the grant it is cut from',
    source: 'T1c, unregistered',
  },
  {
    code: 'GRANT_DEEPENS',
    status: 403,
    meaning: 'A derived grant would pass on more than it holds',
    source: 'T1c, unregistered',
  },

  // The records engine and the task type, T1d and T1e.
  {
    code: 'NOT_FOUND',
    status: 404,
    meaning: 'It does not exist, or exists in another business',
    source: 'contract 4.4',
  },
  {
    code: 'FIELD_NOT_SLOTTED',
    status: 422,
    meaning: 'A view filters, sorts or groups on a field with no slot',
    source: 'spec T1-N9',
  },
  {
    code: 'FIELD_NOT_GROUPABLE',
    status: 422,
    meaning: 'A grouping names a field whose values are unbounded',
    source: 'T1d, unregistered',
  },
  {
    code: 'FIELD_UNKNOWN',
    status: 422,
    meaning: 'The record type has no field by that key',
    source: 'T1d, unregistered',
  },
  {
    code: 'FIELD_NOT_WRITABLE',
    status: 422,
    meaning: 'A payload carried a derived field',
    source: 'contract 4.3',
  },
  {
    code: 'VIEW_HOP_LIMIT',
    status: 422,
    meaning: 'A view clause traverses more link hops than are allowed',
    source: 'T1d, unregistered',
  },
  {
    code: 'SLOT_RESERVED',
    status: 422,
    meaning: 'A preset field named a slot the task spine holds',
    source: 'spec T1-N10',
  },
  {
    code: 'SLOT_TYPE_EXHAUSTED',
    status: 422,
    meaning: 'No free slot of the needed type remains',
    source: 'spec T1-N10',
  },
  {
    code: 'SLOT_INDEX_ABSENT',
    status: 422,
    meaning: 'The free slot carries no index, so filtering it would scan',
    source: 'spec 9.3',
  },
  {
    code: 'SLOT_UNKNOWN',
    status: 422,
    meaning: 'The named slot is not in the catalogue, or is the wrong type',
    source: 'T1d, unregistered',
  },
  {
    code: 'TRANSITION_PROTECTED',
    status: 422,
    meaning: 'The generic editor reached a field an operation owns',
    source: 'spec T1-N3',
  },
  {
    code: 'PLACEMENT_IS_DERIVED',
    status: 422,
    meaning: 'A create payload chose placement the server derives',
    source: 'T1e, unregistered',
  },
  {
    code: 'PARENT_TRASHED',
    status: 409,
    meaning: 'The parent is still in the trash, in the batch named',
    source: 'spec 14.3',
  },
  {
    code: 'ALREADY_TRASHED',
    status: 409,
    meaning: 'The subtree root is already in the trash',
    source: 'T1e, unregistered',
  },
  {
    code: 'UNIQUE_VALUE_TAKEN',
    status: 409,
    meaning: 'Someone claimed the unique value while this was away',
    source: 'T1e, unregistered',
  },
  {
    code: 'RETENTION_CLASS_PROTECTED',
    status: 403,
    meaning: 'A purge named a table outside the work class',
    source: 'T1e, unregistered',
  },

  // The command envelope, T1f.
  {
    code: 'OPERATION_ID_REQUIRED',
    status: 422,
    meaning: 'A mutating command carried no repeat-request identity',
    source: 'spec 6, T1f',
  },
  {
    code: 'EXPECTED_REVISION_REQUIRED',
    status: 422,
    meaning: 'A write to an existing record named no revision',
    source: 'spec 6, T1f',
  },
  {
    code: 'OPERATION_ID_REUSED',
    status: 409,
    meaning: 'The same identity arrived with a different payload',
    source: 'spec T1-N2',
  },
  {
    code: 'VERSION_STALE',
    status: 409,
    meaning: 'The expected revision is behind the current one',
    source: 'spec T1-N1',
  },
  {
    code: 'SOURCE_SPOOFED',
    status: 403,
    meaning: 'The payload carried a system-derived field',
    source: 'spec T1-N4',
  },
  {
    code: 'FIELD_VALUE_INVALID',
    status: 422,
    meaning: 'A value is not of the type the field is',
    source: 'T1f, unregistered',
  },
  // The runtime's use of it is a restart of a lineage that is live, completed, or
  // already restarted (G05).
  {
    code: 'TRANSITION_NOT_PERMITTED',
    status: 409,
    meaning: 'The lifecycle does not allow this transition',
    source: 'contract 4.3',
    runtime: true,
  },
  // The operation is declared and what it rests on has not been built. Not a
  // permission problem and not a bad request, and saying so is the honest answer
  // rather than a 404 that reads as "no such endpoint".
  {
    code: 'DEPENDENCY_NOT_LANDED',
    status: 501,
    meaning: 'The command exists; the part it rests on has not',
    source: 'T1f, unregistered',
  },
  {
    code: 'COMMAND_BODY_INVALID',
    status: 400,
    meaning: 'The request body is not an object of the command’s fields',
    source: 'T1f, unregistered',
  },
  // `WRONG_BUSINESS` never reaches a caller; the envelope translates it. The
  // status is here so the table stays complete and reads the same as the one the
  // caller would get if it ever did.
  {
    code: 'WRONG_BUSINESS',
    status: 404,
    meaning: 'The record belongs to another business',
    source: 'contract 4.4',
    visibility: 'audit',
  },

  // The agent's own identity, L2's `identity/agent-login.ts`. An agent login and
  // a person's login are two credentials and resolve through two paths, so "no
  // agent identity" is its own answer and never `AUTH_UNKNOWN_LOGIN`.
  //
  // `AUTH_SESSION_EXPIRED` is a 401 and not a 403 because it is the re-login
  // path: a client that cannot tell "sign in again" from "you may not see this"
  // shows the wrong door to the caller.
  {
    code: 'AUTH_NO_AGENT_IDENTITY',
    status: 401,
    meaning: 'The credential is not an agent login in this business',
    source: 'L2 AUTHORITY.md',
  },
  {
    code: 'AUTH_SESSION_EXPIRED',
    status: 401,
    meaning: 'The verified token has expired; sign in again',
    source: 'L2 AUTHORITY.md',
  },

  // Delegation and lease, T1's pickup and handback. No table yet.
  {
    code: 'DELEGATION_EXCLUDES_OPERATION',
    status: 403,
    meaning: 'Outside the delegation’s permitted set',
    source: 'contract 4.4',
  },
  {
    code: 'DELEGATION_EXCLUDES_DECISION',
    status: 403,
    meaning: 'A decision is excluded from every delegation',
    source: 'contract 4.4',
  },
  {
    code: 'DELEGATION_EXCLUDES_INTAKE',
    status: 403,
    meaning: 'Intake is reachable only inside a decision',
    source: 'contract 6.1',
  },
  {
    code: 'DELEGATION_NARROWED',
    status: 403,
    meaning: 'The person’s grant no longer covers this call',
    source: 'contract 4.4',
  },
  {
    code: 'DELEGATION_OUT_OF_PURPOSE',
    status: 403,
    meaning: 'The call is outside the purpose the delegation was minted for',
    source: 'L2 AUTHORITY.md',
  },
  {
    code: 'DELEGATION_NOT_LIVE',
    status: 401,
    meaning: 'The delegation is expired, revoked or settled',
    source: 'L2 AUTHORITY.md',
  },
  {
    code: 'DELEGATION_WIDENS',
    status: 403,
    meaning: 'A mint would exceed what the delegating person holds',
    source: 'L2 AUTHORITY.md',
  },
  {
    code: 'DELEGATION_ALREADY_LIVE',
    status: 409,
    meaning: 'The agent already holds a live delegation for this purpose',
    source: 'L2 AUTHORITY.md',
  },
  {
    code: 'DELEGATION_EXPIRED',
    status: 403,
    meaning: 'The delegation minted at pickup has run out',
    source: 'contract 4.4',
  },
  {
    code: 'DELEGATION_REVOKED',
    status: 403,
    meaning: 'The delegation was withdrawn',
    source: 'contract 4.4',
  },
  {
    code: 'LEASE_HELD',
    status: 409,
    meaning: 'Another worker holds the lease on this work',
    source: 'contract 4.4',
    runtime: true,
  },
  {
    code: 'LEASE_EXPIRED',
    status: 410,
    meaning: 'The lease ended before the handback arrived',
    source: 'contract 4.4',
    runtime: true,
  },
  {
    code: 'LEASE_NOT_OWNED',
    status: 403,
    meaning: 'The lease belongs to another holder',
    source: 'contract 4.4',
    runtime: true,
  },
  {
    code: 'TASK_NOT_PICKABLE',
    status: 409,
    meaning: 'The task is not in a state a worker may pick up',
    source: 'contract 4.3',
  },

  // Comments, T1's fourth observable result. No record type yet.
  {
    code: 'AUDIENCE_NOT_PERMITTED',
    status: 422,
    meaning: 'The caller may not write in that audience',
    source: 'contract 4.3',
  },

  // The preset planner, L2's `records/preset-plan.ts`. A preset that is itself
  // wrong comes back naming the field keys so the author can classify them.
  {
    code: 'PRESET_FIELD_UNCLASSIFIED',
    status: 422,
    meaning: 'A preset field carries no write mode, or one the model does not have',
    source: 'spec D05',
  },
  // The preset names a record type this business does not have, which is the same
  // kind of answer as an identifier that is not there.
  {
    code: 'PRESET_TYPE_UNKNOWN',
    status: 404,
    meaning: 'This business has no record type by that key',
    source: 'spec D05',
  },
  // The model is in a state that cannot hold the field. Not the caller's syntax
  // and not their authority: something has to move first.
  {
    code: 'PRESET_FIELD_UNPLACEABLE',
    status: 409,
    meaning: 'No free indexed slot of the field’s type remains',
    source: 'spec D05',
  },
  {
    code: 'PRESET_FIELD_DUPLICATE',
    status: 422,
    meaning: 'One preset names the same new field key more than once',
    source: 'spec D05',
  },

  // Gates and proposals, T2.
  {
    code: 'GATE_PENDING',
    status: 409,
    meaning: 'A blocking gate instance is open on this record',
    source: 'contract 4.3',
  },
  {
    code: 'GATE_ALREADY_DECIDED',
    status: 409,
    meaning: 'The gate instance carries a decision already',
    source: 'contract 4.4',
    runtime: true,
  },
  {
    code: 'GATE_NOT_APPROVED',
    status: 409,
    meaning: 'The named decision is not an approval',
    source: 'contract 6.1',
  },
  {
    code: 'PROPOSAL_SUPERSEDED',
    status: 409,
    meaning: 'A later version of the proposal exists',
    source: 'contract 4.4',
  },
  {
    code: 'PROPOSAL_SCOPE_EXCEEDED',
    status: 422,
    meaning: 'The proposal reaches past what was authorised',
    source: 'contract 4.3',
  },
  {
    code: 'FOUR_EYES_REQUIRED',
    status: 409,
    meaning: 'The gate needs a second approver',
    source: 'contract 4.4',
  },

  // Budget, T1k. For the runtime, the envelope cannot hold the accepted maximum.
  {
    code: 'BUDGET_UNAVAILABLE',
    status: 409,
    meaning: 'No committed reservation covers this attempt',
    source: 'contract 4.4',
    runtime: true,
  },
  // The cap has nothing left. Distinct from unavailable on purpose (W05): `402`
  // for a spent cap and `409` for a full envelope are two answers because a
  // caller told the wrong one raises the wrong ceiling. The first needs more
  // money behind the business, the second needs room on this task.
  {
    code: 'BUDGET_EXHAUSTED',
    status: 402,
    meaning: 'The reservation is spent',
    source: 'contract 4.4',
    runtime: true,
  },

  // L4's bounded runtime, `core-runtime/src/refusals.ts`. Seven of its eighteen
  // are the six above plus `SCOPE_NOT_GRANTED`, already registered by the parts
  // that named them first; these eleven are new spellings and they come in here
  // rather than being invented a second time in a handler. The last three arrived
  // with L4's review fixes (R2, R3 and R6) and are registered on the same terms
  // as the eight before them.
  //
  // The gate names a version that is no longer the live one.
  {
    code: 'VERSION_SUPERSEDED',
    status: 409,
    meaning: 'A later version of this proposal is the live one',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
  // The gate's stored digest and the version's own disagree.
  {
    code: 'EVIDENCE_MISMATCH',
    status: 409,
    meaning: 'The gate\u2019s digest and the version\u2019s disagree',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
  // No gate by that identity, which is the same kind of answer as `NOT_FOUND`.
  {
    code: 'GATE_NOT_FOUND',
    status: 404,
    meaning: 'No gate by that identity in this business',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
  // `410` rather than `409` for a window that has closed, here and for
  // `LEASE_EXPIRED`, because re-reading and retrying will never make an expired
  // gate or an expired lease live again: a new proposal or a new pickup is the
  // only way forward.
  {
    code: 'GATE_EXPIRED',
    status: 410,
    meaning: 'The gate\u2019s decision window has closed',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
  // Only an authorised restart opens a new lineage.
  {
    code: 'LINEAGE_TERMINAL',
    status: 409,
    meaning: 'The lineage is rejected or cancelled',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
  // A third formal round (G08).
  {
    code: 'CHANGE_ROUNDS_EXHAUSTED',
    status: 409,
    meaning: 'Two formal rounds are used and there is no third',
    source: 'spec G08',
    runtime: true,
  },
  // The proposal asks for more than the caller's authority covers.
  {
    code: 'PROPOSAL_OUT_OF_SCOPE',
    status: 403,
    meaning: 'The proposal reaches past the caller\u2019s authority',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
  {
    code: 'RESERVATION_NOT_CLAIMABLE',
    status: 409,
    meaning: 'The reservation is not approved, held and unpicked',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
  // This and `CAP_BINDING_MISMATCH` are "something on this task has already been
  // bound and does not match", not a malformed request: the lineage belongs to
  // another task and the envelope draws on another cap or another currency. Re-
  // reading the task and naming what it is actually bound to is the way forward,
  // which is what a 409 tells a caller and a 422 would not.
  {
    code: 'LINEAGE_NOT_ON_TASK',
    status: 409,
    meaning: 'The proposal names a lineage opened on another task',
    source: 'L4 RUNTIME.md R3',
    runtime: true,
  },
  {
    code: 'CAP_BINDING_MISMATCH',
    status: 409,
    meaning: 'The decision names a cap or a currency the task’s envelope does not hold',
    source: 'L4 RUNTIME.md R2',
    runtime: true,
  },
  // This head dispatches nothing, so it has no observed expenditure to settle
  // (R6). The body is well formed and the caller is allowed; the field itself is
  // one this head cannot honestly accept. Retrying with a null actual is the fix,
  // and no state has to move first, so it is a 422 rather than a 409.
  {
    code: 'ACTUAL_EXPENDITURE_UNSUPPORTED',
    status: 422,
    meaning: 'The handback reports spending nothing in this head could have made',
    source: 'L4 RUNTIME.md R6',
    runtime: true,
  },
  // The successor a handback asked for is outside the bounds a settlement may
  // propose within: the cap behind the envelope, that envelope's currency, or the
  // lineage's two formal rounds (R4, T4).
  {
    code: 'SUCCESSOR_OUT_OF_BOUNDS',
    status: 409,
    meaning: 'The successor the handback proposes falls outside the purpose it was held under',
    source: 'L4 RUNTIME.md',
    runtime: true,
  },
] as const;

/** Every registered code. Declared by the rows above and nowhere else. */
export type RefusalCode = (typeof ROWS)[number]['code'];

/**
 * The codes `core-runtime` returns as its own (`core-runtime/src/refusals.ts`).
 * A narrow union for that module's own types, taken from the rows marked
 * `runtime` rather than spelled a second time there.
 */
export type RuntimeRefusalCode = Extract<(typeof ROWS)[number], { readonly runtime: true }>['code'];

export interface RegisterEntry {
  readonly code: RefusalCode;
  /** The HTTP status the refusal is carried under. */
  readonly status: RefusalStatus;
  /** `audit` means the caller is shown something else. Exactly one code is. */
  readonly visibility: Visibility;
  /** One line, so a register a person reads is the same one the code reads. */
  readonly meaning: string;
  /** The contract row that owns the code, so a reader can go and check it. */
  readonly source: string;
  /** Whether `core-runtime` returns it as one of its own codes. */
  readonly runtime: boolean;
}

export const REFUSAL_REGISTER: readonly RegisterEntry[] = ROWS.map(
  (row: Declared & { readonly code: RefusalCode }) => ({
    code: row.code,
    status: row.status,
    visibility: row.visibility ?? 'caller',
    meaning: row.meaning,
    source: row.source,
    runtime: row.runtime ?? false,
  }),
);

const BY_CODE = new Map(REFUSAL_REGISTER.map((row) => [row.code, row]));

export function registeredRefusal(code: RefusalCode): RegisterEntry | undefined {
  return BY_CODE.get(code);
}

/** The status a registered code is carried under. */
export function statusOf(code: RefusalCode): RefusalStatus {
  const row = BY_CODE.get(code);
  if (row === undefined) throw new Error(`statusOf: ${code} is not in the refusal register.`);
  return row.status;
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
 * **`WRONG_BUSINESS` is on this list by contract, not as a gap.** Minimum
 * contract 4.4 (`research/minimum-contract-2026-09-10/CONTRACT.md:365-371`,
 * corrected 14 September 2026) registers it as unproducible and struck the
 * requirement that the audit record it; 8.2 case 1 (`:491`) repeats the
 * correction. Telling "another business holds this identifier" from "no such
 * identifier" needs a read that is not scoped to the caller's business, and
 * the tenancy law forbids one: row security is forced, the application role
 * owns nothing, and a definer-rights function that answered the question is
 * exactly what case T1-N14 exists to attack. So a cross-business probe is
 * refused `NOT_FOUND` to the caller and audited as `NOT_FOUND` in the prober's
 * own business, and the probed business is not told (the known limit the
 * contract records at `:371`). The code stays registered and unreachable;
 * `tests/tenancy/production-lookup.test.ts` asserts it absent from the audit.
 */
export const UNPRODUCED_CODES: ReadonlySet<RefusalCode> = new Set([
  'WRONG_BUSINESS',
  // Delegation codes no reachable operation raises. `DELEGATION_NARROWED`
  // left this list with `grant.revoke`, the route that revokes the delegating
  // person's grant between a pickup and the agent's next call. `DELEGATION_WIDENS` is a mint refusal and
  // `task.pickup` mints from the authorising person's own live grants, so it
  // cannot construct a widening one. The other three name a delegation
  // lifecycle — intake, expiry as its own answer, an explicit revocation — that
  // this head's one-task purpose does not distinguish.
  'DELEGATION_WIDENS',
  // `DELEGATION_ALREADY_LIVE` came off this list with its emitter:
  // `authority/delegations.ts` refuses a second mint under a purpose the agent
  // already holds live, and `task.pickup` reaches it as a 409 instead of the
  // 503 the unique index used to raise. `DELEGATION_EXCLUDES_OPERATION` came
  // off too: `agent-envelope.ts` refuses with it any operation outside
  // `AGENT_SURFACE`, and `tests/commands/unproduced-reach.test.ts` reaches it.
  'DELEGATION_EXCLUDES_INTAKE',
  'DELEGATION_EXPIRED',
  'DELEGATION_REVOKED',
  // T2 spellings the runtime did not adopt. It raises `GATE_ALREADY_DECIDED`
  // where these say pending and superseded, and nothing produces these two.
  'GATE_PENDING',
  'PROPOSAL_SUPERSEDED',
  'PROPOSAL_SCOPE_EXCEEDED',
  'TASK_NOT_PICKABLE',
  // The two L4 codes that need something no caller can reach.
  //
  // `EVIDENCE_MISMATCH` needs a gate whose stored digest and version's own
  // disagree, and `propose` writes both from one value, so only an amended row
  // produces it. `LEASE_EXPIRED` needs a handback on a lease that has expired
  // or left `live`, and the agent path meets something else first: `pickup`
  // mints the delegation with the lease's own expiry, so an expired lease
  // arrives as `DELEGATION_NOT_LIVE`; a newer pickup answers
  // `LEASE_NOT_OWNED`; and the handback that settles a lease settles its
  // delegation too.
  //
  // `GATE_EXPIRED` and `CHANGE_ROUNDS_EXHAUSTED` came off this list when a
  // command case reached each (`tests/commands/unproduced-reach.test.ts`):
  // `task.propose` takes `expiresInSeconds`, so a one-second window closes
  // before the decision, and `task.propose` on a lineage plus `task.decide`
  // reach the third round. `LEASE_HELD` came off the same way
  // (`tests/commands/lease-held-reach.test.ts`). A second pickup of the *same*
  // reservation meets `RESERVATION_NOT_CLAIMABLE` first, but pickup keeps a
  // reservation `held`, and a handback releases its hold without closing the
  // task's envelope, so two new lineages approved on one task give two held
  // reservations: the second pickup meets the first one's live lease.
  'EVIDENCE_MISMATCH',
  'LEASE_EXPIRED',
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
