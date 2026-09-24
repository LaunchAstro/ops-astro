// SPDX-License-Identifier: AGPL-3.0-only
//
// T2: decide, and reserve before pickup.
//
// A person decides. The agent's refusal is `DELEGATION_EXCLUDES_DECISION`,
// produced by L2's `checkDelegatedAuthority` and returned here unchanged.
// `decideAsAgent` exists for exactly that: to consume L2's answer rather than
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
import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { checkAuthority, type Subject } from '../../core-records/src/authority/grants.ts';
import {
  checkDelegatedAuthority,
  type Delegation,
} from '../../core-records/src/authority/delegations.ts';
import { lockedInstant } from './clock.ts';
import { capCommitted, capVerdict, envelopeVerdict, openEnvelopeOf } from './budget.ts';
import { roundsUsed } from './proposal-writer.ts';
import { only } from './only.ts';
import { affectedByVersions, classifyVersions, holdCoveringGrants } from './recovery.ts';
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
 * Final review R1 #53. A note that cannot be stored. `FIELD_VALUE_INVALID` is
 * the request layer's code, not one of the runtime's own register rows, so it
 * is typed here beside `decide` rather than widened into `RuntimeRefusalCode`.
 */
export interface NoteRefusal {
  readonly code: 'FIELD_VALUE_INVALID';
  readonly reason: string;
  readonly fix: string;
}

export type DecideResult =
  RuntimeResult<Decided> | { readonly ok: false; readonly refusal: NoteRefusal };

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

export type DecisionKind = 'approve' | 'reject' | 'request_changes';

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
    });

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
}

/**
 * What an agent gets. It asks L2 and returns L2's answer, so the code a
 * delegated caller sees is `DELEGATION_EXCLUDES_DECISION` with L2's wording
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
    // Unreachable through L2, whose `DelegableAction` excludes `decide` and
    // whose check refuses it first. If it ever is reached, the safe answer is
    // still a refusal, and a loud one.
    throw new Error('decideAsAgent: checkDelegatedAuthority permitted a decision');
  }
  return { ok: false, refusal: decision.refusal };
}

export async function decide(tx: TenantQuery, request: DecideRequest): Promise<DecideResult> {
  const fault = noteFault(request.note);
  if (fault !== null) {
    return {
      ok: false,
      refusal: {
        code: 'FIELD_VALUE_INVALID',
        reason: `note: ${fault}, so it cannot be signed and stored`,
        fix: 'Send the note as text without NUL characters or unpaired surrogates.',
      },
    };
  }

  // Discovery, acquiring no authority. Everything read here is re-read under
  // the locks below; this pass exists only to learn which rows to lock.
  const discovered = await tx.query<{
    readonly lineage_id: string;
    readonly version_id: string;
    readonly run_id: string;
    readonly task_id: string;
    readonly state: string;
  }>(
    `select g.lineage_id, g.version_id, g.run_id, r.task_id, l.state
       from public.gates g
       join public.planned_runs r on r.business_id = g.business_id and r.id = g.run_id
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where g.business_id = $1 and g.id = $2`,
    [tx.businessId, request.gateId],
  );
  const found = discovered[0];
  if (found === undefined) {
    return refuse(
      'GATE_NOT_FOUND',
      'no such gate in this business',
      'Name a gate raised by a proposal on a task the caller can see.',
    );
  }

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

  // Final review R1 #4. The check above ran before any lock, so a revocation
  // could commit while this waited on the chain or the cap and the decision
  // still commit after it. The decide grants are held for share here, before
  // the runtime set, as pickup holds its own: a revocation that locked first is
  // seen by the re-check under the locks, and one that comes second waits for
  // this decision to commit.
  await holdCoveringGrants(tx, request.subjects, request.collection);

  // Discovery only. Opening the envelope is a *write*, and a write before the
  // lock set is the thing the contract's ordering exists to prevent: two
  // concurrent approvals on one task both found no envelope, both inserted,
  // and the loser met a unique-index violation instead of the typed refusal it
  // had earned. So this reads, and `openEnvelope` below writes under the locks.
  const existing = await openEnvelopeOf(tx, found.task_id);

  // R2. The envelope's own cap is the cap this approval draws on, and the
  // request's is a claim about it. Discovery returned only an envelope id
  // before, so preflight checked the requested cap while `reserve` checked the
  // envelope's stored one: an existing envelope with room, a requested cap
  // with room and an exhausted actual cap passed preflight, wrote the signed
  // decision and the approved gate, and then refused on a cap nothing had
  // locked. Refused here, before the first write, and the canonical cap is
  // what everything below uses.
  if (existing !== undefined && existing.capId !== request.capId) {
    return refuse(
      'CAP_BINDING_MISMATCH',
      `this task's envelope draws on cap ${existing.capId}, and the request names ${request.capId}`,
      "Decide against the envelope's own cap, or close that envelope through its authorised boundary first.",
    );
  }
  const capId = existing?.capId ?? request.capId;

  // R8. The holds a rejection makes nonclaimable are released in the same
  // transaction, so their accounting parents are discovered before the locks
  // rather than reached through a helper afterwards.
  const rejecting = request.decision === 'reject';
  const lineageVersions = rejecting
    ? (
        await tx.query<{ readonly id: string }>(
          `select id from public.proposal_versions where business_id = $1 and lineage_id = $2`,
          [tx.businessId, found.lineage_id],
        )
      ).map((row) => row.id)
    : [];

  // The complete set, in the contract's order. `acquire` sorts it, so the
  // listing order here is documentation and the statement order is the law.
  // The chain lock is R10: the sequence below is business-wide and two
  // decisions sharing no other row must still be ordered.
  //
  // Thermo O3: a rejection's holds are rediscovered under the locks, before the
  // first write. A hold that appeared in between is one these locks miss, and
  // the classifier would meet it as a lock-order fault; it rolls back as
  // `AffectedSetChanged` instead, retried once. A set that only shrank is
  // covered by the locks held (N1). An approval discovers no holds and reads
  // nothing here.
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

  // G06 and Sol 6 RUNTIME-3: the deadline is judged on the database clock read
  // after the locks, not on `now()`, which is when this transaction began. A
  // decide that waited on its locks past the deadline is refused.
  const lockedAt = await lockedInstant(tx);

  // "Check current decide grant" (T2), under the locks and before the first
  // write, now that no revocation of a covering grant can commit around it.
  const current = await checkAuthority(tx, request.subjects, {
    collection: request.collection,
    action: 'decide',
    scope: { kind: 'record', id: found.task_id },
  });
  if (!current.ok) {
    return refuse(
      'SCOPE_NOT_GRANTED',
      'the decide grant this decision rested on ended before it could be recorded',
      'A person with decide authority on this task decides it.',
    );
  }

  // Re-read everything under the locks. Between discovery and here another
  // transaction could have decided this gate, superseded this version or
  // rejected this lineage.
  const gates = await tx.query<GateRow>(
    `select g.id, g.lineage_id, g.version_id, g.run_id, g.step_id, g.evidence_pack_id,
            g.payload_digest, g.state, g.round, (g.expires_at <= $3::timestamptz) as expired
       from public.gates g where g.business_id = $1 and g.id = $2`,
    [tx.businessId, request.gateId, lockedAt],
  );
  const gate = only(gates, 'decide: the gate locked above');

  if (gate.state !== 'pending') {
    // G03: the loser of the race lands here and its refusal is recorded by the
    // caller's own audit path, which is L3's envelope. The row is not written
    // to `gate_decisions`, because a refusal is not a decision.
    return refuse(
      'GATE_ALREADY_DECIDED',
      `gate ${gate.id} is ${gate.state}`,
      'Read the decision that was recorded. A second decision on one version is never taken.',
    );
  }
  if (gate.version_id !== request.versionId) {
    return refuse(
      'VERSION_SUPERSEDED',
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
      'VERSION_SUPERSEDED',
      `version ${gate.version_id} has been superseded, so its gate no longer authorises anything`,
      'Decide the live version of this lineage.',
    );
  }
  // G07: the approval binds the same hash the pack was rendered against.
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

  // G08: two formal rounds, and the third is refused before anything is written.
  // `roundsUsed` counts the round this decision would open, so two requested
  // already is a third on offer. The count is read only from round two on.
  if (
    request.decision === 'request_changes' &&
    gate.round >= 2 &&
    (await roundsUsed(tx, gate.lineage_id)) > 2
  ) {
    return refuse(
      'CHANGE_ROUNDS_EXHAUSTED',
      'this lineage has used its two formal rounds of requested changes',
      'Approve it, reject it, or escalate under the accepted rule. A third round is not taken here.',
    );
  }

  // W01 and T2: "approval/reservation cannot half-commit". The decision below
  // is a signed, append-only row and the gate's state moves with it, so a
  // budget refusal discovered *after* them leaves a gate marked approved that
  // reserved nothing — and `reserve` is reached only after both are written.
  // This is the same arithmetic `reserve` does, read-only, under the locks
  // already held, and it runs before the first write. `reserve` keeps its own
  // copy as the second barrier; this one is what makes the refusal total.
  if (request.decision === 'approve') {
    const room = await budgetRoom(tx, {
      capId,
      taskId: found.task_id,
      wantedMinor: BigInt(version.maximum_minor),
      currency: version.currency,
    });
    if (!room.ok) return room;
  }

  // R10, second half. `seq::text as seq` made `order by seq desc` resolve to
  // the *output* column, so the chain head was chosen lexically: with ten
  // decisions in a business, '9' sorted above '10' and the next decision
  // allocated 10 again. The alias differs from the column now, so the ordering
  // is the bigint's; the chain lock above is what makes the allocation safe,
  // and this is what makes it correct.
  const previous = await tx.query<{ readonly hash: string; readonly at: string }>(
    `select hash, seq::text as at from public.gate_decisions
      where business_id = $1 order by seq desc limit 1`,
    [tx.businessId],
  );
  const prevHash = previous[0]?.hash ?? CHAIN_GENESIS;
  const seq = Number(previous[0]?.at ?? 0) + 1;

  // The payload and the link cover `decided_at`, so the time is fixed before
  // either and written as the value they saw, in the one spelling a read
  // renders it back in. It is the database's clock, as the column default
  // was. It goes in as text: a parameter typed `timestamptz` is serialised
  // through a JavaScript `Date`, which keeps milliseconds and drops the
  // microseconds the signature and hash saw.
  const clock = await tx.query<{ readonly at: string }>(`select ${decidedAtText('now()')} as at`);
  const decidedAt = only(clock, 'decide: the database clock').at;

  // v3 (`signing.ts`, `decisionPayload`): everything the row shows or links
  // is inside what is signed, including its place in the chain, so a writer
  // who recomputes the unkeyed links still cannot change any of it. The
  // version is `link: 3` inside the payload, so a row cannot be relabelled to
  // an older format without breaking its signature.
  const decisionId = randomUUID();
  const payload = decisionPayload({
    id: decisionId,
    seq,
    prev: prevHash,
    gate: gate.id,
    version: gate.version_id,
    lineage: gate.lineage_id,
    round: gate.round,
    decision: request.decision,
    by: request.decidedByPersonId,
    actor: request.decidedByActorId,
    decidedAt,
    note: request.note,
    evidence: pack.rendered_digest,
    key: request.signingKey.id,
  });
  const payloadDigest = digestOf(payload);
  const signature = sign(request.signingKey, payloadDigest);

  const hash = chainHash(
    prevHash,
    decisionLink(LINK_VERSION, {
      id: decisionId,
      seq,
      gate: gate.id,
      version: gate.version_id,
      decision: request.decision,
      person: request.decidedByPersonId,
      payloadDigest,
      signature,
      round: gate.round,
      decidedAt,
      lineage: gate.lineage_id,
      actor: request.decidedByActorId,
      evidence: pack.rendered_digest,
      key: request.signingKey.id,
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
      pack.rendered_digest,
      request.signingKey.id,
      signature,
      prevHash,
      hash,
      decidedAt,
    ],
  );

  const gateState =
    request.decision === 'approve'
      ? 'approved'
      : request.decision === 'reject'
        ? 'rejected'
        : 'changes_requested';
  await tx.query(
    `update public.gates set state = $3, decided_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, gate.id, gateState],
  );

  if (request.decision === 'reject') {
    // G05: terminal, and the unstarted holds this lineage owns are released by
    // the classifier through the cause recorded here — not by this statement
    // quietly zeroing a number.
    await tx.query(
      `update public.proposal_lineages
          set state = 'rejected', terminal_reason = 'gate_rejected', terminal_at = now()
        where business_id = $1 and id = $2`,
      [tx.businessId, gate.lineage_id],
    );
    // R8, and this is what "not by this statement quietly zeroing a number"
    // means in practice: the classifier releases each eligible hold under the
    // locks this transaction already took for them.
    await classifyVersions(tx, lineageVersions, 'lineage_rejected', gate.lineage_id, locks);
  }

  if (request.decision !== 'approve') {
    return {
      ok: true,
      value: {
        decisionId,
        gateId: gate.id,
        versionId: gate.version_id,
        decision: request.decision,
        hash,
      },
    };
  }

  // Under the locks now: the gate lock has already refused the loser of a
  // race, and the task lock serialises envelope creation for this task.
  const envelope = await openEnvelope(tx, capId, found.task_id, version);
  if (!envelope.ok) return envelope;

  const reserved = await reserve(tx, {
    envelopeId: envelope.value.envelopeId,
    versionId: gate.version_id,
    runId: gate.run_id,
    stepId: gate.step_id,
    heldMinor: BigInt(version.maximum_minor),
  });
  if (!reserved.ok) {
    // R2. The signed decision and the approved gate are already written. A
    // refusal returned from here is a refusal a caller can commit, and
    // committing it is the half-approval the preflight above exists to
    // prevent — so a reservation refusal this late is not an answer, it is a
    // contradiction between two checks that hold the same locks. It aborts
    // the transaction instead.
    throw new Error(
      `decide: preflight passed and reserve refused ${reserved.refusal.code} after the decision was written (${reserved.refusal.reason})`,
    );
  }

  return {
    ok: true,
    value: {
      decisionId,
      gateId: gate.id,
      versionId: gate.version_id,
      decision: request.decision,
      hash,
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

  // Sol 6 RUNTIME-1: the cap is a ceiling in one currency. Preflight has
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
