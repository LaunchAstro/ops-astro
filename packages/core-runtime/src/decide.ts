// SPDX-License-Identifier: AGPL-3.0-only
//
// T2: decide, and reserve before pickup.
//
// A person decides. The agent's refusal is `DELEGATION_EXCLUDES_DECISION`,
// produced by `checkDelegatedAuthority` and returned here unchanged.
// `decideAsAgent` exists for exactly that: to consume that answer rather than
// re-derive it, because a second module that decides for itself what an agent
// may decide is a second place that rule can drift out of step with the schema
// constraint holding it in 0008.
//
// The lock order is the contract's and the reason is G03. Cap and envelope are
// taken **before** the gate, so the second of two concurrent approvals waits on
// the gate row rather than on a budget row it would reach later — a decision
// that loses must lose by the lock, never by a check that ran before it. Every
// binding is then re-read under the locks, because the values discovered
// before them are values another transaction was free to change.
//
// The approval commits five things together or none: the signed decision and
// its chain link, the envelope, the reservation, the immutable attempt row,
// and the held total. W01's kill-before-commit case must find nothing.

import { randomUUID } from 'node:crypto';
import {
  checkAuthority,
  checkDelegatedAuthority,
  fourEyesRequired,
  gateAlreadyDecided,
  refuseCommand,
} from '../../core-records/src/index.ts';
import type {
  CommandRefusal,
  TenantQuery,
  Subject,
  Delegation,
} from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import { capCommitted, capVerdict, envelopeVerdict, openEnvelopeOf } from './budget.ts';
import { roundsUsed } from './proposal-writer.ts';
import { only } from './only.ts';
import {
  affectedByVersions,
  checkAuthorityAt,
  classifyVersions,
  holdCoveringGrants,
} from './recovery.ts';
import type { LockSet } from './locks.ts';
import { lockRediscovered } from './rediscovery.ts';
import {
  CHAIN_GENESIS,
  LINK_VERSION,
  chainHash,
  decidedAtText,
  decisionLink,
  decisionPayload,
  digestOf,
  sign,
  type SigningKey,
} from './signing.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/**
 * A note that cannot be stored. `FIELD_VALUE_INVALID` is
 * the request layer's code, not one of the runtime's own register rows, so it
 * is typed here beside `decide` rather than widened into `RuntimeRefusalCode`.
 */
export type DecideResult =
  | RuntimeResult<Decided>
  | { readonly ok: false; readonly refusal: CommandRefusal<'FIELD_VALUE_INVALID'> };

const NUL = String.fromCodePoint(0);
// With the `u` flag a paired surrogate reads as one code point, so this
// matches only an unpaired one (`isWellFormed` is past this tree's ES2023 lib).
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * The note is signed and stored inside a jsonb payload, and jsonb refuses a
 * NUL and a lone surrogate. Left to the insert, either raised after the gate
 * was locked and the envelope recorded a fault; a retry of the same body could
 * never succeed. The same rule `commands/values.ts` applies to text fields.
 */
function noteFault(note: unknown): string | null {
  if (typeof note !== 'string') return 'the note is not a string';
  if (note.includes(NUL)) return 'the note contains a NUL character';
  if (LONE_SURROGATE.test(note)) return 'the note contains a lone surrogate';
  return null;
}

/** The pinned synthetic estimator. Not a provider, not a production price. */
export const SYNTHETIC_PRICE_BOOK = 'synthetic/bounded-attempt@1';

export type DecisionKind = 'approve' | 'reject' | 'request_changes' | 'escalate';

export interface DecideRequest {
  readonly gateId: string;
  /** The version the caller believes it is deciding. Compared, never trusted. */
  readonly versionId: string;
  readonly decidedByPersonId: string;
  readonly decidedByActorId: string;
  readonly subjects: readonly Subject[];
  readonly collection: string;
  readonly decision: DecisionKind;
  readonly note: string;
  readonly signingKey: SigningKey;
  /** The cap the envelope draws on. The fixture's finite synthetic one. */
  readonly capId: string;
  /** Escalate's recipient: a person who must hold decide at business scope. */
  readonly recipientPersonId?: string;
}

interface DecidedCommon {
  readonly decisionId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly hash: string;
}

/**
 * An approval reserves, and only an approval: the envelope, reservation,
 * attempt and held total exist on that branch and nowhere else, so a reader
 * narrows on `decision` before it reads one.
 */
export type Decided =
  | (DecidedCommon & {
      readonly decision: 'approve';
      readonly envelopeId: string;
      readonly reservationId: string;
      readonly attemptId: string;
      readonly heldMinor: number;
    })
  | (DecidedCommon & {
      readonly decision: 'reject' | 'request_changes';
    })
  | {
      // An escalation is not the gate's decision: no signed row, no hash.
      readonly decision: 'escalate';
      readonly gateId: string;
      readonly versionId: string;
      readonly escalatedToPersonId: string;
    };

interface GateRow {
  readonly id: string;
  readonly lineage_id: string;
  readonly version_id: string;
  readonly run_id: string;
  readonly step_id: string;
  readonly evidence_pack_id: string;
  readonly payload_digest: string;
  readonly state: string;
  readonly round: number;
  readonly expired: boolean;
  readonly escalated: boolean;
}

/**
 * What an agent gets. It asks the delegation check and returns its answer, so
 * the code a delegated caller sees is `DELEGATION_EXCLUDES_DECISION` in the
 * check's wording
 * and never a runtime code invented here.
 */
export async function decideAsAgent(
  tx: TenantQuery,
  delegation: Delegation,
  request: { readonly collection: string; readonly taskId: string },
): Promise<RuntimeResult<never>> {
  const decision = await checkDelegatedAuthority(tx, delegation, {
    collection: request.collection,
    action: 'decide',
    scope: { kind: 'record', id: request.taskId },
  });
  if (decision.ok) {
    // Unreachable through the delegation check, whose `DelegableAction`
    // excludes `decide` and whose check refuses it first. If it ever is
    // reached, the safe answer is still a refusal, and a loud one.
    throw new Error('decideAsAgent: checkDelegatedAuthority permitted a decision');
  }
  return { ok: false, refusal: decision.refusal };
}

/** A gate this business cannot decide: none by that id, or one on a trashed task. */
function gateNotFound(): RuntimeResult<never> {
  return refuse(
    'GATE_NOT_FOUND',
    'no such gate in this business',
    'Name a gate raised by a proposal on a task the caller can see.',
  );
}

export async function decide(tx: TenantQuery, presented: DecideRequest): Promise<DecideResult> {
  // The ids reach the database through a uuid
  // cast, which accepts any case, and come back lower-case; the version is
  // then compared with a string. One spelling from here on, so an upper-case
  // id of the gate's own version is that version and not a superseded one.
  const request: DecideRequest = {
    ...presented,
    gateId: presented.gateId.toLowerCase(),
    versionId: presented.versionId.toLowerCase(),
  };
  const fault = noteFault(request.note);
  if (fault !== null) {
    return {
      ok: false,
      refusal: refuseCommand(
        'FIELD_VALUE_INVALID',
        ['note'],
        [
          `note: ${fault}, so it cannot be signed and stored`,
          'Send the note as text without NUL characters or unpaired surrogates.',
        ],
      ),
    };
  }
  const found = await findGate(tx, request);
  if (!found.ok) return found;
  const lockedResult = await lockDecision(tx, request, found.value);
  if (!lockedResult.ok) return lockedResult;
  const locked = lockedResult.value;
  const rechecked = await recheckDecision(tx, request, found.value, locked);
  if (!rechecked.ok) return rechecked;
  const { gate, version, pack } = rechecked.value;
  if (request.decision === 'escalate') return await escalateGate(tx, request, gate);
  const written = await writeDecision(
    tx,
    { ...request, decision: request.decision },
    gate,
    pack.rendered_digest,
  );
  if (request.decision === 'reject') {
    // G05: terminal, and the unstarted holds this lineage owns are released by
    // the classifier through the cause recorded here -- not by this statement
    // quietly zeroing a number. R8: under the locks this transaction already
    // took for them.
    await tx.query(
      `update public.proposal_lineages
          set state = 'rejected', terminal_reason = 'gate_rejected', terminal_at = now()
        where business_id = $1 and id = $2`,
      [tx.businessId, gate.lineage_id],
    );
    await classifyVersions(
      tx,
      locked.lineageVersions,
      'lineage_rejected',
      gate.lineage_id,
      locked.locks,
    );
  }
  const common = { ...written, gateId: gate.id, versionId: gate.version_id };
  if (request.decision !== 'approve') {
    return { ok: true, value: { ...common, decision: request.decision } };
  }
  return await reserveApproval(tx, locked.capId, found.value.task_id, gate, version, common);
}

interface FoundGate {
  readonly lineage_id: string;
  readonly version_id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly state: string;
}

/**
 * Find and authorise, before any lock. Discovery acquires no authority:
 * everything read here is re-read under the locks, and this pass exists only
 * to learn which rows to lock. A trashed task's gate reads as no gate at all.
 *
 * The authority check here runs before any lock. If nothing held the grants,
 * a revocation could commit while this waited on the chain or the cap, and
 * the decision would still commit after it. So this holds the decide grants
 * for share here, before the runtime set, as pickup holds its own. A
 * revocation that locked first is seen by the re-check under the locks, and
 * one that comes second waits for this decision to commit.
 */
async function findGate(
  tx: TenantQuery,
  request: DecideRequest,
): Promise<RuntimeResult<FoundGate>> {
  const discovered = await tx.query<FoundGate>(
    `select g.lineage_id, g.version_id, g.run_id, r.task_id, l.state
       from public.gates g
       join public.planned_runs r on r.business_id = g.business_id and r.id = g.run_id
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
       join public.records t
         on t.business_id = r.business_id and t.id = r.task_id and t.deleted_at is null
      where g.business_id = $1 and g.id = $2`,
    [tx.businessId, request.gateId],
  );
  const found = discovered[0];
  if (found === undefined) return gateNotFound();

  const decisionDecision = await checkAuthority(tx, request.subjects, {
    collection: request.collection,
    action: 'decide',
    scope: { kind: 'record', id: found.task_id },
  });
  if (!decisionDecision.ok) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      'deciding this gate needs a decide grant on the task, and the caller holds none',
      'A person with decide authority on this task decides it.',
    );
  }
  await holdCoveringGrants(tx, request.subjects, request.collection);
  return { ok: true, value: found };
}

interface LockedDecision {
  readonly locks: LockSet;
  readonly capId: string;
  readonly existing: Awaited<ReturnType<typeof openEnvelopeOf>>;
  readonly lineageVersions: readonly string[];
  readonly lockedAt: string;
}

/**
 * Lock the complete set, in the contract's order. `acquire` sorts it, so the
 * listing order here is documentation and the statement order is the law. The
 * chain lock is R10: the sequence is business-wide and two decisions sharing
 * no other row must still be ordered.
 *
 * Opening the envelope is a *write*, and a write before the lock set is the
 * thing the contract's ordering exists to prevent: two concurrent approvals
 * on one task both found no envelope, both inserted, and the loser met a
 * unique-index violation instead of the typed refusal it had earned. So this
 * only reads it, and `openEnvelope` writes under the locks.
 *
 * R8: the holds a rejection makes nonclaimable are released in
 * the same transaction, so their accounting parents are discovered before the
 * locks and rediscovered under them. A hold that appeared in between rolls
 * back as `AffectedSetChanged` rather than meeting the classifier as a
 * lock-order fault; a set that only shrank is covered (N1). An approval
 * discovers no holds.
 *
 * G06: the clock is read after the locks, not `now()`,
 * which is when this transaction began, so a decide that waited on its locks
 * past the deadline is refused.
 */
async function lockDecision(
  tx: TenantQuery,
  request: DecideRequest,
  found: FoundGate,
): Promise<RuntimeResult<LockedDecision>> {
  const existing = await openEnvelopeOf(tx, found.task_id);
  // R2. The envelope's own cap is the cap this approval draws on, and the
  // request's is a claim about it. Otherwise an existing envelope with room, a
  // requested cap with room and an exhausted actual cap would pass preflight,
  // write the signed decision and the approved gate, and then refuse on a cap
  // nothing had locked. Refused here, before the locks and the first write, and the
  // canonical cap is what everything below uses.
  if (existing !== undefined && existing.capId !== request.capId) {
    return refuse(
      'CAP_BINDING_MISMATCH',
      `this task's envelope draws on cap ${existing.capId}, and the request names ${request.capId}`,
      "Decide against the envelope's own cap, or close that envelope through its authorised boundary first.",
    );
  }
  const capId = existing?.capId ?? request.capId;
  const lineageVersions =
    request.decision === 'reject'
      ? (
          await tx.query<{ readonly id: string }>(
            `select id from public.proposal_versions where business_id = $1 and lineage_id = $2`,
            [tx.businessId, found.lineage_id],
          )
        ).map((row) => row.id)
      : [];
  const { locks } = await lockRediscovered(tx, {
    discover: async () => await affectedByVersions(tx, lineageVersions),
    locks: (held) => [
      { lockClass: 'chain', id: 'gate_decisions' },
      { lockClass: 'cap', id: capId },
      ...(existing === undefined ? [] : [{ lockClass: 'envelope' as const, id: existing.id }]),
      { lockClass: 'task', id: found.task_id },
      { lockClass: 'run', id: found.run_id },
      { lockClass: 'lineage', id: found.lineage_id },
      { lockClass: 'gate', id: request.gateId },
      ...held,
    ],
    rule: 'covered',
    changed:
      'decide: the holds on the rejected lineage changed under discovery; roll back and rediscover rather than extending the lock set',
  });
  const lockedAt = await lockedInstant(tx);
  return { ok: true, value: { locks, capId, existing, lineageVersions, lockedAt } };
}

interface Rechecked {
  readonly gate: GateRow;
  readonly version: {
    readonly payload_digest: string;
    readonly maximum_minor: string;
    readonly currency: string;
  };
  readonly pack: { readonly rendered_digest: string };
}

/**
 * Re-check under the locks. Between discovery and here another transaction
 * could have revoked the grant, decided this gate, superseded this version or
 * rejected this lineage. "Check current decide grant" (T2) first, now that no
 * revocation of a covering grant can commit around it, and at the locked
 * instant, so a grant that lapsed while this
 * waited on the chain or the cap no longer counts.
 */
async function recheckDecision(
  tx: TenantQuery,
  request: DecideRequest,
  found: FoundGate,
  locked: LockedDecision,
): Promise<RuntimeResult<Rechecked>> {
  const current = await checkAuthorityAt(
    tx,
    request.subjects,
    {
      collection: request.collection,
      action: 'decide',
      scope: { kind: 'record', id: found.task_id },
    },
    locked.lockedAt,
  );
  if (!current.ok) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      'the decide grant this decision rested on ended before it could be recorded',
      'A person with decide authority on this task decides it.',
    );
  }
  const gate = await recheckGate(tx, request, locked.lockedAt);
  if (!gate.ok) return gate;
  // T3a: an escalated gate is decided only by the escalation role, decide at
  // business scope, read at the locked instant like the grant above.
  if (gate.value.escalated) {
    const wider = await checkAuthorityAt(
      tx,
      request.subjects,
      { collection: request.collection, action: 'decide', scope: { kind: 'business', id: null } },
      locked.lockedAt,
    );
    if (!wider.ok) {
      return refuse(
        'SCOPE_NOT_GRANTED',
        'this gate was escalated, and only a holder of decide across the business decides it now',
        'A person holding decide at business scope decides or escalates it.',
      );
    }
  }
  // Four eyes (T2g): the person the task is assigned to does not decide its
  // gate. Read under the task lock taken above (the record row, for update),
  // which an assignment's own update of that row waits on, so a reassignment
  // racing this decision is seen or waits for it, never missed.
  if (await assignedTo(tx, found.task_id, request.decidedByPersonId)) {
    return { ok: false, refusal: fourEyesRequired() };
  }
  const evidence = await recheckEvidence(tx, gate.value);
  if (!evidence.ok) return evidence;
  const work = await recheckWork(tx, request, found, gate.value, evidence.value.version, locked);
  if (!work.ok) return work;
  return { ok: true, value: { gate: gate.value, ...evidence.value } };
}

/** Whether the task is assigned to this person, read under the caller's task lock. */
async function assignedTo(tx: TenantQuery, taskId: string, personId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly mine: boolean }>(
    `select exists (select 1 from public.records
                     where business_id = $1 and id = $2 and uuid_2 = $3) as mine`,
    [tx.businessId, taskId, personId],
  );
  return rows[0]?.mine === true;
}

/** The gate is still pending, on the presented version, and not past its deadline. */
async function recheckGate(
  tx: TenantQuery,
  request: DecideRequest,
  lockedAt: string,
): Promise<RuntimeResult<GateRow>> {
  const gates = await tx.query<GateRow>(
    `select g.id, g.lineage_id, g.version_id, g.run_id, g.step_id, g.evidence_pack_id,
            g.payload_digest, g.state, g.round, (g.expires_at <= $3::timestamptz) as expired,
            (g.escalated_at is not null) as escalated
       from public.gates g where g.business_id = $1 and g.id = $2`,
    [tx.businessId, request.gateId, lockedAt],
  );
  const gate = only(gates, 'decide: the gate locked above');
  if (gate.state === 'superseded') {
    return refuse(
      'PROPOSAL_SUPERSEDED',
      `gate ${gate.id} belongs to a version a later one superseded`,
      'Re-read the lineage and decide its live version.',
    );
  }
  if (gate.state !== 'pending') {
    // G03: the loser of the race lands here and its refusal is recorded by the
    // caller's own audit path, which is the command envelope. The row is not
    // written to `gate_decisions`, because a refusal is not a decision.
    return { ok: false, refusal: gateAlreadyDecided(gate.id, gate.state) };
  }
  if (gate.version_id !== request.versionId) {
    return refuse(
      'PROPOSAL_SUPERSEDED',
      `gate ${gate.id} is bound to version ${gate.version_id}, not the version presented`,
      'Re-read the gate and decide the version it actually carries.',
    );
  }
  if (gate.expired) {
    return refuse(
      'GATE_EXPIRED',
      `gate ${gate.id} expired before this decision`,
      'A new proposal version raises a new gate. Expiry never becomes approval.',
    );
  }
  return { ok: true, value: gate };
}

/** The version is live, and the gate, the version and the pack agree on the payload (G07). */
async function recheckEvidence(
  tx: TenantQuery,
  gate: GateRow,
): Promise<RuntimeResult<Omit<Rechecked, 'gate'>>> {
  const versions = await tx.query<{
    readonly payload_digest: string;
    readonly superseded_at: Date | null;
    readonly maximum_minor: string;
    readonly currency: string;
  }>(
    `select payload_digest, superseded_at, maximum_minor::text as maximum_minor, currency
       from public.proposal_versions where business_id = $1 and id = $2`,
    [tx.businessId, gate.version_id],
  );
  const version = versions[0];
  if (version === undefined || version.superseded_at !== null) {
    return refuse(
      'PROPOSAL_SUPERSEDED',
      `version ${gate.version_id} has been superseded, so its gate no longer authorises anything`,
      'Decide the live version of this lineage.',
    );
  }
  if (version.payload_digest !== gate.payload_digest) {
    return refuse(
      'EVIDENCE_MISMATCH',
      'the gate and its version disagree about the payload digest',
      'Re-propose. A gate whose evidence does not match its version is never decided.',
    );
  }
  const packs = await tx.query<{
    readonly rendered_digest: string;
    readonly version_digest: string;
  }>(
    `select rendered_digest, version_digest from public.evidence_packs
      where business_id = $1 and id = $2 and version_id = $3`,
    [tx.businessId, gate.evidence_pack_id, gate.version_id],
  );
  const pack = packs[0];
  if (pack === undefined || pack.version_digest !== version.payload_digest) {
    return refuse(
      'EVIDENCE_MISMATCH',
      'the evidence pack was rendered against a different version of this proposal',
      'Re-render the pack for this version before deciding it.',
    );
  }
  return { ok: true, value: { version, pack } };
}

/**
 * The work is still decidable: the task is not in the trash, the lineage is
 * live, a third round of changes is not on offer, and an approval's budget has
 * room.
 *
 * A trash that committed while this waited is read
 * here, under the task lock: a trashed task is gone to the work surface, and
 * an approval would hold budget for work never handed out.
 *
 * G08: two formal rounds, and the third is refused before anything is
 * written. `roundsUsed` counts the round this decision would open, so two
 * requested already is a third on offer.
 *
 * W01 and T2: "approval/reservation cannot half-commit". The budget check is
 * the same arithmetic `reserve` does, read-only, under the locks already held,
 * and before the first write; `reserve` keeps its own copy as the second
 * barrier.
 */
async function recheckWork(
  tx: TenantQuery,
  request: DecideRequest,
  found: FoundGate,
  gate: GateRow,
  version: Rechecked['version'],
  locked: LockedDecision,
): Promise<RuntimeResult<null>> {
  const live = await tx.query<{ readonly id: string }>(
    `select id from public.records where business_id = $1 and id = $2 and deleted_at is null`,
    [tx.businessId, found.task_id],
  );
  if (live[0] === undefined) return gateNotFound();
  const lineages = await tx.query<{ readonly state: string }>(
    `select state from public.proposal_lineages where business_id = $1 and id = $2`,
    [tx.businessId, gate.lineage_id],
  );
  if (lineages[0]?.state !== 'live') {
    return refuse(
      'LINEAGE_TERMINAL',
      `lineage ${gate.lineage_id} is ${lineages[0]?.state ?? 'missing'}`,
      'A terminal lineage is not decided again. An authorised restart opens a new one.',
    );
  }
  // G08's bound: two formal rounds used. Request changes stops there, and
  // escalate (T3a) starts there.
  const atBound = async (): Promise<boolean> =>
    gate.round >= 2 && (await roundsUsed(tx, gate.lineage_id)) > 2;
  if (request.decision === 'request_changes' && (await atBound())) {
    return refuse(
      'CHANGE_ROUNDS_EXHAUSTED',
      'this lineage has used its two formal rounds of requested changes',
      'Approve it, reject it, or escalate under the accepted rule. A third round is not taken here.',
    );
  }
  if (request.decision === 'escalate') {
    if (!(await atBound())) {
      return refuse(
        'TRANSITION_NOT_PERMITTED',
        'escalation is offered once this lineage has used its two rounds of changes',
        'Approve, reject or request changes; escalate at the bound.',
      );
    }
    const recipient = await recheckRecipient(tx, request, found.task_id, locked.lockedAt);
    if (!recipient.ok) return recipient;
  }
  if (request.decision === 'approve') {
    const room = await budgetRoom(tx, {
      capId: locked.capId,
      taskId: found.task_id,
      wantedMinor: BigInt(version.maximum_minor),
      currency: version.currency,
    });
    if (!room.ok) return room;
  }
  return { ok: true, value: null };
}

/**
 * Write the signed decision, its chain link and the gate's new state.
 *
 * R10, second half. `seq::text as seq` made `order by seq desc` resolve to
 * the *output* column, so the chain head was chosen lexically. The alias
 * differs from the column now, so the ordering is the bigint's; the chain lock
 * is what makes the allocation safe, and this is what makes it correct.
 *
 * The payload and the link cover `decided_at`, so the time is fixed before
 * either and written as the value they saw, in the one spelling a read renders
 * it back in: the database's clock, as text, because a `timestamptz`
 * parameter goes through a JavaScript `Date` and loses the microseconds the
 * signature and hash saw.
 *
 * v3 (`signing.ts`, `decisionPayload`): everything the row shows or links is
 * inside what is signed, including its place in the chain, and `link: 3` is
 * inside the payload, so a row cannot be relabelled to an older format.
 */
async function writeDecision(
  tx: TenantQuery,
  request: DecideRequest & { readonly decision: Exclude<DecisionKind, 'escalate'> },
  gate: GateRow,
  evidence: string,
): Promise<{ readonly decisionId: string; readonly hash: string }> {
  const previous = await tx.query<{ readonly hash: string; readonly at: string }>(
    `select hash, seq::text as at from public.gate_decisions
      where business_id = $1 order by seq desc limit 1`,
    [tx.businessId],
  );
  const prevHash = previous[0]?.hash ?? CHAIN_GENESIS;
  const seq = Number(previous[0]?.at ?? 0) + 1;
  const clock = await tx.query<{ readonly at: string }>(`select ${decidedAtText('now()')} as at`);
  const decidedAt = only(clock, 'decide: the database clock').at;

  const decisionId = randomUUID();
  const signed = {
    id: decisionId,
    seq,
    gate: gate.id,
    version: gate.version_id,
    lineage: gate.lineage_id,
    round: gate.round,
    decision: request.decision,
    actor: request.decidedByActorId,
    decidedAt,
    evidence,
    key: request.signingKey.id,
  };
  const payload = decisionPayload({
    ...signed,
    prev: prevHash,
    by: request.decidedByPersonId,
    note: request.note,
  });
  const payloadDigest = digestOf(payload);
  const signature = sign(request.signingKey, payloadDigest);
  const hash = chainHash(
    prevHash,
    decisionLink(LINK_VERSION, {
      ...signed,
      person: request.decidedByPersonId,
      payloadDigest,
      signature,
    }),
  );

  await tx.query(
    `insert into public.gate_decisions
       (business_id, id, gate_id, version_id, lineage_id, seq, decision, round,
        decided_by_person_id, decided_by_actor_id, payload, payload_digest,
        evidence_digest, signing_key_id, signature, prev_hash, hash, decided_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12, $13, $14, $15, $16, $17,
             $18::text::timestamptz)`,
    [
      tx.businessId,
      decisionId,
      gate.id,
      gate.version_id,
      gate.lineage_id,
      seq,
      request.decision,
      gate.round,
      request.decidedByPersonId,
      request.decidedByActorId,
      JSON.stringify(payload),
      payloadDigest,
      evidence,
      request.signingKey.id,
      signature,
      prevHash,
      hash,
      decidedAt,
    ],
  );
  const gateState = {
    approve: 'approved',
    reject: 'rejected',
    request_changes: 'changes_requested',
  }[request.decision];
  await tx.query(
    `update public.gates set state = $3, decided_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, gate.id, gateState],
  );
  return { decisionId, hash };
}

/**
 * The recipient holds the escalation role at the locked instant: decide at
 * business scope, through the person or any of their actors, and is not the
 * task's assignee, whom four eyes keeps from deciding. Anyone else, or nobody,
 * fails closed and the gate stays as it was, approve and reject still open.
 * The answer names the field and never echoes the presented id.
 */
async function recheckRecipient(
  tx: TenantQuery,
  request: DecideRequest,
  taskId: string,
  lockedAt: string,
): Promise<RuntimeResult<null>> {
  const ineligible = {
    ok: false as const,
    refusal: refuseCommand(
      'SCOPE_NOT_GRANTED',
      ['recipientPersonId'],
      [
        'the recipient does not hold decide across this business',
        'Escalate to a person holding decide at business scope who is not assigned the task.',
      ],
    ),
  };
  const recipient = request.recipientPersonId;
  if (recipient === undefined) return ineligible;
  const actors = await tx.query<{ readonly id: string }>(
    `select id from public.actors where business_id = $1 and person_id = $2`,
    [tx.businessId, recipient],
  );
  if (actors.length === 0) return ineligible;
  const held = await checkAuthorityAt(
    tx,
    [
      { kind: 'person', id: recipient },
      ...actors.map((actor) => ({ kind: 'actor' as const, id: actor.id })),
    ],
    { collection: request.collection, action: 'decide', scope: { kind: 'business', id: null } },
    lockedAt,
  );
  if (!held.ok || (await assignedTo(tx, taskId, recipient))) return ineligible;
  return { ok: true, value: null };
}

/**
 * Escalate (T3a): the actor and the recipient on the gate, under the gate
 * lock. The gate stays `pending` and no decision is written, so the chain and
 * the one-decision-per-gate index are untouched; a later escalation replaces
 * the recipient, and each one is in the audit trail.
 */
async function escalateGate(
  tx: TenantQuery,
  request: DecideRequest,
  gate: GateRow,
): Promise<DecideResult> {
  const recipient = request.recipientPersonId;
  if (recipient === undefined) {
    throw new Error('decide: escalate reached its write without a checked recipient');
  }
  await tx.query(
    `update public.gates
        set escalated_to_person_id = $3, escalated_by_person_id = $4,
            escalated_by_actor_id = $5, escalated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, gate.id, recipient, request.decidedByPersonId, request.decidedByActorId],
  );
  return {
    ok: true,
    value: {
      decision: 'escalate',
      gateId: gate.id,
      versionId: gate.version_id,
      escalatedToPersonId: recipient,
    },
  };
}

/**
 * An approval's envelope and hold, under the locks: the gate lock has already
 * refused the loser of a race, and the task lock serialises envelope creation
 * for this task.
 *
 * R2. The signed decision and the approved gate are already written. A
 * refusal returned from here is a refusal a caller can commit, and committing
 * it is the half-approval the preflight exists to prevent -- so a reservation
 * refusal this late is not an answer, it is a contradiction between two checks
 * that hold the same locks. It aborts the transaction instead.
 */
async function reserveApproval(
  tx: TenantQuery,
  capId: string,
  taskId: string,
  gate: GateRow,
  version: Rechecked['version'],
  common: DecidedCommon,
): Promise<DecideResult> {
  const envelope = await openEnvelope(tx, capId, taskId, version);
  if (!envelope.ok) return envelope;
  const reserved = await reserve(tx, {
    envelopeId: envelope.value.envelopeId,
    versionId: gate.version_id,
    runId: gate.run_id,
    stepId: gate.step_id,
    heldMinor: BigInt(version.maximum_minor),
  });
  if (!reserved.ok) {
    throw new Error(
      `decide: preflight passed and reserve refused ${reserved.refusal.code} after the decision was written (${reserved.refusal.fixes.join('; ')})`,
    );
  }
  return {
    ok: true,
    value: {
      ...common,
      decision: 'approve',
      envelopeId: envelope.value.envelopeId,
      reservationId: reserved.value.reservationId,
      attemptId: reserved.value.attemptId,
      // The response's number. Enforcement above compared the exact bigint;
      // a version's maximum is a safe integer at the command boundary.
      heldMinor: Number(version.maximum_minor),
    },
  };
}

/**
 * Open the task's envelope, or bind to the one it already has. Under the locks.
 * `version` is the row `decide` already re-read under them, so its maximum and
 * currency are read once per approval.
 */
async function openEnvelope(
  tx: TenantQuery,
  capId: string,
  taskId: string,
  version: { readonly maximum_minor: string; readonly currency: string },
): Promise<RuntimeResult<{ readonly envelopeId: string }>> {
  const open = await openEnvelopeOf(tx, taskId);
  if (open !== undefined) {
    // R2's other half: the envelope's currency is canonical too, and a version
    // denominated in another one is not work this envelope can hold.
    if (version.currency !== open.currency) {
      return refuse(
        'CAP_BINDING_MISMATCH',
        `this task's envelope is in ${open.currency} and the version is in ${version.currency}`,
        'Propose the work in the currency the envelope holds.',
      );
    }
    return { ok: true, value: { envelopeId: open.id } };
  }

  const caps = await tx.query<{ readonly limit_minor: string; readonly currency: string }>(
    `select limit_minor::text as limit_minor, currency from public.budget_caps
      where business_id = $1 and id = $2`,
    [tx.businessId, capId],
  );
  const cap = caps[0];
  if (cap === undefined) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      `no budget cap ${capId} in this business`,
      'Provision the cap before approving work that draws on it.',
    );
  }

  // The cap is a ceiling in one currency. Preflight has
  // already refused a version in another; this is the second barrier, at the
  // write that would bind the two.
  if (version.currency !== cap.currency) {
    return refuse(
      'CAP_BINDING_MISMATCH',
      `the cap behind this task is in ${cap.currency} and the version is in ${version.currency}`,
      'Propose the work in the currency the cap holds.',
    );
  }

  const envelopeId = randomUUID();
  await tx.query(
    `insert into public.task_envelopes
       (business_id, id, cap_id, task_id, maximum_minor, currency)
     values ($1, $2, $3, $4, $5, $6)`,
    [tx.businessId, envelopeId, capId, taskId, version.maximum_minor, version.currency],
  );
  return { ok: true, value: { envelopeId } };
}

/**
 * The reservation, the immutable attempt and the held total, together.
 * Exported because `pickup` needs exactly this when it opens a replacement
 * hold on a still-approved version whose old lease expired (R5): the
 * replacement has to meet the same budget authority as the original, and a
 * second copy of this arithmetic is a second place W05 can drift. W05's
 * two distinct reasons live here: `BUDGET_UNAVAILABLE` is "this envelope has
 * no room", `BUDGET_EXHAUSTED` is "the cap behind it has none". A caller told
 * the wrong one raises the wrong ceiling.
 */
export async function reserve(
  tx: TenantQuery,
  of: {
    readonly envelopeId: string;
    readonly versionId: string;
    readonly runId: string;
    readonly stepId: string;
    /** Exact minor units. `pickup` passes a number read from a bigint column. */
    readonly heldMinor: number | bigint;
  },
): Promise<RuntimeResult<{ readonly reservationId: string; readonly attemptId: string }>> {
  const held = BigInt(of.heldMinor);
  const envelopes = await tx.query<{
    readonly cap_id: string;
    readonly maximum_minor: string;
    readonly held_minor: string;
    readonly actual_minor: string;
  }>(
    `select cap_id, maximum_minor::text as maximum_minor, held_minor::text as held_minor,
            actual_minor::text as actual_minor
       from public.task_envelopes where business_id = $1 and id = $2 for update`,
    [tx.businessId, of.envelopeId],
  );
  const envelope = envelopes[0];
  if (envelope === undefined) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      'the envelope disappeared under the lock',
      'Retry the decision.',
    );
  }

  const tooFull = envelopeVerdict(
    {
      maximumMinor: envelope.maximum_minor,
      heldMinor: envelope.held_minor,
      actualMinor: envelope.actual_minor,
    },
    held,
  );
  if (tooFull !== null) return tooFull;

  const overCap = capVerdict({
    cap: await capCommitted(tx, envelope.cap_id),
    capId: envelope.cap_id,
    wanted: held,
    currency: null,
  });
  if (overCap !== null) return overCap;

  const reservationId = randomUUID();
  await tx.query(
    `insert into public.reservations
       (business_id, id, envelope_id, version_id, run_id, held_minor)
     values ($1, $2, $3, $4, $5, $6)`,
    [tx.businessId, reservationId, of.envelopeId, of.versionId, of.runId, held.toString()],
  );

  const attemptId = randomUUID();
  await tx.query(
    `insert into public.attempts
       (business_id, id, reservation_id, envelope_id, version_id, run_id, step_id,
        price_book, estimated_minor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tx.businessId,
      attemptId,
      reservationId,
      of.envelopeId,
      of.versionId,
      of.runId,
      of.stepId,
      SYNTHETIC_PRICE_BOOK,
      held.toString(),
    ],
  );

  await tx.query(
    `update public.task_envelopes set held_minor = held_minor + $3
      where business_id = $1 and id = $2`,
    [tx.businessId, of.envelopeId, held.toString()],
  );

  return { ok: true, value: { reservationId, attemptId } };
}

/**
 * Is there room, in the envelope this approval would use and in the cap behind
 * it? Read-only, so it can be asked before anything is written. The two codes
 * stay distinct here for the same reason they are distinct in `reserve` (W05):
 * a caller told the wrong one raises the wrong ceiling.
 */
async function budgetRoom(
  tx: TenantQuery,
  of: {
    readonly capId: string;
    readonly taskId: string;
    readonly wantedMinor: bigint;
    readonly currency: string;
  },
): Promise<RuntimeResult<null>> {
  const envelope = await openEnvelopeOf(tx, of.taskId);
  if (envelope !== undefined) {
    if (envelope.currency !== of.currency) {
      return refuse(
        'CAP_BINDING_MISMATCH',
        `this task's envelope is in ${envelope.currency} and the version is in ${of.currency}`,
        'Propose the work in the currency the envelope holds.',
      );
    }
    const tooFull = envelopeVerdict(envelope, of.wantedMinor);
    if (tooFull !== null) return tooFull;
  }

  const overCap = capVerdict({
    cap: await capCommitted(tx, of.capId),
    capId: of.capId,
    wanted: of.wantedMinor,
    currency: of.currency,
  });
  if (overCap !== null) return overCap;
  return { ok: true, value: null };
}
