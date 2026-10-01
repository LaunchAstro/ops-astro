// SPDX-License-Identifier: AGPL-3.0-only
//
// Step 4 of a model call (AW-01): what custody's outcome means, and the
// settlement under the six facts' locks with its audit event.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import {
  SETTLE_LEVELS,
  type ModelAnswer,
  type ModelOperation,
} from '../../core-connectors/src/index.ts';
import type { CredentialKind } from './credentials.ts';
import type { CustodyOutcome } from './custody.ts';
import { lockCall } from './broker-facts.ts';
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
  | { readonly kind: 'nothing'; readonly reason: string }
  | {
      readonly kind: 'unknown';
      readonly drop: 'dropped_worker_lost' | 'dropped_no_answer' | null;
      readonly fault: 'ours' | 'provider';
    };

/** What custody's outcome means for the money: priced, positive proof that nothing happened, or unknown. */
export function settlementOf(
  outcome: CustodyOutcome,
  operation: ModelOperation,
  adapter: ProviderAdapter,
): Settlement {
  if (outcome.kind === 'worker_lost')
    return { kind: 'unknown', drop: 'dropped_worker_lost', fault: 'ours' };
  if (outcome.kind === 'refused') return { kind: 'nothing', reason: outcome.code };
  if (!outcome.outbound.ok)
    return { kind: 'unknown', drop: 'dropped_no_answer', fault: 'provider' };
  let body: unknown;
  try {
    body = JSON.parse(outcome.outbound.body);
  } catch {
    return { kind: 'unknown', drop: 'dropped_no_answer', fault: 'provider' };
  }
  const answer = operation.answer(body);
  if (answer === undefined)
    return { kind: 'unknown', drop: 'dropped_no_answer', fault: 'provider' };
  const proof = operation.nothingHappened;
  if (
    answer.providerCode !== null &&
    proof !== 'not_reconcilable' &&
    proof.includes(answer.providerCode)
  ) {
    return { kind: 'nothing', reason: answer.providerCode };
  }
  return {
    kind: 'priced',
    answer,
    costMinor: adapter.price(answer),
    account: outcome.account,
    credentialKind: outcome.credentialKind,
  };
}

/** Above the hold, or no answer: the maximum stays held as unknown liability until a person records an outcome. */
export async function hold(
  tx: TenantQuery,
  reserved: ReservedCall,
  observed: number | null,
  drop: (Settlement & { kind: 'unknown' }) | null,
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId, operation, reservedMinor } = reserved;
  await tx.query(
    `update public.model_calls
        set state = 'liability_unknown', observed_minor = $3, fault = $4, drop_state = $5
      where business_id = $1 and id = $2`,
    [tx.businessId, callId, observed, drop?.fault ?? 'provider', drop?.drop ?? null],
  );
  await broker.audit(tx, {
    action: 'model.call_held',
    outcome: 'refused',
    refusalCode: 'LIABILITY_UNKNOWN',
    detail: {
      callId,
      operation: operation.key,
      heldMinor: reservedMinor,
      observedMinor: observed,
      drop: drop?.drop ?? null,
    },
  });
  return {
    ok: false,
    code: 'LIABILITY_UNKNOWN',
    callId,
    heldMinor: reservedMinor,
    observedMinor: observed,
    drop: drop?.drop ?? null,
  };
}

/** Positive proof that nothing happened: the whole hold is released. */
export async function release(
  tx: TenantQuery,
  reserved: ReservedCall,
  reason: string,
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId, operation, reservedMinor } = reserved;
  await tx.query(
    `update public.model_calls set state = 'released', ended_at = clock_timestamp()
      where business_id = $1 and id = $2`,
    [tx.businessId, callId],
  );
  await broker.audit(tx, {
    action: 'model.call_released',
    outcome: 'applied',
    refusalCode: null,
    detail: { callId, operation: operation.key, releasedMinor: reservedMinor, reason },
  });
  return { ok: false, code: 'CALL_RELEASED', callId, reason };
}

/** Priced within the hold: settled at the price, the rest released. */
export async function settlePriced(
  tx: TenantQuery,
  reserved: ReservedCall,
  settlement: Settlement & { kind: 'priced' },
  broker: Broker,
): Promise<void> {
  const { callId, operation, reservedMinor } = reserved;
  const { costMinor } = settlement;
  await tx.query(
    `update public.model_calls
        set state = 'settled', observed_minor = $3, actual_minor = $3, account = $4,
            credential_kind = $5,
            completed_at = case when $6 then clock_timestamp() end,
            landed_at = case when $7 then clock_timestamp() end,
            ended_at = clock_timestamp(),
            model_id = $8, input_units = $9, output_units = $10
      where business_id = $1 and id = $2`,
    [
      tx.businessId,
      callId,
      costMinor,
      settlement.credentialKind === 'replay' ? null : settlement.account,
      settlement.credentialKind,
      reaches(operation, 'completed'),
      reaches(operation, 'landed'),
      settlement.answer.model,
      settlement.answer.usage.inputUnits,
      settlement.answer.usage.outputUnits,
    ],
  );
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
}

export async function settle(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  settlement: Settlement,
  broker: Broker,
): Promise<ModelCallResult> {
  return await database.withBusiness(businessId, async (tx) => {
    const work = await lockCall(tx, reserved.callId, caller, request.fence);
    const { callId, reservedMinor } = reserved;
    if (settlement.kind === 'unknown') return await hold(tx, reserved, null, settlement, broker);
    if (settlement.kind === 'nothing')
      return await release(tx, reserved, settlement.reason, broker);
    const { costMinor } = settlement;
    if (!Number.isSafeInteger(costMinor) || costMinor < 0 || costMinor > reservedMinor) {
      const observed = Number.isSafeInteger(costMinor) ? costMinor : null;
      return await hold(tx, reserved, observed, null, broker);
    }
    await settlePriced(tx, reserved, settlement, broker);
    if (work !== 'stands') return { ok: false, code: work, callId };
    return {
      ok: true,
      callId,
      text: settlement.answer.text,
      reservedMinor,
      actualMinor: costMinor,
      releasedMinor: reservedMinor - costMinor,
    };
  });
}
