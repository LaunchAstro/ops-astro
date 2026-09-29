// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers, the facts they are decided on (`budget-answer.ts`).
//
// An answer finds its rows first and takes no authority from what it finds.
// The grants are held `for share` before the locks, as decide.ts does, then
// the set is locked in the contract's order (cap, envelope, task, run,
// lineage, reservation) and every fact is read again under it: the run still
// waiting, its latest ask unanswered, the grant live at the locked instant.
// Two answers at once meet on the run lock, and the second finds the ask
// answered.

import {
  checkAuthority,
  refuseCommand,
  type CommandRefusal,
  type DelegationRefusalCode,
  type Subject,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import { lockedInstant } from './clock.ts';
import { fourEyesBandMinor, minorDigits } from './four-eyes.ts';
import { acquire } from './locks.ts';
import { checkAuthorityAt, holdCoveringGrants } from './recovery/classifier.ts';
import { refuse, type RuntimeRefusalCode } from './refusals.ts';

/** Who answers, and the subjects the grant model reads for them. */
export interface BudgetAnswerRequest {
  readonly runId: string;
  readonly caller:
    | { readonly kind: 'person'; readonly personId: string; readonly actorId: string }
    | { readonly kind: 'agent'; readonly actorId: string };
  readonly subjects: readonly Subject[];
}

export type Person = Extract<BudgetAnswerRequest['caller'], { kind: 'person' }>;

/**
 * The runtime's refusals (the delegation's included), and the four registered
 * caller codes an answer produces: a person's decision under a delegation, a
 * run not in this business, a malformed amount, and a top-up that needs a
 * second person.
 */
export type BudgetAnswerCode =
  | RuntimeRefusalCode
  | DelegationRefusalCode
  | 'DELEGATION_EXCLUDES_DECISION'
  | 'NOT_FOUND'
  | 'FIELD_VALUE_INVALID'
  | 'FOUR_EYES_REQUIRED';

export type BudgetAnswerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CommandRefusal<BudgetAnswerCode> };

/** What discovery found, before any lock. Everything is read again under them. */
interface Found {
  readonly task_id: string;
  readonly lineage_id: string;
  readonly reservation_id: string;
  readonly envelope_id: string;
  readonly cap_id: string;
}

/** The facts an answer is decided on, read under the locks. */
export interface Locked extends Found {
  readonly run_state: string;
  readonly ask_id: string;
  readonly answered: boolean;
  readonly lineage_state: string;
  readonly superseded: boolean;
  readonly reservation_state: string;
  readonly held_minor: string;
  readonly version_id: string;
  readonly currency: string;
}

export interface Opened {
  readonly person: Person;
  readonly locked: Locked;
  readonly lockedAt: string;
}

export const NOT_WAITING_FIX = 'Re-read the run. A stop is answered once.';

/** A registered caller code in the runtime's shape: the reason, then the fix. */
export function deny(
  code: BudgetAnswerCode,
  reason: string,
  fix: string,
): BudgetAnswerResult<never> {
  return { ok: false, refusal: refuseCommand(code, [], [reason, fix]) };
}

export function invalid(field: string, fix: string): BudgetAnswerResult<never> {
  return { ok: false, refusal: refuseCommand('FIELD_VALUE_INVALID', [field], [fix]) };
}

/**
 * Who may answer, found, locked and read again: a person holding `decide` on
 * the collection for the run's task, and the run still waiting on an
 * unanswered ask. Refusals write nothing.
 */
export async function openAnswer(
  tx: TenantQuery,
  request: BudgetAnswerRequest,
  collection: 'billing' | 'gate',
): Promise<BudgetAnswerResult<Opened>> {
  const { caller } = request;
  if (caller.kind !== 'person') {
    return deny(
      'DELEGATION_EXCLUDES_DECISION',
      "an agent never answers a budget stop: a top-up and the end are a person's decisions",
      'A person answers the stop.',
    );
  }
  const found = await discover(tx, request.runId);
  if (found === undefined) {
    return deny(
      'NOT_FOUND',
      'no run in this business has stopped at its ceiling under that id',
      'Re-read the run you were asked about.',
    );
  }
  const scope = decideOn(collection, found.task_id);
  if (!(await checkAuthority(tx, request.subjects, scope)).ok) return notGranted(collection);
  await holdCoveringGrants(tx, request.subjects, collection);

  await acquire(tx, [
    { lockClass: 'cap', id: found.cap_id },
    { lockClass: 'envelope', id: found.envelope_id },
    { lockClass: 'task', id: found.task_id },
    { lockClass: 'run', id: request.runId },
    { lockClass: 'lineage', id: found.lineage_id },
    { lockClass: 'reservation', id: found.reservation_id },
  ]);
  const lockedAt = await lockedInstant(tx);
  if (!(await checkAuthorityAt(tx, request.subjects, scope, lockedAt)).ok) {
    return notGranted(collection);
  }
  const locked = await readLocked(tx, request.runId, found);
  if (locked === undefined || locked.run_state !== 'waiting_budget' || locked.answered) {
    return refuse(
      'TRANSITION_NOT_PERMITTED',
      'this run is not waiting for budget, or its stop has been answered already',
      NOT_WAITING_FIX,
    );
  }
  return { ok: true, value: { person: caller, locked, lockedAt } };
}

/** The run's task, lineage, and the reservation, envelope and cap its latest ask stopped. */
async function discover(tx: TenantQuery, runId: string): Promise<Found | undefined> {
  const [found] = await tx.query<Found>(
    `select run.task_id, run.lineage_id, k.reservation_id, res.envelope_id, e.cap_id
       from public.planned_runs run
       join public.records t
         on t.business_id = run.business_id and t.id = run.task_id and t.deleted_at is null
       join lateral (select reservation_id from public.budget_asks
                      where business_id = run.business_id and run_id = run.id
                      order by ask_number desc limit 1) k on true
       join public.reservations res on res.business_id = run.business_id and res.id = k.reservation_id
       join public.task_envelopes e on e.business_id = res.business_id and e.id = res.envelope_id
      where run.business_id = $1 and run.id = $2`,
    [tx.businessId, runId],
  );
  return found;
}

async function readLocked(
  tx: TenantQuery,
  runId: string,
  found: Found,
): Promise<Locked | undefined> {
  const [locked] = await tx.query<Omit<Locked, keyof Found>>(
    `select run.state as run_state, k.id as ask_id,
            exists (select 1 from public.budget_answers a
                     where a.business_id = k.business_id and a.ask_id = k.id) as answered,
            lin.state as lineage_state, (ver.superseded_at is not null) as superseded,
            res.state as reservation_state, res.held_minor::text as held_minor,
            res.version_id, e.currency
       from public.planned_runs run
       join lateral (select id, business_id from public.budget_asks
                      where business_id = run.business_id and run_id = run.id
                      order by ask_number desc limit 1) k on true
       join public.proposal_lineages lin on lin.business_id = run.business_id and lin.id = run.lineage_id
       join public.reservations res on res.business_id = run.business_id and res.id = $3
       join public.proposal_versions ver on ver.business_id = res.business_id and ver.id = res.version_id
       join public.task_envelopes e on e.business_id = res.business_id and e.id = res.envelope_id
      where run.business_id = $1 and run.id = $2`,
    [tx.businessId, runId, found.reservation_id],
  );
  return locked === undefined ? undefined : { ...found, ...locked };
}

/** `decide` on the collection, asked of the run's own task. */
function decideOn(collection: 'billing' | 'gate', taskId: string) {
  return { collection, action: 'decide' as const, scope: { kind: 'record' as const, id: taskId } };
}

function notGranted(collection: 'billing' | 'gate'): BudgetAnswerResult<never> {
  return refuse(
    'SCOPE_NOT_GRANTED',
    `answering this stop needs ${collection}:decide on its task, and the caller holds none`,
    `A person holding ${collection}:decide on this task answers it.`,
  );
}

/**
 * The four-eyes band in the envelope's minor units, by the one rule
 * (`four-eyes.ts`): read `for share` under the answer's locks, null is off, and
 * a business with no row has the shipped 500. With the words a refusal names.
 */
export async function thresholdOf(
  tx: TenantQuery,
  currency: string,
): Promise<{ readonly minor: number; readonly words: string } | null> {
  const band = await fourEyesBandMinor(tx, currency);
  if (band === null) return null;
  const digits = minorDigits(currency);
  const minor = Number(band);
  return { minor, words: `${(minor / 10 ** digits).toFixed(digits)} ${currency}` };
}

export interface Approval {
  readonly id: string;
  readonly person_id: string;
  readonly actor_id: string;
  readonly amount_minor: string;
  readonly currency: string;
}

/** The ask's approvals so far. Append-only, and read under the run lock every answer takes. */
export async function approvalsOf(tx: TenantQuery, askId: string): Promise<readonly Approval[]> {
  return await tx.query<Approval>(
    `select id, person_id, actor_id, amount_minor::text as amount_minor, currency
       from public.budget_approvals where business_id = $1 and ask_id = $2
      order by approved_at, id`,
    [tx.businessId, askId],
  );
}

/**
 * The person who approved the plan, when they still hold `billing:decide` on
 * the task at the locked instant; null when they do not, and any holder
 * answers.
 */
export async function approverHolds(tx: TenantQuery, opened: Opened): Promise<string | null> {
  const [decision] = await tx.query<{ readonly person_id: string; readonly actor_id: string }>(
    `select decided_by_person_id as person_id, decided_by_actor_id as actor_id
       from public.gate_decisions
      where business_id = $1 and version_id = $2 and decision = 'approve'
      order by seq desc limit 1`,
    [tx.businessId, opened.locked.version_id],
  );
  if (decision === undefined) return null;
  const holds = await checkAuthorityAt(
    tx,
    [
      { kind: 'person', id: decision.person_id },
      { kind: 'actor', id: decision.actor_id },
    ],
    {
      collection: 'billing',
      action: 'decide',
      scope: { kind: 'record', id: opened.locked.task_id },
    },
    opened.lockedAt,
  );
  return holds.ok ? decision.person_id : null;
}

/**
 * The reservation's spend to date, as the broker counts it
 * (`core-custody/src/broker-facts.ts`, `committedMinor`): settled calls at
 * their actual, and calls still open at the maximum they hold, so a call in
 * flight at the stop is never released as unspent.
 */
export async function spentOn(tx: TenantQuery, reservationId: string): Promise<number> {
  const [row] = await tx.query<{ readonly spent: string }>(
    `select coalesce(sum(case when state = 'settled' then actual_minor
                              when state in ('reserved', 'dispatched', 'liability_unknown')
                                then reserved_minor
                              else 0 end), 0)::text as spent
       from public.model_calls where business_id = $1 and reservation_id = $2`,
    [tx.businessId, reservationId],
  );
  return Number(row?.spent ?? 0);
}
