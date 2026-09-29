// SPDX-License-Identifier: AGPL-3.0-only
//
// The budget arithmetic `decide` asks twice: once read-only before the first
// write (preflight), and again inside `reserve` as the second barrier.
// `handback` asks the cap half a third time, for a successor's ceiling. The
// cap SQL and the refusal texts exist once, here, so the callers cannot drift:
// a missing cap is refused by every one of them with the same code, and the
// one copy fails closed for all.
//
// W05's two reasons stay distinct: `BUDGET_UNAVAILABLE` is "this envelope has
// no room", `BUDGET_EXHAUSTED` is "the cap behind it has none". A caller told
// the wrong one raises the wrong ceiling.

import {
  readBusinessSetting,
  refuseCommand,
  type CommandRefusal,
  type RefusalCode,
  type Subject,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import { acquire } from './locks.ts';
import { checkAuthorityAt, holdCoveringGrants } from './recovery/classifier.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** A cap's ceiling and everything its envelopes hold or spent, as exact SQL text. */
export interface CapCommitted {
  readonly limitMinor: string;
  readonly committed: string;
  readonly currency: string;
}

/** An envelope's own totals, as exact SQL text. */
export interface EnvelopeTotals {
  readonly maximumMinor: string;
  readonly heldMinor: string;
  readonly actualMinor: string;
}

/** A task's open envelope: its identity, its cap and currency, and its totals. */
export interface OpenEnvelope extends EnvelopeTotals {
  readonly id: string;
  readonly capId: string;
  readonly currency: string;
}

/**
 * The task's open envelope, or nothing. At most one is open per task, so this
 * is the one read every caller shares, before the locks as discovery or under
 * them as the value it decides on. It takes no lock itself.
 */
export async function openEnvelopeOf(
  tx: TenantQuery,
  taskId: string,
): Promise<OpenEnvelope | undefined> {
  const rows = await tx.query<{
    readonly id: string;
    readonly cap_id: string;
    readonly currency: string;
    readonly maximum_minor: string;
    readonly held_minor: string;
    readonly actual_minor: string;
  }>(
    `select id, cap_id, currency, maximum_minor::text as maximum_minor,
            held_minor::text as held_minor, actual_minor::text as actual_minor
       from public.task_envelopes
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [tx.businessId, taskId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        capId: row.cap_id,
        currency: row.currency,
        maximumMinor: row.maximum_minor,
        heldMinor: row.held_minor,
        actualMinor: row.actual_minor,
      };
}

/** The cap's limit and its committed total, or nothing when no such cap exists. */
export async function capCommitted(
  tx: TenantQuery,
  capId: string,
): Promise<CapCommitted | undefined> {
  const caps = await tx.query<{
    readonly limit_minor: string;
    readonly committed: string;
    readonly currency: string;
  }>(
    `select c.limit_minor::text as limit_minor,
            coalesce(sum(e.held_minor + e.actual_minor), 0)::text as committed, c.currency
       from public.budget_caps c
       left join public.task_envelopes e on e.business_id = c.business_id and e.cap_id = c.id
      where c.business_id = $1 and c.id = $2
      group by c.limit_minor, c.currency`,
    [tx.businessId, capId],
  );
  const cap = caps[0];
  return cap === undefined
    ? undefined
    : { limitMinor: cap.limit_minor, committed: cap.committed, currency: cap.currency };
}

/** Does `wanted` fit in what the envelope has left? `null` when it does. */
export function envelopeVerdict(
  envelope: EnvelopeTotals,
  wanted: bigint,
): RuntimeResult<never> | null {
  const committed = BigInt(envelope.heldMinor) + BigInt(envelope.actualMinor);
  if (committed + wanted > BigInt(envelope.maximumMinor)) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      `this task's envelope holds ${committed} of ${envelope.maximumMinor}, which leaves no room for ${wanted}`,
      'Raise the envelope through its authorised boundary, or propose bounded work that fits.',
    );
  }
  return null;
}

/**
 * Does `wanted` fit under the cap? `null` when it does.
 *
 * A missing cap is `BUDGET_UNAVAILABLE` for every caller: a ceiling that
 * cannot be read is not room. `currency` is the version's currency when the
 * caller binds it here, as preflight does, and `null` when
 * the caller does not, as `reserve` does not: `openEnvelope` has already bound
 * it at the write.
 */
export function capVerdict(of: {
  readonly cap: CapCommitted | undefined;
  readonly capId: string;
  readonly wanted: bigint;
  readonly currency: string | null;
}): RuntimeResult<never> | null {
  const { cap } = of;
  if (cap === undefined) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      `no budget cap ${of.capId} in this business`,
      'Provision the cap before approving work that draws on it.',
    );
  }
  // The cap is a ceiling in one currency, and a version in
  // another is refused here, before the first write, with the code an
  // existing envelope in another currency already answers.
  if (of.currency !== null && cap.currency !== of.currency) {
    return refuse(
      'CAP_BINDING_MISMATCH',
      `the cap behind this task is in ${cap.currency} and the version is in ${of.currency}`,
      'Propose the work in the currency the cap holds.',
    );
  }
  if (exceeds(cap.committed, of.wanted, cap.limitMinor)) {
    return refuse(
      'BUDGET_EXHAUSTED',
      `the cap behind this envelope has ${cap.committed} of ${cap.limitMinor} committed, so ${of.wanted} does not fit`,
      'The cap is the ceiling. Raising it is a separate authorised decision.',
    );
  }
  return null;
}

/**
 * Would `adding` take `committed` past `limit`? All three are
 * exact minor units. The two totals arrive as SQL text and are compared as
 * `bigint`, because a valid cap above 2^53 rounds as a JavaScript number and
 * the rounding can let one approval, or one handback's successor, past the
 * ceiling.
 */
export function exceeds(committed: string, adding: bigint, limit: string): boolean {
  return BigInt(committed) + adding > BigInt(limit);
}

/**
 * What observing an attempt did to its money (T2d). `unpriced` moved nothing:
 * an absent or unpriced report is neither a zero nor a success.
 * `liability_unknown` kept the whole hold, because the cost reported is more
 * than a person approved (O9); a person records its outcome.
 */
export type Settlement =
  | {
      readonly state: 'settled';
      readonly heldMinor: number;
      readonly spentMinor: number;
      readonly releasedMinor: number;
    }
  | { readonly state: 'unpriced'; readonly heldMinor: number }
  | {
      readonly state: 'liability_unknown';
      readonly heldMinor: number;
      readonly observedMinor: number;
    };

export function settledAt(heldMinor: bigint, spentMinor: bigint): Settlement {
  return {
    state: 'settled',
    heldMinor: Number(heldMinor),
    spentMinor: Number(spentMinor),
    releasedMinor: Number(heldMinor - spentMinor),
  };
}

/**
 * T2d: settle a dispatched attempt at its priced cost, under the caller's step,
 * lease and reservation locks. The step's attempt, the reservation and the
 * envelope move in the caller's one transaction, with the command's audit
 * event after them, so a failure in any rolls back all. The envelope gives
 * back the hold and takes the cost, which releases the difference to the cap.
 * No lease, run or task state moves: money settles on its own (an expired
 * lease included).
 */
export async function settleAtObserved(
  tx: TenantQuery,
  of: {
    readonly attemptId: string;
    readonly reservationId: string;
    readonly envelopeId: string;
    readonly heldMinor: bigint;
    readonly costMinor: bigint;
    readonly outcome: 'completed' | 'failed';
  },
): Promise<Settlement> {
  if (of.costMinor > of.heldMinor) {
    await tx.query(
      `update public.attempts set state = 'liability_unknown' where business_id = $1 and id = $2`,
      [tx.businessId, of.attemptId],
    );
    return {
      state: 'liability_unknown',
      heldMinor: Number(of.heldMinor),
      observedMinor: Number(of.costMinor),
    };
  }
  const cost = of.costMinor.toString();
  await tx.query(
    `update public.attempts set state = 'settled', actual_minor = $3, outcome = $4, settled_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, of.attemptId, cost, of.outcome],
  );
  await tx.query(
    `update public.reservations set state = 'actual', actual_minor = $3, terminal_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, of.reservationId, cost],
  );
  await tx.query(
    `update public.task_envelopes
        set held_minor = held_minor - $3, actual_minor = actual_minor + $4
      where business_id = $1 and id = $2`,
    [tx.businessId, of.envelopeId, of.heldMinor.toString(), cost],
  );
  return settledAt(of.heldMinor, of.costMinor);
}

/** What a top-up did (T2e): raised the envelope, or recorded a first approval. */
export type TopUp = Readonly<Record<string, unknown>> & {
  readonly state: 'applied' | 'awaiting_second_approver';
};

export interface TopUpRequest {
  readonly taskId: string;
  readonly amountMinor: bigint;
  /** The envelope maximum the person saw: a top-up is of that figure or of nothing. */
  readonly fromMaximumMinor: bigint;
  readonly personId: string;
  readonly subjects: readonly Subject[];
  readonly collection: string;
}

type TopUpResult =
  | { readonly ok: true; readonly value: TopUp }
  | { readonly ok: false; readonly refusal: CommandRefusal };

const refused = (code: RefusalCode, reason: string, fix: string): TopUpResult => ({
  ok: false,
  refusal: refuseCommand(code, [], [reason, fix]),
});

/**
 * T2e, under the cap, envelope and task locks with the covering grants held.
 * The cap is the hard ceiling (Q62). Above the four-eyes band a first approval
 * is the command's applied row in the operation register and moves nothing; a
 * different live holder naming the same figure applies it, and a moved
 * envelope leaves nothing standing (Q168). Below it, the plan's approver tops
 * up when they hold the grant, otherwise any holder.
 */
export async function topUp(tx: TenantQuery, request: TopUpRequest): Promise<TopUpResult> {
  const found = await openEnvelopeOf(tx, request.taskId);
  if (found === undefined) {
    return refused('BUDGET_UNAVAILABLE', 'this task has no open envelope', 'Approve a plan first.');
  }
  const figure = {
    envelopeId: found.id,
    fromMaximumMinor: Number(request.fromMaximumMinor),
    amountMinor: Number(request.amountMinor),
  };
  // The first approvers' grants are held with the caller's, before the runtime
  // set, so a revocation of either waits for this decision (Sol, #130).
  const held = await approvers(tx, FIRST_APPROVALS, [found.id, figure]);
  const holders = [...request.subjects, ...held.flatMap((first) => first.subjects)];
  await holdCoveringGrants(tx, holders, request.collection);
  await acquire(tx, [
    { lockClass: 'cap', id: found.capId },
    { lockClass: 'envelope', id: found.id },
    { lockClass: 'task', id: request.taskId },
  ]);
  const envelope = await openEnvelopeOf(tx, request.taskId);
  if (envelope?.id !== found.id || BigInt(envelope.maximumMinor) !== request.fromMaximumMinor) {
    return refused('VERSION_STALE', "the task's envelope has moved", 'Read the task again.');
  }
  const at = await lockedInstant(tx);
  const scope = { kind: 'record', id: request.taskId } as const;
  const ask = { collection: request.collection, action: 'decide', scope } as const;
  const holds = async (subjects: readonly Subject[]): Promise<boolean> =>
    (await checkAuthorityAt(tx, subjects, ask, at)).ok;
  const noGrant = 'ask a holder of budget permission on this task';
  if (!(await holds(request.subjects))) {
    return refused('SCOPE_NOT_GRANTED', 'no live grant covers it', noGrant);
  }
  const committed = BigInt(envelope.heldMinor) + BigInt(envelope.actualMinor);
  const wanted = BigInt(envelope.maximumMinor) - committed + request.amountMinor;
  const cap = await capCommitted(tx, envelope.capId);
  const ceiling = capVerdict({ cap, capId: envelope.capId, wanted, currency: envelope.currency });
  if (ceiling !== null) return ceiling;

  // Null is the band switched off; a business with no row has the shipped 500.
  const row = await readBusinessSetting(tx, 'four_eyes_threshold');
  const band = row === undefined ? 500 : row.value;
  const pairs = typeof band === 'number' && request.amountMinor > BigInt(Math.round(band * 100));
  const firsts = pairs ? held : [];
  const others = firsts.filter((first) => first.personId !== request.personId);
  const live = await Promise.all(others.map(async (one) => (await holds(one.subjects)) && one));
  const pair = live.find((one) => one !== false);
  const by = [...(pair === undefined ? [] : [pair.personId]), request.personId];
  if (pair === undefined && firsts.length > others.length) {
    return refused('FOUR_EYES_REQUIRED', 'you gave the first approval', 'Another holder approves.');
  }
  const [plan] = pair === undefined ? await approvers(tx, PLAN_APPROVER, [request.taskId]) : [];
  if (plan !== undefined && plan.personId !== request.personId && (await holds(plan.subjects))) {
    return refused('SCOPE_NOT_GRANTED', "the plan's approver holds the grant", noGrant);
  }
  if (pairs && pair === undefined) {
    const state = 'awaiting_second_approver';
    return { ok: true, value: { ...figure, state, firstApproverPersonId: request.personId } };
  }
  await tx.query(
    `update public.task_envelopes set maximum_minor = maximum_minor + $3
      where business_id = $1 and id = $2`,
    [tx.businessId, envelope.id, request.amountMinor.toString()],
  );
  const maximumMinor = figure.fromMaximumMinor + figure.amountMinor;
  return { ok: true, value: { ...figure, state: 'applied', maximumMinor, approvers: by } };
}

/** The first approvals waiting on exactly this figure. */
const FIRST_APPROVALS = `
  select o.result -> 'detail' ->> 'firstApproverPersonId' as person_id, o.actor_id
    from public.operations o
   where o.business_id = $1 and o.command = 'budget.top_up' and o.outcome = 'applied'
     and o.result -> 'detail' ->> 'state' = 'awaiting_second_approver'
     and o.result -> 'detail' ->> 'envelopeId' = $2
     and o.result -> 'detail' ->> 'fromMaximumMinor' = $3
     and o.result -> 'detail' ->> 'amountMinor' = $4
   order by o.created_at`;

/** Who approved the task's latest approved plan. */
const PLAN_APPROVER = `
  select d.decided_by_person_id as person_id, d.decided_by_actor_id as actor_id
    from public.gate_decisions d
    join public.proposal_lineages l on l.business_id = d.business_id and l.id = d.lineage_id
   where d.business_id = $1 and l.task_id = $2 and d.decision = 'approve'
   order by d.seq desc limit 1`;

/** People as grant subjects, read by one of the two queries above. */
async function approvers(
  tx: TenantQuery,
  sql: string,
  [id, figure]: readonly [string, { fromMaximumMinor: number; amountMinor: number }?],
): Promise<readonly { readonly personId: string; readonly subjects: readonly Subject[] }[]> {
  const values = figure === undefined ? [] : [figure.fromMaximumMinor, figure.amountMinor];
  const rows = await tx.query<{ readonly person_id: string; readonly actor_id: string }>(sql, [
    tx.businessId,
    id,
    ...values.map(String),
  ]);
  return rows.map((row) => ({
    personId: row.person_id,
    subjects: [
      { kind: 'person', id: row.person_id },
      { kind: 'actor', id: row.actor_id },
    ],
  }));
}
