// SPDX-License-Identifier: AGPL-3.0-only
//
// The four operations that were declared, routed, audited and refusing.
//
// `task.propose`, `task.decide`, `task.pickup` and `task.handback` sat in
// `pending.ts` answering `DEPENDENCY_NOT_LANDED` because the gate triple, the
// lease table and the reservation were not in the tree. L4 built them and
// pinned nine exports on `core-runtime/src/index.ts`; this module is the whole
// of what L3 adds, which is the envelope around them.
//
// **What the envelope contributes, and why it is here rather than there.**
//
// 1. *The repeat-request identity.* `propose` and `decide` take no
//    `operationId` — L4 says so in as many words, because the register is this
//    unit's mechanism. A command going through `runCommand` has it already, so
//    a proposal submitted twice under one identity replays the first answer
//    instead of opening a second lineage.
// 2. *The audit trail.* `core-runtime` writes no `audit_events` row, on
//    purpose: the first attempt to write one from `handback.ts` aborted the
//    transaction on a column that does not exist, which is the right answer to
//    a second writer reaching into another unit's trail. So every success and
//    every refusal here is audited by `envelope.ts` around this module,
//    **including the loser of a decision race** (G03): a `GATE_ALREADY_DECIDED`
//    refusal is a refused attempt like any other and leaves the same row.
// 3. *Rolling a refusal back.* A returned runtime refusal must not commit what
//    the handler touched on the way to it. That is `attemptWork`'s savepoint
//    and it costs nothing here: a refusal is a value, so it travels back out
//    through `refused(...)` and the savepoint goes with it. The one thing this
//    module must not do is raise — an exception would take the transaction and
//    the audit row with it.
//
// **What the caller may not name.** The actor, the person, the subjects, the
// signing key, the cap and the authorising person are all the server's. The
// payloads below carry what the proposal *is* and nothing about who is making
// it, which is the same rule `requests.ts` states for `actorId` and
// `businessId`: a field a caller could fill is a field a caller can claim.

import type { TenantQuery } from '../tenancy/database.ts';
import { subjectsOf } from '../authority/grants.ts';
import {
  handback,
  pickup,
  propose,
  decide,
  type AnyRefusal,
  type DecisionKind,
  type SuccessorRequest,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import {
  applied,
  refused,
  refusedRetaining,
  type HandlerOutcome,
  type Refused,
} from './outcome.ts';
import type { RefusalCode } from './register.ts';
import { gateSigningKey, readBusinessCapId } from './runtime-config.ts';

/**
 * A runtime or delegation refusal as the command register spells it.
 *
 * Every code in both unions is registered (`tests/commands/runtime-codes.test.ts`
 * asserts the fifteen), so `refuseCommand` cannot be handed a spelling the
 * register has never heard of; if it ever is, its own constructor raises
 * rather than inventing one. The reason and the fix go into `fixes` beside
 * each other for the same reason `fromAuthority` puts them there: both are
 * sentences about the rule, neither is a value the caller sent.
 */
export function fromRuntime(refusal: AnyRefusal): CommandRefusal {
  return refuseCommand(refusal.code as RefusalCode, [], [refusal.reason, refusal.fix]);
}

/** The window a proposal's gate stays open for, when the caller names none. */
const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export interface ProposeFields {
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly step: { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> };
  readonly expiresInSeconds?: number;
  readonly lineageId?: string;
}

/**
 * The shape `proposal_versions_purpose_shape` and `delegations_purpose_shape`
 * both hold (`migrations/0010_runtime_proposals.sql:122`). Kept here as the
 * same expression so the refusal and the constraint cannot drift apart.
 */
const PURPOSE_SHAPE = /^[a-z][a-z0-9_]{0,62}$/u;

/** `planned_steps.kind` is `not null` and `payload` is `jsonb not null`. */
function isStep(step: unknown): step is { readonly kind: string; readonly payload: object } {
  if (typeof step !== 'object' || step === null) return false;
  const candidate = step as { kind?: unknown; payload?: unknown };
  if (typeof candidate.kind !== 'string' || candidate.kind === '') return false;
  return typeof candidate.payload === 'object' && candidate.payload !== null;
}

/**
 * A proposal on the locked task.
 *
 * The expiry is named as a duration and turned into an instant **here**,
 * rather than taken as a date from the body. A caller who could post an
 * absolute `expiresAt` could post one in the past and raise a gate nobody can
 * decide, or one ten years out and hold a ceiling open indefinitely; a
 * duration the server adds to its own clock can do neither.
 */
export async function proposeOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: ProposeFields,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('proposeOnTask: reached without a locked task');
  // Two shapes the columns constrain, answered here rather than left to the
  // constraint. `proposal_versions_purpose_shape` and `planned_steps.kind not
  // null` both fault at the write, and a fault reaches the caller as
  // `SERVICE_UNAVAILABLE` 503 -- a malformed request shown as a broken server,
  // which is the difference checklist B7 asks to be real (WEB-PROPOSALS
  // handback, "Interface gaps for L3" 4). `FIELD_VALUE_INVALID` 422 is already
  // on this operation's row in `docs/local/API.md`.
  if (!PURPOSE_SHAPE.test(fields.purpose)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['purpose'],
        [
          'A purpose is lower-case letters, digits and underscores, starting with a letter, up to 63 characters.',
        ],
      ),
      { purpose: fields.purpose },
    );
  }
  if (!isStep(fields.step)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['step'],
        ['Send a step as { kind, payload }, with a non-empty kind and an object payload.'],
      ),
      { step: fields.step },
    );
  }

  const seconds = fields.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['expiresInSeconds'],
        ['Name a whole number of seconds greater than zero, or leave it out for a week.'],
      ),
      { expiresInSeconds: fields.expiresInSeconds },
    );
  }

  const result = await propose(tx, {
    taskId: target.id,
    collection: context.declaration.collection,
    proposedByActorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    purpose: fields.purpose,
    maximumMinor: fields.maximumMinor,
    currency: fields.currency,
    payload: { ...fields.payload },
    step: { kind: fields.step.kind, payload: { ...fields.step.payload } },
    expiresAt: new Date(Date.now() + seconds * 1000),
    ...(fields.lineageId === undefined ? {} : { lineageId: fields.lineageId }),
  });
  if (!result.ok) return refused(fromRuntime(result.refusal));

  // The revision is the task's own and is unchanged: a proposal is a record
  // beside the task, not an edit to it, so a caller may keep writing against
  // the revision they hold. `task.comment` answers the same way.
  return applied(target.id, target.revision, {
    lineageId: result.value.lineageId,
    versionId: result.value.versionId,
    version: result.value.version,
    runId: result.value.runId,
    stepId: result.value.stepId,
    evidencePackId: result.value.evidencePackId,
    gateId: result.value.gateId,
    payloadDigest: result.value.payloadDigest,
  });
}

export interface DecideFields {
  readonly gateId: string;
  /** The exact version the caller read. Compared under the locks, never trusted. */
  readonly versionId: string;
  readonly decision: string;
  readonly note: string;
}

const DECISIONS: ReadonlySet<string> = new Set(['approve', 'reject', 'request_changes']);

export async function decideOnGate(
  tx: TenantQuery,
  context: CommandContext,
  fields: DecideFields,
): Promise<HandlerOutcome> {
  if (!DECISIONS.has(fields.decision)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['decision'],
        ['A decision is approve, reject or request_changes.'],
      ),
      { decision: fields.decision },
    );
  }

  const signingKey = gateSigningKey();
  if (signingKey === undefined) {
    // Not a refusal about the caller. The chain is signed or it is not written,
    // and a deployment with no key configured has not built the part this
    // command rests on, which is what this code has always meant.
    return refused(
      refuseCommand(
        'DEPENDENCY_NOT_LANDED',
        ['task.decide', 'GATE_SIGNING_KEY_ID and GATE_SIGNING_SECRET'],
        [
          'This deployment has no decision signing key configured.',
          'It is not a permission problem and retrying will not change it.',
        ],
      ),
    );
  }

  const capId = await readBusinessCapId(tx);
  if (capId === undefined) {
    return refused(
      refuseCommand(
        'BUDGET_UNAVAILABLE',
        ['budget_caps.local'],
        [
          'This business has no budget cap, so there is nothing an approval could draw on.',
          'An administrator installs the cap; a decision does not create one.',
        ],
      ),
    );
  }

  const result = await decide(tx, {
    gateId: fields.gateId,
    versionId: fields.versionId,
    decidedByPersonId: context.session.personId,
    decidedByActorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    collection: context.declaration.collection,
    decision: fields.decision as DecisionKind,
    note: fields.note,
    signingKey,
    capId,
  });
  if (!result.ok) return refused(fromRuntime(result.refusal));

  const decided = result.value;
  return applied(null, null, {
    decisionId: decided.decisionId,
    gateId: decided.gateId,
    versionId: decided.versionId,
    decision: decided.decision,
    hash: decided.hash,
    ...(decided.envelopeId === undefined ? {} : { envelopeId: decided.envelopeId }),
    ...(decided.reservationId === undefined ? {} : { reservationId: decided.reservationId }),
    ...(decided.attemptId === undefined ? {} : { attemptId: decided.attemptId }),
    ...(decided.heldMinor === undefined ? {} : { heldMinor: decided.heldMinor }),
  });
}

/** How long a lease runs when the caller names nothing. Bounded, and the server's. */
const DEFAULT_LEASE_SECONDS = 15 * 60;
const MAXIMUM_LEASE_SECONDS = 60 * 60;

export interface PickupFields {
  readonly reservationId: string;
  readonly leaseSeconds?: number;
}

/**
 * The agent's own identity picks the reservation up, and the authority it will
 * carry is **not** its own.
 *
 * `authorisedByPersonId` is read from the approving decision rather than taken
 * from the payload, which is the load-bearing part. The delegation's ceiling
 * is the live grants of the person who approved the work — `checkDelegatedAuthority`
 * asks `effectiveGrants` what that person holds on every call — so a body that
 * could name the authorising person would be a body that could name whose
 * authority the agent borrows. There is no field for it here for the same
 * reason there is no field for `actorId`.
 */
export async function pickupReservation(
  tx: TenantQuery,
  collection: string,
  agentActorId: string,
  fields: PickupFields,
): Promise<HandlerOutcome> {
  const seconds = fields.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > MAXIMUM_LEASE_SECONDS) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['leaseSeconds'],
        [`Name a whole number of seconds from 1 to ${MAXIMUM_LEASE_SECONDS}, or leave it out.`],
      ),
      { leaseSeconds: fields.leaseSeconds },
    );
  }

  const approver = await approvingPerson(tx, fields.reservationId);
  if (approver === undefined) {
    // No approval behind this reservation, or no reservation. Either way there
    // is nothing here a worker may claim, and the runtime's own code for that
    // is the one to answer with rather than a second spelling.
    return refused(
      refuseCommand(
        'RESERVATION_NOT_CLAIMABLE',
        [],
        [
          'Name a reservation from task.queue: approved, held and not already picked up.',
          'A reservation with no approval behind it is not work anybody authorised.',
        ],
      ),
    );
  }

  const result = await pickup(tx, {
    reservationId: fields.reservationId,
    agentActorId,
    authorisedByPersonId: approver.personId,
    mintedByActorId: approver.actorId,
    collection,
    leaseSeconds: seconds,
  });
  if (!result.ok) return refused(fromRuntime(result.refusal));

  const picked = result.value;
  return applied(picked.taskId, null, {
    leaseId: picked.leaseId,
    fence: picked.fence,
    reservationId: picked.reservationId,
    attemptId: picked.attemptId,
    taskId: picked.taskId,
    runId: picked.runId,
    versionId: picked.versionId,
    expiresAt: picked.expiresAt.toISOString(),
    declaredIncompleteness: picked.declaredIncompleteness,
    // Returned once and stored only as a digest. It is in the detail because
    // the agent has to present it on its next call and there is nowhere else
    // it could come from; it is never read back, by anybody, afterwards.
    delegationId: picked.delegation.delegation.id,
    credential: picked.delegation.credential,
    purposeScope: picked.delegation.delegation.purposeScope,
  });
}

interface Approver {
  readonly personId: string;
  readonly actorId: string;
}

/** The person whose approval put this reservation on the queue. */
async function approvingPerson(
  tx: TenantQuery,
  reservationId: string,
): Promise<Approver | undefined> {
  const rows = await tx.query<{
    readonly decided_by_person_id: string;
    readonly decided_by_actor_id: string;
  }>(
    `select d.decided_by_person_id, d.decided_by_actor_id
       from public.reservations res
       join public.gate_decisions d
         on d.business_id = res.business_id and d.version_id = res.version_id
      where res.business_id = $1 and res.id = $2 and d.decision = 'approve'
      order by d.seq desc
      limit 1`,
    [tx.businessId, reservationId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { personId: row.decided_by_person_id, actorId: row.decided_by_actor_id };
}

export interface HandbackFields {
  readonly leaseId: string;
  readonly fence: number;
  readonly outcome: string;
  readonly report?: Readonly<Record<string, unknown>>;
  /** Declared only so that sending one is a refusal rather than a silence. */
  readonly actualMinor?: number | null;
  /**
   * The successor the caller asks for, exactly as the body carried it.
   *
   * `unknown` rather than a shape, because this is the boundary that decides
   * whether the body is a shape at all: an HTTP body is untyped, and a field
   * typed here would be a field the surface believed without reading. Absent
   * is the ordinary handback and anything else is read by `readSuccessor`.
   */
  readonly successor?: unknown;
}

const OUTCOMES: ReadonlySet<string> = new Set(['completed', 'failed']);

/**
 * The handback refusals that have already written a report row L4 keeps.
 *
 * `core-runtime/src/handback.ts` calls its `retain` helper on exactly these
 * two before refusing, and `ACTUAL_EXPENDITURE_UNSUPPORTED` is deliberately
 * not among them: R6 refuses that one before the first write, so there is
 * nothing to keep.
 */
const RETAINING_REFUSALS: ReadonlySet<string> = new Set(['LEASE_NOT_OWNED', 'LEASE_EXPIRED']);

/**
 * The hold released, and `actualMinor` is `null` rather than a number.
 *
 * Nothing in this head dispatches, so nothing was spent, and the reservation
 * goes to `abandoned` rather than to a zero `actual`. A zero actual would be a
 * claim that the work ran and cost nothing, and the schema refuses it:
 * `reservations_actual_only_when_actual` makes carrying a number and being
 * `actual` the same fact. There is no payload field for it because there is no
 * honest value a caller could put in one.
 */
export async function handbackLease(
  tx: TenantQuery,
  fields: HandbackFields,
  agentActorId?: string,
): Promise<HandlerOutcome> {
  if (!OUTCOMES.has(fields.outcome)) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['outcome'], ['An outcome is completed or failed.']),
      { outcome: fields.outcome },
    );
  }
  if (!Number.isSafeInteger(fields.fence) || fields.fence < 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['fence'], ['Send the fence the pickup handed you.']),
      { fence: fields.fence },
    );
  }
  // L4's `handback` answers `ACTUAL_EXPENDITURE_UNSUPPORTED` for any non-null
  // `actualMinor`, and the command says so here rather than discarding the
  // key. Dropping it quietly is the failure D06 exists to stop from the other
  // direction: the caller is left believing a spend figure was recorded when
  // nothing read it. `null` and absent are the same answer and both are fine.
  if (fields.actualMinor !== undefined && fields.actualMinor !== null) {
    return refused(
      refuseCommand(
        'ACTUAL_EXPENDITURE_UNSUPPORTED',
        ['actualMinor'],
        [
          'Leave actualMinor out, or send null: nothing in this head dispatches.',
          'A number here would claim the work ran and cost that much.',
        ],
      ),
      { actualMinor: fields.actualMinor },
    );
  }

  // The successor, read before the runtime is reached. Every refusal below is
  // about the body rather than about the lease, so it costs the caller nothing
  // it holds: the lease is still live and the work can be handed back again.
  let successor: SuccessorRequest | undefined;
  if (fields.successor !== undefined && fields.successor !== null) {
    const read = readSuccessor(fields.successor, agentActorId);
    if ('refusal' in read) return read;
    successor = read.successor;
  }

  const result = await handback(tx, {
    leaseId: fields.leaseId,
    fence: fields.fence,
    outcome: fields.outcome as 'completed' | 'failed',
    report: { ...fields.report },
    actualMinor: null,
    ...(successor === undefined ? {} : { successor }),
  });
  if (!result.ok) {
    // R4, behavioural note 8. On these two paths the runtime has already
    // written the `handback_reports` row that keeps a stale holder's work, and
    // it says so in the row's `disposition = 'retained'`. The refusal and the
    // retained report are one fact and have to commit together, so this one
    // refusal is exempt from the savepoint every other refusal rolls back
    // through. The codes are named here rather than inferred, because a code
    // that starts retaining a row later should have to come and say so.
    return RETAINING_REFUSALS.has(result.refusal.code)
      ? refusedRetaining(fromRuntime(result.refusal))
      : refused(fromRuntime(result.refusal));
  }

  const settled = result.value;
  return applied(null, null, {
    leaseId: settled.leaseId,
    reservationId: settled.reservationId,
    attemptId: settled.attemptId,
    reservationState: settled.reservationState,
    classification: settled.classification,
    envelopeHeldMinor: settled.envelopeHeldMinor,
    envelopeActualMinor: settled.envelopeActualMinor,
    // R4's durable report. Its identity is the only handle a caller has on the
    // row the handback retained, and a report nobody can name is a report
    // nobody can read.
    reportId: settled.reportId,
    // The successor's four durable handles, null throughout when none was
    // asked for. They are in the same detail as the settlement because they
    // were written in the same transaction: T4 wants "the durable
    // handback/proposal handles in one response", and a caller that had to go
    // looking for its own gate could not tell the two halves apart.
    successorVersionId: settled.successorVersionId,
    successorGateId: settled.successorGateId,
    successorRunId: settled.successorRunId,
    successorStepId: settled.successorStepId,
  });
}

/**
 * The fields of a successor the server writes rather than the caller.
 *
 * One list and both spellings, for the same reason `SYSTEM_OWNED_FIELDS` keeps
 * both: a boundary that refused the camel case and accepted the snake case
 * would be a boundary a caller gets past by changing an underscore.
 */
const SUCCESSOR_SERVER_OWNED: readonly string[] = ['proposedByActorId', 'proposed_by_actor_id'];

const SUCCESSOR_ACTOR_FIXES: readonly string[] = [
  'The successor is recorded as proposed by the agent actor of your session, and that is not a field a body may send: remove it and send the request again.',
  'A body that could name the proposing actor could record a proposal as somebody else’s, which is the claim this boundary exists to refuse.',
];

/** A read successor, or the refusal that says why the body is not one. */
type ReadSuccessor = { readonly successor: SuccessorRequest } | Refused;

function invalidSuccessor(name: string, fix: string, attempted: unknown): Refused {
  return refused(refuseCommand('FIELD_VALUE_INVALID', [name], [fix]), { [name]: attempted });
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The caller's half of a successor, checked key by key.
 *
 * The half a caller sends is `purpose`, `maximumMinor`, `currency`, `payload`,
 * `step` and `expiresAt`. The actor is the session's and is added here, after
 * a body carrying one of its spellings has been refused: `FIELD_NOT_WRITABLE`
 * naming the key, which is the answer `prepare.ts` gives for every other field
 * the server owns. Overwriting it quietly would leave a caller believing it
 * had chosen the proposing actor, and D06 is the rule against exactly that.
 *
 * What is *not* checked here is whether the successor fits: the ceiling, the
 * currency and the lineage's rounds are bounds L4 reads under the handback's
 * own locks and answers with `SUCCESSOR_OUT_OF_BOUNDS`. A second copy of those
 * three here would be a second answer to one question.
 */
function readSuccessor(raw: unknown, agentActorId: string | undefined): ReadSuccessor {
  if (!isObject(raw)) {
    return invalidSuccessor(
      'successor',
      'A successor is an object with a purpose, a maximum, a currency, a payload and a step.',
      raw,
    );
  }

  const claimed = SUCCESSOR_SERVER_OWNED.find((field) => field in raw);
  if (claimed !== undefined) {
    return refused(
      refuseCommand('FIELD_NOT_WRITABLE', [`successor.${claimed}`], SUCCESSOR_ACTOR_FIXES),
      { [`successor.${claimed}`]: raw[claimed] },
    );
  }

  // No actor to record it against, so there is no honest proposal to write.
  // `pickup` and `handback` are the agent's own operations and the entry point
  // hands the actor in; a call that reached here without one is a call from a
  // door that does not have one.
  if (agentActorId === undefined || agentActorId === '') {
    return refused(
      refuseCommand(
        'AUTH_NO_AGENT_IDENTITY',
        ['successor'],
        [
          'A successor is proposed by the agent that did the work, so it is asked for on the agent entry point.',
          'Present the agent credential and hand the lease back there.',
        ],
      ),
    );
  }

  const purpose = raw['purpose'];
  if (typeof purpose !== 'string' || purpose === '') {
    return invalidSuccessor(
      'successor.purpose',
      'Name the purpose the successor works to.',
      purpose,
    );
  }
  const maximumMinor = raw['maximumMinor'];
  if (typeof maximumMinor !== 'number' || !Number.isSafeInteger(maximumMinor)) {
    return invalidSuccessor(
      'successor.maximumMinor',
      'Name the ceiling as a whole number of minor units.',
      maximumMinor,
    );
  }
  const currency = raw['currency'];
  if (typeof currency !== 'string' || currency === '') {
    return invalidSuccessor(
      'successor.currency',
      'Name the currency the envelope holds, as a three-letter code.',
      currency,
    );
  }
  const payload = raw['payload'];
  if (!isObject(payload)) {
    return invalidSuccessor('successor.payload', 'The payload is an object.', payload);
  }
  const step = raw['step'];
  if (!isObject(step) || typeof step['kind'] !== 'string' || !isObject(step['payload'])) {
    return invalidSuccessor(
      'successor.step',
      'A step is an object with a kind and a payload object.',
      step,
    );
  }

  // Absent is the server's own week ahead, as `proposeOnTask` computes one. A
  // named instant is read here and refused when it is not one or has already
  // passed: a gate that opened in the past is a gate nobody can decide.
  const named = raw['expiresAt'];
  let expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_SECONDS * 1000);
  if (named !== undefined && named !== null) {
    const parsed = typeof named === 'string' ? new Date(named) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return invalidSuccessor(
        'successor.expiresAt',
        'Name an ISO-8601 instant in the future, or leave it out for a week.',
        named,
      );
    }
    expiresAt = parsed;
  }

  return {
    successor: {
      proposedByActorId: agentActorId,
      purpose,
      maximumMinor,
      currency,
      payload: { ...payload },
      step: { kind: step['kind'], payload: { ...(step['payload'] as Record<string, unknown>) } },
      expiresAt,
    },
  };
}
