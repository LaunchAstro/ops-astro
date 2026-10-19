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
//    a refusal of the facts themselves writes nothing. An attempt with a call
//    dropped and held unknown takes no other call (`LIABILITY_UNKNOWN`), so a
//    framework's own retry is refused and only a new attempt calls again.
// 2. Start. The six facts, the client link and the task's source are read again
//    under their locks, and a call whose authority went, whose attempt had a
//    sibling call dropped and held unknown, whose task gained a client, or whose
//    route its task's source no longer allows, since the hold is released unsent.
//    The values sent are the ones read here. The call is marked `dispatched`
//    with its route and credential kind before custody is asked, so a crash
//    after this point leaves a call the sweep holds as unknown liability and
//    never releases.
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
import { taskAdmission } from './broker-admission.ts';
import { lockFacts, type Checked } from './broker-facts.ts';
import { lockEnvelope } from './broker-give-back.ts';
import { carriesHere, sweepCarried, writeCarriers } from './broker-carriage.ts';
import type { Handoff } from './carriage.ts';
import { releaseRefused, releaseUnsent } from './broker-release.ts';
import { heldUnknown } from './broker-holds.ts';
import { clientRefusal, resolveFields } from './broker-sources.ts';
import { promptCopyRegistered, reserveModelCall, type ReservedCall } from './broker-reserve.ts';
import { sendingAccount } from './broker-carrier.ts';
import { settle, settlementOf } from './broker-settle.ts';
import type {
  Broker,
  BrokerRefusal,
  Carrier,
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
  CallFault,
  Carrier,
  ClaimedField,
  DropCause,
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
 * hold, a sibling call held unknown since, or a client put on the task since,
 * sends nothing. The hold is then released, never started, with the route it
 * would have taken and no start time, and gives back what a top-up or a stop
 * counted of it (`giveBack`, catalogue #756), under its envelope's lock, taken
 * first as settlement takes it. Only then is the call marked `dispatched`.
 * Both updates move only a `reserved` call, and the start sends only when its
 * update moved one: a retried or concurrent send of the same hold, or one the
 * sweep released meanwhile, finds none and sends nothing
 * (`EFFECT_NOT_RECONCILABLE`). A release that moved nothing records nothing
 * and gives nothing back. A task's call carried to the model agent (#1703)
 * needs its carrier to be an active agent here, or is released unsent
 * (`CARRIAGE_UNAVAILABLE`), and is written with its carriers row.
 */
async function markStarted(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  broker: Broker,
  sending: { readonly account: string | null; readonly carrier: Carrier | undefined },
): Promise<{ readonly fields: readonly ResolvedField[] } | BrokerRefusal> {
  const { account, carrier } = sending;
  return await database.withBusiness(businessId, async (tx) => {
    const { key, reach, credentialKind, provider, credentialRef } = reserved.route;
    const route = [key, reach, credentialKind, provider, credentialRef, account];
    await lockEnvelope(tx, reserved.callId);
    const facts = await lockFacts(tx, caller, request);
    const unknown = facts.ok && (await heldUnknown(tx, facts.facts.reservationId));
    const here = carrier === undefined || (await carriesHere(tx, carrier));
    const copied = here && facts.ok && (await promptCopyRegistered(tx, reserved.callId));
    const checked = here
      ? startable(facts, request, reserved, unknown, copied)
      : ({ ok: false, code: 'CARRIAGE_UNAVAILABLE' } as const);
    if (!checked.ok)
      return await releaseRefused(tx, reserved.callId, route, checked.code, facts, broker);
    const started = await tx.query(
      `update public.model_calls
          set state = 'dispatched', started_at = clock_timestamp(),
              route_key = $3, route_reach = $4, credential_kind = $5,
              provider = $6, credential_ref = $7, account = $8
        where business_id = $1 and id = $2 and state = 'reserved'
        returning id`,
      [tx.businessId, reserved.callId, ...route],
    );
    if (started.length === 0) return 'EFFECT_NOT_RECONCILABLE';
    if (carrier !== undefined) await writeCarriers(tx, reserved.callId, carrier);
    return { fields: checked.fields };
  });
}

/**
 * The start's own decision, on the facts read again under their locks: a
 * sibling call of the attempt dropped and held unknown since this one was held
 * (read under the reservation lock its settle takes), a task that gained a
 * client, or a task that became unreadable or stopped being a
 * business-internal source, releases the call unsent (AW-12 A7, C60, S3). The
 * values sent are the ones read here, under the share locks.
 * A prompt copy never registered is refused last, released unsent the same way.
 */
function startable(
  facts: Checked,
  request: ModelCallRequest,
  reserved: ReservedCall,
  siblingUnknown: boolean,
  copied: boolean,
):
  | { readonly ok: true; readonly fields: readonly ResolvedField[] }
  | { readonly ok: false; readonly code: BrokerRefusal } {
  if (!facts.ok) return facts;
  if (siblingUnknown) return { ok: false, code: 'LIABILITY_UNKNOWN' };
  if (facts.facts.clientId !== null) {
    return { ok: false, code: clientRefusal([reserved.route], reserved.operation) };
  }
  const resolved = resolveFields(request.fields, facts.facts.source);
  if (!resolved.ok) return resolved;
  const still = eligibleRoutes(reserved.operation.fields, resolved.fields, [reserved.route]);
  if (!still.ok || still.routes.length === 0) return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  if (!copied) return { ok: false, code: 'COPY_NOT_REGISTERED' };
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

/**
 * Steps 2 to 4, after the hold has committed: start, send through custody,
 * settle. With `carry`, on a broker with a carrier, the call is carried to
 * the model agent (#1703): custody is given the call's handoff, whose two
 * judgements stand in for the subscription's admission.
 */
export async function sendReservedCall(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  broker: Broker,
  carry?: (callId: string) => Handoff,
): Promise<ModelCallResult> {
  // The account custody will present, recorded before the send: the only
  // proof a later lookup asks the account that carried it (broker-reconcile.ts).
  const account = await sendingAccount(broker, reserved.route, reserved.operation.destination);
  const carrier = carry === undefined ? undefined : broker.carrier;
  const started = await markStarted(database, businessId, caller, request, reserved, broker, {
    account,
    carrier,
  });
  if (typeof started === 'string') return { ok: false, code: started, callId: reserved.callId };
  const adapter = broker.providers.get(reserved.operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${reserved.operation.provider}`);
  const values = Object.fromEntries(started.fields.map((field) => [field.name, field.value]));
  const built = adapter.build(values, reserved.callId);
  const outcome = await broker.custody.dispatch(
    reserved.route.credentialRef,
    {
      destination: reserved.operation.destination,
      path: built.path,
      method: built.method,
      body: built.body,
      timeoutMs: reserved.operation.timeoutMs,
      maxResponseBytes: reserved.operation.maxResponseBytes,
    },
    undefined,
    // Owner line 72: a subscription send is judged again at the handoff, the task held; a
    // carried call's handoff judges it again after the agent's accept instead.
    reserved.route.credentialKind === 'subscription' && carrier === undefined
      ? taskAdmission(database, businessId, request, reserved)
      : undefined,
    carrier === undefined ? undefined : carry?.(reserved.callId),
  );
  const settlement = settlementOf(outcome, reserved.operation, adapter);
  return await settle(database, businessId, caller, request, reserved, settlement, broker);
}

/**
 * The lease-expiry sweep's half: a started call with no answer is held, never
 * released; one never started is released, and gives back what a top-up or a
 * stop counted of it under its hold's lock (`giveBack`, catalogue #756). A
 * conversation call's lease is its age.
 */
export async function sweepModelCalls(
  tx: TenantQuery,
): Promise<{ readonly held: number; readonly released: number }> {
  const held = await tx.query(
    `update public.model_calls c
        set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_no_answer',
            unknown_since = clock_timestamp()
       from public.leases l
      where c.business_id = $1 and l.business_id = c.business_id and l.id = c.lease_id
        and c.state = 'dispatched' and (l.state <> 'live' or l.expires_at <= clock_timestamp())
      returning c.id`,
    [tx.businessId],
  );
  // A conversation call has no lease: started, it is dropped once it has
  // outlived five times the longest wait custody allows (120 s) and held,
  // so a lost process never leaves it counting as in flight. A call the
  // carriage has offered is the next statement's.
  const conversations = await tx.query(
    `update public.model_calls c
        set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_no_answer',
            unknown_since = clock_timestamp()
      where c.business_id = $1 and c.conversation_id is not null and c.state = 'dispatched'
        and c.started_at <= clock_timestamp() - interval '10 minutes'
        and not exists (select 1 from public.model_call_carriers k
                         where k.business_id = c.business_id and k.call_id = c.id
                           and k.offered_at is not null)
      returning c.id`,
    [tx.businessId],
  );
  const carried = await sweepCarried(tx);
  const released = await releaseUnsent(tx);
  return {
    held: held.length + conversations.length + carried.held,
    released: released.length + carried.released,
  };
}
