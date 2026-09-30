// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's model call (AW-01): the only way a priced model call is made.
//
// Three transactions and one send, in this order. The first can be the
// caller's own (`reserveModelCall`): the `model.call` command commits the
// hold with its register row, so one operation id holds once.
//
// 1. Reserve. Under the task, lease, delegation and reservation row locks
//    (the contract's order), verify the six facts against rows: the business (the
//    tenant transaction), the run and its step, the caller's live lease and
//    fence, the approved version the reservation holds for, the catalogued
//    operation, and the grant (the run's live delegation). None comes from
//    the caller, and the caller never names a destination. A task a client
//    is on is refused here, before any route (C60). Each field's source is
//    found from the run's task it is bound to, never taken from the
//    caller (S3, `broker-sources.ts`). Then the data
//    classes choose the eligible routes before any route is chosen, the
//    credential rule checks the route's kind, and the operation's priced
//    maximum is held out of the reservation's room: a row in `model_calls`,
//    state `reserved`, with the outbound prompt's copy registered beside it.
//    A refusal after the facts hold is recorded as a step (state `refused`);
//    a refusal of the facts themselves writes nothing.
// 2. Start. The six facts, the client link and the task's source are read again
//    under their locks, and a call whose authority went, whose task gained a
//    client, or whose route its task's source no longer allows, since the hold is
//    released unsent. The values sent are the ones read here. The call is marked
//    `dispatched` with its route and credential kind before custody is
//    asked, so a crash after this point leaves a call the sweep holds as
//    unknown liability and never releases.
// 3. Send, through custody, with a request the adapter built from registered
//    fields. The broker's process opens no connection.
// 4. Settle, under the same locks taken by the call's own rows, with the
//    audit event in the same transaction: priced within the hold settles and
//    releases the rest; positive proof that nothing happened releases it all;
//    above the hold, or no answer, holds the maximum as `liability_unknown`
//    until a person records an outcome. A lease that expired or left the
//    caller mid-call still settles the cost; the work is refused.
//
// Step 1 is broker-reserve.ts, the six facts broker-facts.ts, step 4
// broker-settle.ts; the shapes are broker-types.ts.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { eligibleRoutes } from '../../core-connectors/src/index.ts';
import { lockFacts, type Checked } from './broker-facts.ts';
import { resolveFields } from './broker-sources.ts';
import { promptCopyRegistered, reserveModelCall, type ReservedCall } from './broker-reserve.ts';
import { settle, settlementOf } from './broker-settle.ts';
import type {
  Broker,
  BrokerRefusal,
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
  ResolvedField,
} from './broker-types.ts';

export type {
  AuditNote,
  Broker,
  BrokerRefusal,
  BoundField,
  BrokerRoute,
  ClaimedField,
  ModelCaller,
  ModelCallField,
  ModelCallRequest,
  ModelCallResult,
  ProviderAdapter,
  ResolvedField,
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
 * Step 2, as the effect applies: the six facts and the client link again
 * under their locks, so a lease, delegation or reservation lost since the
 * hold, or a client put on the task since, sends nothing. The hold is then
 * released, never started, with the route it would have taken and no start
 * time. Only then is the call marked `dispatched`.
 */
async function markStarted(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  broker: Broker,
): Promise<{ readonly fields: readonly ResolvedField[] } | BrokerRefusal> {
  return await database.withBusiness(businessId, async (tx) => {
    const route = [reserved.route.key, reserved.route.reach, reserved.route.credentialKind];
    const checked = startable(await lockFacts(tx, caller, request), request, reserved);
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
    return { fields: checked.fields };
  });
}

/**
 * The start's own decision, on the facts read again under their locks: a task
 * that gained a client, or a task that became unreadable or stopped being a
 * business-internal source, releases the call unsent (C60, S3). The
 * values sent are the ones read here, under the share locks.
 */
function startable(
  facts: Checked,
  request: ModelCallRequest,
  reserved: ReservedCall,
):
  | { readonly ok: true; readonly fields: readonly ResolvedField[] }
  | { readonly ok: false; readonly code: BrokerRefusal } {
  if (!facts.ok) return facts;
  if (facts.facts.clientId !== null) return { ok: false, code: 'CLIENT_MODEL_USE_OFF' };
  const resolved = resolveFields(request.fields, facts.facts.source);
  if (!resolved.ok) return resolved;
  const still = eligibleRoutes(reserved.operation.fields, resolved.fields, [reserved.route]);
  if (!still.ok || still.routes.length === 0) return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  return { ok: true, fields: resolved.fields };
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
  if (typeof started === 'string') return { ok: false, code: started, callId: reserved.callId };
  const adapter = broker.providers.get(reserved.operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${reserved.operation.provider}`);
  const values = Object.fromEntries(started.fields.map((field) => [field.name, field.value]));
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

/**
 * The lease-expiry sweep's half: a started call with no answer is held, never
 * released; one never started is released. A conversation call's lease is its
 * age.
 */
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
  // A conversation call has no lease: started, it is dropped once it has
  // outlived five times the longest wait custody allows (120 s) and held,
  // so a lost process never leaves it counting as in flight.
  const conversations = await tx.query(
    `update public.model_calls
        set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_no_answer'
      where business_id = $1 and conversation_id is not null and state = 'dispatched'
        and started_at <= clock_timestamp() - interval '10 minutes'
      returning id`,
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
  return { held: held.length + conversations.length, released: released.length };
}
