// SPDX-License-Identifier: AGPL-3.0-only
//
// The stop's outcome (#1623 R1, R2): the transaction that stops an attempt's
// work records its one outcome there, never a worker afterwards. Every writer
// calls `recordStop` under its own locks on the attempt's lease and
// delegation; this takes the attempt's open calls last, in id order.
//
// - Precedence is decided here, under those locks: with a call of the attempt
//   still dispatched or held unknown, the row is `unknown_provider_outcome`
//   and the code the writer would have used is kept as `stop_cause`.
// - Calls held and never started are released, as the sweep releases an
//   unsent hold. A dispatched call is left as it is: its late answer still
//   settles and charges.
// - The first writer wins by the primary key. A later stop finds the row,
//   writes nothing and reads the stored one; the row never changes.

import { outcomeOf, type EndCode, type RunOutcome } from '../../core-wire/src/index.ts';
import { revokeDelegation, type TenantQuery } from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import type { Failure } from './broker-fault.ts';
import { COUNTED_CAUSES, countedHold, giveBack } from './broker-give-back.ts';
import type { Checked } from './broker-facts.ts';
import type { Broker, BrokerRefusal } from './broker-types.ts';

/** The stored stop of one attempt. */
export interface StoppedAs {
  readonly attemptId: string;
  readonly outcome: RunOutcome;
  readonly endCode: EndCode;
}

/** The attempt's stop, as decided under the locks: its own code, or unknown beside an open call. */
function decided(
  code: EndCode,
  open: readonly { readonly state: string }[],
): { readonly endCode: EndCode; readonly stopCause: EndCode | null } {
  if (outcomeOf(code) === 'unknown_provider_outcome') return { endCode: code, stopCause: null };
  if (open.some((call) => call.state === 'dispatched'))
    return { endCode: 'OPEN_CALL_AT_STOP', stopCause: code };
  if (open.some((call) => call.state === 'liability_unknown'))
    return { endCode: 'LIABILITY_UNKNOWN', stopCause: code };
  return { endCode: code, stopCause: null };
}

/**
 * Record the attempt's outcome for a stop of the work on `leaseId`, and
 * release its unsent holds. Under the caller's locks on the lease (and its
 * delegation). A lease that serves no run attempt records nothing.
 */
export async function recordStop(
  tx: TenantQuery,
  leaseId: string,
  code: EndCode,
): Promise<StoppedAs | undefined> {
  const [attempt] = await tx.query<{ id: string; run_id: string; holder: string }>(
    `select a.id, a.run_id, l.holder_actor_id as holder
       from public.attempts a
       join public.leases l on l.business_id = a.business_id and l.id = a.lease_id
      where a.business_id = $1 and a.lease_id = $2`,
    [tx.businessId, leaseId],
  );
  if (attempt === undefined) return undefined;
  const open = await tx.query<{ id: string; state: string }>(
    `select id, state from public.model_calls
      where business_id = $1 and lease_id = $2
        and state in ('reserved', 'dispatched', 'liability_unknown')
      order by id for update`,
    [tx.businessId, leaseId],
  );
  const { endCode, stopCause } = decided(code, open);
  await tx.query(
    `insert into public.run_outcomes
       (business_id, attempt_id, planned_run_id, outcome, end_code, stop_cause, recorded_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (business_id, attempt_id) do nothing`,
    [
      tx.businessId,
      attempt.id,
      attempt.run_id,
      outcomeOf(endCode),
      endCode,
      stopCause,
      attempt.holder,
    ],
  );
  await releaseNeverSent(
    tx,
    open.filter((call) => call.state === 'reserved').map((call) => call.id),
  );
  const [stored] = await tx.query<{ outcome: RunOutcome; end_code: EndCode }>(
    `select outcome, end_code from public.run_outcomes where business_id = $1 and attempt_id = $2`,
    [tx.businessId, attempt.id],
  );
  return stored === undefined
    ? undefined
    : { attemptId: attempt.id, outcome: stored.outcome, endCode: stored.end_code };
}

/**
 * Holds never started, proven unsent, released on their rows' locks. A hold a
 * count took (a top-up, or the end at a budget stop) is left for the sweep,
 * which gives it back under its envelope and hold in the contract's order
 * (`broker-release.ts`): this writer holds neither, so it gives nothing back.
 */
async function releaseNeverSent(tx: TenantQuery, unsent: readonly string[]): Promise<void> {
  if (unsent.length === 0) return;
  await tx.query(
    `update public.model_calls c set state = 'released', ended_at = clock_timestamp()
       from public.reservations r
      where c.business_id = $1 and c.id = any($2::uuid[]) and c.state = 'reserved'
        and r.business_id = c.business_id and r.id = c.reservation_id
        and not ${countedHold('$3')}`,
    [tx.businessId, unsent, COUNTED_CAUSES],
  );
}

/**
 * A stop the broker owns: the outcome, then the work's authority ended (the
 * lease released, its delegation retired), so the same lease can no longer
 * reserve, start, read or hand back. Under the caller's locks on both.
 */
export async function retireAttempt(
  tx: TenantQuery,
  work: { readonly leaseId: string; readonly delegationId: string | null },
  code: EndCode,
): Promise<StoppedAs | undefined> {
  const stopped = await recordStop(tx, work.leaseId, code);
  await tx.query(
    `update public.leases set state = 'released', released_at = now()
      where business_id = $1 and id = $2 and state = 'live'`,
    [tx.businessId, work.leaseId],
  );
  if (work.delegationId !== null) await revokeDelegation(tx, work.delegationId, 'work_retired');
  return stopped;
}

/** A broker refusal's end code. Total: a new refusal fails the type check until it maps. */
export function endCodeOfRefusal(code: BrokerRefusal): EndCode {
  // The reply to a call already ended is the lost answer, never weaker than unknown.
  return code === 'ANSWER_ENDED' ? 'ANSWER_LOST' : code;
}

/**
 * Custody's own refusals before a send: each proves nothing left. The ones
 * the contract names keep their code; the rest are custody not admitting it.
 */
const CUSTODY_UNSENT: ReadonlySet<string> = new Set([
  'SEND_LAPSED',
  'CUSTODY_NOT_ADMITTED',
  'CUSTODY_UNKNOWN_REQUEST',
  'CUSTODY_REQUEST_MALFORMED',
  'CUSTODY_CREDENTIAL_UNKNOWN',
  'CUSTODY_ROUTE_REFUSED',
  'CREDENTIAL_MALFORMED',
  'CARRY_KEY_MALFORMED',
  'CARRIAGE_UNAVAILABLE',
  'PROMPT_TOO_LARGE',
  'DESTINATION_MALFORMED',
  'DESTINATION_FORBIDDEN',
  'DESTINATION_ADDRESS_DENIED',
  'SEAL_MALFORMED',
  'SEAL_FORGED',
  'SEAL_EXPIRED',
  'SEAL_WRONG_WAY',
  'NOT_AT_ONCE',
]);

/**
 * `CALL_RELEASED`, normalised: a release reason is a custody code
 * or one of the operation's declared nothing-happened provider codes, and each
 * maps to one end code. A reason in neither set is no proof that nothing
 * happened: `undefined`, which settlement holds as unknown.
 */
export function releaseEndOf(reason: string, operation: ModelOperation): EndCode | undefined {
  if (CUSTODY_UNSENT.has(reason)) {
    return reason === 'CARRIAGE_UNAVAILABLE' || reason === 'PROMPT_TOO_LARGE'
      ? reason
      : 'CUSTODY_NOT_ADMITTED';
  }
  const declared = operation.nothingHappened;
  if (declared === 'not_reconcilable' || !declared.includes(reason)) return undefined;
  return reason === 'LOCAL_PLAN_LIMIT' ? 'LOCAL_PLAN_LIMIT' : 'PROVIDER_NOTHING_HAPPENED';
}

/**
 * A release reason nobody declared: held as unknown, the maximum kept.
 * Custody answered it, so the fault is ours; it is no provider's code.
 */
export const UNPROVEN_RELEASE: Failure & { readonly kind: 'unknown' } = {
  kind: 'unknown',
  cause: null,
  fault: 'ours',
  providerCode: null,
  drop: 'dropped_no_answer',
};

/**
 * Settlement's stop (transaction 3, after the reserve committed): a call's
 * end that ends its attempt, on work that still stands, records the outcome
 * and retires the work under settlement's locks on the lease and delegation.
 * Work already ended keeps the stop that ended it.
 */
export async function stopAtSettlement(
  tx: TenantQuery,
  leaseId: string,
  work: string,
  code: EndCode,
): Promise<void> {
  if (work !== 'stands') return;
  const [lease] = await tx.query<{ delegation_id: string | null }>(
    'select delegation_id from public.leases where business_id = $1 and id = $2',
    [tx.businessId, leaseId],
  );
  await retireAttempt(tx, { leaseId, delegationId: lease?.delegation_id ?? null }, code);
}

/**
 * A call released at its start: what a count took of it given back, the
 * release audited, and, on work that still stands, its attempt ended with the
 * refusal's code (#1623 R1, transaction 2).
 */
export async function refusedAtStart(
  tx: TenantQuery,
  callId: string,
  code: BrokerRefusal,
  facts: Checked,
  broker: Broker,
): Promise<void> {
  await giveBack(tx, callId);
  await broker.audit(tx, {
    action: 'model.call_released',
    outcome: 'refused',
    refusalCode: code,
    detail: { callId, code },
  });
  if (facts.ok) await retireAttempt(tx, facts.facts, endCodeOfRefusal(code));
}
