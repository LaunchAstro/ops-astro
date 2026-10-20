// SPDX-License-Identifier: AGPL-3.0-only
//
// Step 4 of a model call (AW-01): what custody's outcome means, and the settlement under the six
// facts' locks with its audit event. A call closes once: settled or released, by a provider's
// proof, a person or its own answer, it ignores a later answer and gives nothing back again. A
// hold moves it only out of an open state (`reserved`, `dispatched`); an answer may also settle
// or release one the sweep held, since the answer is what happened, and gives back what a top-up
// or a stop counted of it, as an open call's does.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import {
  SETTLE_LEVELS,
  type FieldSource,
  type ModelAnswer,
  type ModelOperation,
} from '../../core-connectors/src/index.ts';
import {
  declaresNothing,
  failureOf,
  MALFORMED,
  reconcileModeOf,
  WORKER_LOST,
  type Failure,
} from './broker-fault.ts';
import type { CredentialKind } from './credentials.ts';
import type { CustodyOutcome } from './custody.ts';
import { lockCall, lockedState } from './broker-facts.ts';
import { giveBack } from './broker-give-back.ts';
import { dropAfterStop, releaseEndOf, stopAtSettlement, UNPROVEN_RELEASE } from './broker-stop.ts';
import { settledAnswer } from './broker-limit.ts';
import type { ReservedCall } from './broker-reserve.ts';
import type {
  Broker,
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
  ProviderAdapter,
} from './broker-types.ts';

const reaches = (operation: ModelOperation, level: (typeof SETTLE_LEVELS)[number]): boolean =>
  SETTLE_LEVELS.indexOf(level) <= SETTLE_LEVELS.indexOf(operation.settlesAt);

export type Settlement =
  | {
      readonly kind: 'priced';
      readonly answer: ModelAnswer;
      readonly costMinor: number;
      readonly account: string | null;
      readonly credentialKind: CredentialKind;
    }
  | { readonly kind: 'nothing'; readonly reason: string; readonly judged?: boolean }
  | ({ readonly kind: 'unknown' } & Failure);

/**
 * What custody's outcome means for the money: priced, positive proof that
 * nothing happened, or unknown with what the failure was (AW-10,
 * `broker-fault.ts`). A provider code the operation declared proves nothing
 * happened whether it came in an answer or as the status of a refusal.
 */
export function settlementOf(
  outcome: CustodyOutcome,
  operation: ModelOperation,
  adapter: ProviderAdapter,
  streamed = false,
): Settlement {
  if (outcome.kind === 'worker_lost') return { kind: 'unknown', ...WORKER_LOST };
  if (outcome.kind === 'refused')
    return { kind: 'nothing', reason: outcome.code, judged: outcome.judged === true };
  if (outcome.kind === 'withheld') return { kind: 'unknown', ...MALFORMED };
  if (!outcome.outbound.ok) {
    const failure = failureOf(outcome.outbound.fault, outcome.outbound.status);
    if (declaresNothing(operation, failure.providerCode)) {
      return { kind: 'nothing', reason: String(failure.providerCode) };
    }
    return { kind: 'unknown', ...failure };
  }
  // A stream asked for is folded first; one asked for whole is read whole (a stream is no answer).
  const { body: sent } = outcome.outbound;
  const text = streamed && operation.fold !== undefined ? operation.fold(sent) : sent;
  if (text === undefined) return { kind: 'unknown', ...MALFORMED };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'unknown', ...MALFORMED };
  }
  const answer = operation.answer(body);
  if (answer === undefined) return { kind: 'unknown', ...MALFORMED };
  if (declaresNothing(operation, answer.providerCode)) {
    return { kind: 'nothing', reason: String(answer.providerCode) };
  }
  return {
    kind: 'priced',
    answer,
    costMinor: adapter.price(answer),
    account: outcome.account,
    credentialKind: outcome.credentialKind,
  };
}

/**
 * The run's step, marked as one that may have acted (AW-10): a call held
 * unknown went out and nobody knows what it did, so the step is the
 * dispatched, marked attempt the sweep, a hand-back and the reconciliation
 * pass already stop on (T2c1, T3b). Only the attempt still in its owning
 * state on the call's own hold; a conversation or planning call has none.
 */
export async function markStepActed(tx: TenantQuery, callId: string): Promise<void> {
  await tx.query(
    `update public.attempts att
        set dispatch_marker = true
       from public.model_calls c
      where c.business_id = $1 and c.id = $2 and att.business_id = c.business_id
        and att.reservation_id = c.reservation_id and att.state = 'dispatched'`,
    [tx.businessId, callId],
  );
}

/** The states an answer may close: open, or held by the sweep before the answer came. */
const ANSWERABLE = `('reserved', 'dispatched', 'liability_unknown')`;

/** Open: not yet answered or held. */
const open = (state: string | undefined): boolean => state === 'reserved' || state === 'dispatched';

/** The answer to a close that found its call already closed: it moved nothing. */
const closed = (callId: string): ModelCallResult => ({ ok: false, code: 'DECISION_STALE', callId });

/** Above the hold, or no answer: the maximum stays held as unknown liability until a person records an outcome. */
export async function hold(
  tx: TenantQuery,
  reserved: ReservedCall,
  observed: number | null,
  drop: (Settlement & { kind: 'unknown' }) | null,
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId, operation, reservedMinor } = reserved;
  // Above the hold is the provider's answer: its fault, with no drop and no code.
  const failure: Failure = drop ?? MALFORMED;
  const said = {
    observedMinor: observed,
    drop: drop?.drop ?? null,
    cause: failure.cause,
    fault: failure.fault,
    providerCode: failure.providerCode,
  };
  const moved = await tx.query(
    `update public.model_calls
        set state = 'liability_unknown', observed_minor = $3, fault = $4, drop_state = $5,
            drop_cause = $6, provider_code = $7, reconcile_mode = $8,
            unknown_since = clock_timestamp()
      where business_id = $1 and id = $2 and state in ('reserved', 'dispatched')
      returning id`,
    [
      tx.businessId,
      callId,
      observed,
      said.fault,
      said.drop,
      said.cause,
      said.providerCode,
      reconcileModeOf(operation, broker.providers.get(operation.provider)),
    ],
  );
  if (moved.length === 0) return closed(callId);
  await markStepActed(tx, callId);
  await broker.audit(tx, {
    action: 'model.call_held',
    outcome: 'refused',
    refusalCode: 'LIABILITY_UNKNOWN',
    detail: { callId, operation: operation.key, heldMinor: reservedMinor, ...said },
  });
  return { ok: false, code: 'LIABILITY_UNKNOWN', callId, heldMinor: reservedMinor, ...said };
}

/**
 * Positive proof that nothing happened: the whole hold is released. Here and
 * in a priced settle, a drop the sweep recorded before the answer came is
 * cleared: the answer is what happened (0085, `model_calls_drop_is_held`).
 */
export async function release(
  tx: TenantQuery,
  reserved: ReservedCall,
  reason: string,
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId, operation, reservedMinor } = reserved;
  const moved = await tx.query(
    `update public.model_calls set state = 'released', ended_at = clock_timestamp(), drop_state = null
      where business_id = $1 and id = $2 and state in ${ANSWERABLE}
      returning id`,
    [tx.businessId, callId],
  );
  if (moved.length === 0) return closed(callId);
  await broker.audit(tx, {
    action: 'model.call_released',
    outcome: 'applied',
    refusalCode: null,
    detail: { callId, operation: operation.key, releasedMinor: reservedMinor, reason },
  });
  return { ok: false, code: 'CALL_RELEASED', callId, reason };
}

/** Priced within the hold: settled at the price, the rest released. Whether it moved the call. */
export async function settlePriced(
  tx: TenantQuery,
  reserved: ReservedCall,
  settlement: Settlement & { kind: 'priced' },
  broker: Broker,
): Promise<boolean> {
  const { callId, operation, reservedMinor } = reserved;
  const { costMinor } = settlement;
  const moved = await tx.query(
    `update public.model_calls
        set state = 'settled', observed_minor = $3, actual_minor = $3, account = $4,
            credential_kind = $5, drop_state = null,
            completed_at = case when $6 then clock_timestamp() end,
            landed_at = case when $7 then clock_timestamp() end,
            ended_at = clock_timestamp(),
            model_id = $8, input_units = $9, output_units = $10
      where business_id = $1 and id = $2 and state in ${ANSWERABLE}
      returning id`,
    [
      tx.businessId,
      callId,
      costMinor,
      settlement.credentialKind === 'replay' ? null : settlement.account,
      // A subscription route records its own kind (LA-1): custody's credential is only the
      // local runner's loopback key, and the row must show where the carve-out was used.
      reserved.route.credentialKind === 'subscription' ? 'subscription' : settlement.credentialKind,
      reaches(operation, 'completed'),
      reaches(operation, 'landed'),
      settlement.answer.model,
      settlement.answer.usage.inputUnits,
      settlement.answer.usage.outputUnits,
    ],
  );
  if (moved.length === 0) return false;
  await broker.audit(tx, {
    action: 'model.call_dispatched',
    outcome: 'applied',
    refusalCode: null,
    detail: {
      callId,
      operation: operation.key,
      route: reserved.route.key,
      credentialKind: settlement.credentialKind,
      reservedMinor,
      actualMinor: costMinor,
      releasedMinor: reservedMinor - costMinor,
    },
  });
  return true;
}

export async function settle(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  settlement: Settlement,
  broker: Broker,
  turn?: FieldSource,
): Promise<ModelCallResult> {
  return await database.withBusiness(businessId, async (tx) => {
    const drop = await dropAfterStop(tx, settlement, request.leaseId, broker);
    const work = await lockCall(tx, reserved.callId, caller, request.fence);
    const { callId, reservedMinor } = reserved;
    const state = await lockedState(tx, callId);
    if (state !== 'liability_unknown' && !open(state)) return closed(callId);
    // #1623 R1: an unknown, a release and an unproven release each end the attempt.
    // A provider drop (only an unknown settlement has one) is recorded after the stop.
    const unknown = async (observed: number | null, failure: Parameters<typeof hold>[3]) => {
      const held = await hold(tx, reserved, observed, failure, broker);
      const stopped = await stopAtSettlement(tx, request.leaseId, work, 'LIABILITY_UNKNOWN', held);
      if (work === 'stands') await drop?.();
      return stopped;
    };
    if (settlement.kind === 'unknown') return await unknown(null, settlement);
    if (settlement.kind === 'nothing') {
      const end = releaseEndOf(settlement, reserved.operation);
      if (end === undefined) return await unknown(null, UNPROVEN_RELEASE);
      const released = await release(tx, reserved, settlement.reason, broker);
      await giveBack(tx, callId);
      return await stopAtSettlement(tx, request.leaseId, work, end, released);
    }
    const { costMinor } = settlement;
    if (!Number.isSafeInteger(costMinor) || costMinor < 0 || costMinor > reservedMinor) {
      return await unknown(Number.isSafeInteger(costMinor) ? costMinor : null, null);
    }
    await settlePriced(tx, reserved, settlement, broker);
    await giveBack(tx, callId);
    if (work !== 'stands') return { ok: false, code: work, callId };
    return await settledAnswer(tx, request.leaseId, reserved, settlement, turn);
  });
}
