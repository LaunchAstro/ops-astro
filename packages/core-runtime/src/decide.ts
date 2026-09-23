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
import { acquire } from './locks.ts';
import { affectedByVersions, classifyVersions } from './recovery.ts';
import { CHAIN_GENESIS, chainHash, digestOf, sign, type SigningKey } from './signing.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

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

export interface Decided {
  readonly decisionId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly decision: DecisionKind;
  readonly hash: string;
  /** Present on an approval only. A rejection reserves nothing. */
  readonly envelopeId?: string;
  readonly reservationId?: string;
  readonly attemptId?: string;
  readonly heldMinor?: number;
}

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

export async function decide(
  tx: TenantQuery,
  request: DecideRequest,
): Promise<RuntimeResult<Decided>> {
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
      `no gate ${request.gateId} in this business`,
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

  // Discovery only. Opening the envelope is a *write*, and a write before the
  // lock set is the thing the contract's ordering exists to prevent: two
  // concurrent approvals on one task both found no envelope, both inserted,
  // and the loser met a unique-index violation instead of the typed refusal it
  // had earned. So this reads, and `openEnvelope` below writes under the locks.
  const existing = await existingEnvelope(tx, found.task_id);

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
  const locks = await acquire(tx, [
    { lockClass: 'chain', id: 'gate_decisions' },
    { lockClass: 'cap', id: capId },
    ...(existing === undefined ? [] : [{ lockClass: 'envelope' as const, id: existing.id }]),
    { lockClass: 'task', id: found.task_id },
    { lockClass: 'run', id: found.run_id },
    { lockClass: 'lineage', id: found.lineage_id },
    { lockClass: 'gate', id: request.gateId },
    ...(await affectedByVersions(tx, lineageVersions)),
  ]);

  // Re-read everything under the locks. Between discovery and here another
  // transaction could have decided this gate, superseded this version or
  // rejected this lineage.
  const gates = await tx.query<GateRow>(
    `select g.id, g.lineage_id, g.version_id, g.run_id, g.step_id, g.evidence_pack_id,
            g.payload_digest, g.state, g.round, (g.expires_at <= now()) as expired
       from public.gates g where g.business_id = $1 and g.id = $2`,
    [tx.businessId, request.gateId],
  );
  const gate = gates[0] as GateRow;

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
      `gate ${gate.id} is bound to version ${gate.version_id}, not the ${request.versionId} presented`,
      'Re-read the gate and decide the version it actually carries.',
    );
  }
  // G06: the database's clock, read inside the deciding transaction.
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
  }>(
    `select payload_digest, superseded_at, maximum_minor::text as maximum_minor
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
  if (request.decision === 'request_changes' && gate.round >= 2) {
    const used = await tx.query<{ readonly rounds: string }>(
      `select count(*)::text as rounds from public.gate_decisions
        where business_id = $1 and lineage_id = $2 and decision = 'request_changes'`,
      [tx.businessId, gate.lineage_id],
    );
    if (Number(used[0]?.rounds ?? 0) >= 2) {
      return refuse(
        'CHANGE_ROUNDS_EXHAUSTED',
        'this lineage has used its two formal rounds of requested changes',
        'Approve it, reject it, or escalate under the accepted rule. A third round is not taken here.',
      );
    }
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
      wantedMinor: Number(version.maximum_minor),
    });
    if (!room.ok) return room;
  }

  const payload = {
    gate: gate.id,
    version: gate.version_id,
    decision: request.decision,
    by: request.decidedByPersonId,
    note: request.note,
    evidence: pack.rendered_digest,
  };
  const payloadDigest = digestOf(payload);
  const signature = sign(request.signingKey, payloadDigest);

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

  const decisionId = randomUUID();
  const hash = chainHash(prevHash, {
    id: decisionId,
    seq,
    gate: gate.id,
    version: gate.version_id,
    decision: request.decision,
    person: request.decidedByPersonId,
    payloadDigest,
    signature,
  });

  await tx.query(
    `insert into public.gate_decisions
       (business_id, id, gate_id, version_id, lineage_id, seq, decision, round,
        decided_by_person_id, decided_by_actor_id, payload, payload_digest,
        evidence_digest, signing_key_id, signature, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12, $13, $14, $15, $16, $17)`,
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
  const envelope = await openEnvelope(tx, capId, found.task_id, gate.version_id);
  if (!envelope.ok) return envelope;

  const heldMinor = Number(version.maximum_minor);
  const reserved = await reserve(tx, {
    envelopeId: envelope.value.envelopeId,
    versionId: gate.version_id,
    runId: gate.run_id,
    stepId: gate.step_id,
    heldMinor,
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
      heldMinor,
    },
  };
}

/**
 * Read-only discovery, so the lock set can include an envelope that exists —
 * and, since R2, the cap that envelope actually draws on, which is the one
 * preflight and reservation both have to use.
 */
async function existingEnvelope(
  tx: TenantQuery,
  taskId: string,
): Promise<{ readonly id: string; readonly capId: string; readonly currency: string } | undefined> {
  const rows = await tx.query<{
    readonly id: string;
    readonly cap_id: string;
    readonly currency: string;
  }>(
    `select id, cap_id, currency from public.task_envelopes
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [tx.businessId, taskId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, capId: row.cap_id, currency: row.currency };
}

/** Open the task's envelope, or bind to the one it already has. Under the locks. */
async function openEnvelope(
  tx: TenantQuery,
  capId: string,
  taskId: string,
  versionId: string,
): Promise<RuntimeResult<{ readonly envelopeId: string }>> {
  const existing = await tx.query<{ readonly id: string; readonly currency: string }>(
    `select id, currency from public.task_envelopes
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [tx.businessId, taskId],
  );
  const open = existing[0];
  if (open !== undefined) {
    // R2's other half: the envelope's currency is canonical too, and a version
    // denominated in another one is not work this envelope can hold.
    const proposed = await tx.query<{ readonly currency: string }>(
      `select currency from public.proposal_versions where business_id = $1 and id = $2`,
      [tx.businessId, versionId],
    );
    if (proposed[0]?.currency !== open.currency) {
      return refuse(
        'CAP_BINDING_MISMATCH',
        `this task's envelope is in ${open.currency} and the version is in ${proposed[0]?.currency ?? 'nothing'}`,
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
  const versions = await tx.query<{ readonly maximum_minor: string; readonly currency: string }>(
    `select maximum_minor::text as maximum_minor, currency from public.proposal_versions
      where business_id = $1 and id = $2`,
    [tx.businessId, versionId],
  );
  const version = versions[0];
  if (version === undefined) {
    return refuse('GATE_NOT_FOUND', `no version ${versionId}`, 'Re-read the gate.');
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
    readonly heldMinor: number;
  },
): Promise<RuntimeResult<{ readonly reservationId: string; readonly attemptId: string }>> {
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

  const committed = Number(envelope.held_minor) + Number(envelope.actual_minor);
  if (committed + of.heldMinor > Number(envelope.maximum_minor)) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      `this task's envelope holds ${committed} of ${envelope.maximum_minor}, which leaves no room for ${of.heldMinor}`,
      'Raise the envelope through its authorised boundary, or propose bounded work that fits.',
    );
  }

  const caps = await tx.query<{ readonly limit_minor: string; readonly committed: string }>(
    `select c.limit_minor::text as limit_minor,
            coalesce(sum(e.held_minor + e.actual_minor), 0)::text as committed
       from public.budget_caps c
       left join public.task_envelopes e on e.business_id = c.business_id and e.cap_id = c.id
      where c.business_id = $1 and c.id = $2
      group by c.limit_minor`,
    [tx.businessId, envelope.cap_id],
  );
  const cap = caps[0];
  if (cap !== undefined && Number(cap.committed) + of.heldMinor > Number(cap.limit_minor)) {
    return refuse(
      'BUDGET_EXHAUSTED',
      `the cap behind this envelope has ${cap.committed} of ${cap.limit_minor} committed, so ${of.heldMinor} does not fit`,
      'The cap is the ceiling. Raising it is a separate authorised decision.',
    );
  }

  const reservationId = randomUUID();
  await tx.query(
    `insert into public.reservations
       (business_id, id, envelope_id, version_id, run_id, held_minor)
     values ($1, $2, $3, $4, $5, $6)`,
    [tx.businessId, reservationId, of.envelopeId, of.versionId, of.runId, of.heldMinor],
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
      of.heldMinor,
    ],
  );

  await tx.query(
    `update public.task_envelopes set held_minor = held_minor + $3
      where business_id = $1 and id = $2`,
    [tx.businessId, of.envelopeId, of.heldMinor],
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
  of: { readonly capId: string; readonly taskId: string; readonly wantedMinor: number },
): Promise<RuntimeResult<null>> {
  const envelopes = await tx.query<{
    readonly maximum_minor: string;
    readonly held_minor: string;
    readonly actual_minor: string;
  }>(
    `select maximum_minor::text as maximum_minor, held_minor::text as held_minor,
            actual_minor::text as actual_minor
       from public.task_envelopes
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [tx.businessId, of.taskId],
  );
  const envelope = envelopes[0];
  if (envelope !== undefined) {
    const committed = Number(envelope.held_minor) + Number(envelope.actual_minor);
    if (committed + of.wantedMinor > Number(envelope.maximum_minor)) {
      return refuse(
        'BUDGET_UNAVAILABLE',
        `this task's envelope holds ${committed} of ${envelope.maximum_minor}, which leaves no room for ${of.wantedMinor}`,
        'Raise the envelope through its authorised boundary, or propose bounded work that fits.',
      );
    }
  }

  const caps = await tx.query<{ readonly limit_minor: string; readonly committed: string }>(
    `select c.limit_minor::text as limit_minor,
            coalesce(sum(e.held_minor + e.actual_minor), 0)::text as committed
       from public.budget_caps c
       left join public.task_envelopes e on e.business_id = c.business_id and e.cap_id = c.id
      where c.business_id = $1 and c.id = $2
      group by c.limit_minor`,
    [tx.businessId, of.capId],
  );
  const cap = caps[0];
  if (cap === undefined) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      `no budget cap ${of.capId} in this business`,
      'Provision the cap before approving work that draws on it.',
    );
  }
  if (Number(cap.committed) + of.wantedMinor > Number(cap.limit_minor)) {
    return refuse(
      'BUDGET_EXHAUSTED',
      `the cap behind this envelope has ${cap.committed} of ${cap.limit_minor} committed, so ${of.wantedMinor} does not fit`,
      'The cap is the ceiling. Raising it is a separate authorised decision.',
    );
  }
  return { ok: true, value: null };
}
