// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's model call (AW-01): the only way a priced model call is made.
//
// Three transactions and one send, in this order. The first can be the
// caller's own (`reserveModelCall`): the `model.call` command commits the
// hold with its register row, so one operation id holds once.
//
// 1. Reserve. Under the lease, delegation and reservation row locks (the
//    contract's order), verify the six facts against rows: the business (the
//    tenant transaction), the run and its step, the caller's live lease and
//    fence, the approved version the reservation holds for, the catalogued
//    operation, and the grant (the run's live delegation). None comes from
//    the caller, and the caller never names a destination. Then the data
//    classes choose the eligible routes before any route is chosen, the
//    credential rule checks the route's kind, and the operation's priced
//    maximum is held out of the reservation's room: a row in `model_calls`,
//    state `reserved`, with the outbound prompt's copy registered beside it.
//    A refusal after the facts hold is recorded as a step (state `refused`);
//    a refusal of the facts themselves writes nothing.
// 2. Start. The six facts are read again under their locks, and a call whose
//    authority went since the hold is released unsent. The call is marked
//    `dispatched` with its route and credential kind before custody is
//    asked, so a crash after this point leaves a call the sweep holds as
//    unknown liability and never releases.
// 3. Send, through custody, with a request the adapter built from registered
//    fields. The broker's process opens no connection.
// 4. Settle, under the same locks, with the audit event in the same
//    transaction: priced within the hold settles and releases the rest;
//    positive proof that nothing happened releases it all; above the hold, or
//    no answer, holds the maximum as `liability_unknown` until a person
//    records an outcome. An expired lease still settles the cost; the work is
//    refused.
//
// Step 1 is broker-reserve.ts, the six facts broker-facts.ts, step 4
// broker-settle.ts; the shapes are broker-types.ts.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { lockFacts } from './broker-facts.ts';
import { promptCopyRegistered, reserveModelCall, type ReservedCall } from './broker-reserve.ts';
import { settle, settlementOf } from './broker-settle.ts';
import type {
  Broker,
  BrokerRefusal,
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
} from './broker-types.ts';

export type {
  AuditNote,
  Broker,
  BrokerRefusal,
  BrokerRoute,
  ModelCaller,
  ModelCallField,
  ModelCallRequest,
  ModelCallResult,
  ProviderAdapter,
} from './broker-types.ts';
export {
  promptCopyRegistered,
  registerPromptCopy,
  reserveModelCall,
  type Reservation,
  type ReservedCall,
  type ReserveRefusal,
} from './broker-reserve.ts';

/**
 * Step 2, as the effect applies: the six facts again under their locks, so a
 * lease, delegation or reservation lost since the hold sends nothing. The
 * hold is then released, never started, with the route it would have taken
 * and no start time. Only then is the call marked `dispatched`.
 */
async function markStarted(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  broker: Broker,
): Promise<'started' | BrokerRefusal> {
  return await database.withBusiness(businessId, async (tx) => {
    const route = [reserved.route.key, reserved.route.reach, reserved.route.credentialKind];
    const checked = await lockFacts(tx, caller, request, false);
    if (!checked.ok) {
      await tx.query(
        `update public.model_calls
            set state = 'released', ended_at = clock_timestamp(),
                route_key = $3, route_reach = $4, credential_kind = $5
          where business_id = $1 and id = $2 and state = 'reserved'`,
        [tx.businessId, reserved.callId, ...route],
      );
      await broker.audit(tx, {
        action: 'model.call_released',
        outcome: 'refused',
        refusalCode: checked.code,
        detail: { callId: reserved.callId, code: checked.code },
      });
      return checked.code;
    }
    if (!(await promptCopyRegistered(tx, reserved.callId))) return 'COPY_NOT_REGISTERED';
    await tx.query(
      `update public.model_calls
          set state = 'dispatched', started_at = clock_timestamp(),
              route_key = $3, route_reach = $4, credential_kind = $5
        where business_id = $1 and id = $2 and state = 'reserved'`,
      [tx.businessId, reserved.callId, ...route],
    );
    return 'started';
  });
}

/** One priced model call, through the broker only. */
export async function callModel(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  broker: Broker,
): Promise<ModelCallResult> {
  const reserving = await database.withBusiness(
    businessId,
    async (tx) => await reserveModelCall(tx, caller, request, broker),
  );
  if (!reserving.ok) {
    // The register's shape is the command layer's to answer with; this caller gets the result.
    const { refusal: _refusal, ...result } = reserving;
    return result;
  }
  return await sendReservedCall(database, businessId, caller, request, reserving.reserved, broker);
}

/** Steps 2 to 4, after the hold has committed: start, send through custody, settle. */
export async function sendReservedCall(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  broker: Broker,
): Promise<ModelCallResult> {
  const started = await markStarted(database, businessId, caller, request, reserved, broker);
  if (started !== 'started') return { ok: false, code: started, callId: reserved.callId };
  const adapter = broker.providers.get(reserved.operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${reserved.operation.provider}`);
  const values = Object.fromEntries(request.fields.map((field) => [field.name, field.value]));
  const built = adapter.build(values);
  const outcome = await broker.custody.dispatch(reserved.route.credentialRef, {
    destination: reserved.operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: reserved.operation.timeoutMs,
    maxResponseBytes: reserved.operation.maxResponseBytes,
  });
  const settlement = settlementOf(outcome, reserved.operation, adapter);
  return await settle(database, businessId, caller, request, reserved, settlement, broker);
}

/** The lease-expiry sweep's half: a started call with no answer is held, never released; one never started is released. */
export async function sweepModelCalls(
  tx: TenantQuery,
): Promise<{ readonly held: number; readonly released: number }> {
  const held = await tx.query(
    `update public.model_calls c
        set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_no_answer'
       from public.leases l
      where c.business_id = $1 and l.business_id = c.business_id and l.id = c.lease_id
        and c.state = 'dispatched' and (l.state <> 'live' or l.expires_at <= clock_timestamp())
      returning c.id`,
    [tx.businessId],
  );
  const released = await tx.query(
    `update public.model_calls c
        set state = 'released', ended_at = clock_timestamp()
       from public.leases l
      where c.business_id = $1 and l.business_id = c.business_id and l.id = c.lease_id
        and c.state = 'reserved' and (l.state <> 'live' or l.expires_at <= clock_timestamp())
      returning c.id`,
    [tx.businessId],
  );
  return { held: held.length, released: released.length };
}
