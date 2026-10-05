// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10: the provider phase of the one reconciliation pass. A call held as
// unknown liability whose worker has stopped (its step is held unknown too),
// or a planning reply held so (AW-04: it has no step), is asked about at its
// provider, through custody, by the operation id the call carried. Only an answer that is the operation's declared proof that
// nothing happened releases the call's hold; the step then resumes through
// the pass's next phase (`withProviderCalls`, core-runtime). Any other answer,
// or none, changes nothing but the call's note, which says the pass could
// establish nothing and why. No timer reads the note: a call left unknown
// stays unknown until the provider proves absence or a person decides.
//
// The phase runs as system work, in the business's own transactions: one to
// find the calls, then for each the lookup outside any transaction (custody's
// wait is bounded by the operation's timeout), then one to record the answer,
// guarded on the call still being unknown with no outcome, so a person's
// outcome recorded meanwhile wins and the answer writes nothing. A provider
// that gives one lookup no answer is asked nothing more in that pass, in any
// business (the pass holds the set): its other calls say the pass established
// nothing, so a hung provider costs the pass one timeout, not one per call or
// per business, and cannot stall every business's sweep. A release writes
// `model.call_released` with its reason, as the settlement's release does.
//
// A lookup goes out under the gate a model call takes (`atCeiling`, AW-01):
// the business's own ceiling for the operation, then the route's ceiling and
// the business's fair share of it. With no room the lookup waits: nothing is
// sent and nothing written, so the next pass asks again. With room, the
// transaction that read the gate, still under its locks, takes the lookup's
// slot on the asked call's row (`lookup_until`, migration 20261004040000), which every
// one of those counts sees, so a second pass or a model call cannot take the
// same place. The slot is given back when the lookup ends, whatever it
// answered or if custody threw; a worker lost while asking leaves it to
// expire at the operation's timeout plus `SLOT_MARGIN_MS`.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { proofOf, reconcileModeOf, type Proof } from './broker-fault.ts';
import { giveBack, lockEnvelope } from './broker-give-back.ts';
import { atCeiling } from './broker-reserve.ts';
import type { Broker, BrokerRoute } from './broker-types.ts';

/** The most a lookup answer is read: one short code. */
const LOOKUP_BYTES = 4 * 1024;

/** The most calls one pass asks about in one business; the rest wait for the next pass. */
const MOST = 50;

const NOTE_MOST = 300;

/**
 * How long a lookup's slot outlives the operation's timeout. Custody's
 * deadline covers the whole lookup (`send`, egress.ts), so a slot still held
 * past that is a lost worker's; the margin covers custody's hand-off and the
 * transaction that gives the slot back.
 */
const SLOT_MARGIN_MS = 60_000;

export interface ProviderProof {
  readonly callId: string;
  readonly proved: boolean;
  readonly reason: string;
}

interface Asked {
  readonly id: string;
  readonly operation_key: string;
  readonly route_key: string | null;
  readonly route_reach: string | null;
  readonly credential_kind: string | null;
  readonly reserved_minor: string;
}

const nothing = (reason: string): Proof => ({ proved: false, reason });

/** A lookup with no room on its route, or one another pass is making: not sent, nothing written. */
const WAITS =
  "its route has no room for this business's lookup, or another pass is asking; the next pass asks again";

/** How the call is reconciled; a call the sweep held from a lost worker learns it here. */
function modeOf(broker: Broker, call: Asked): 'provider_lookup' | 'person' {
  const operation = broker.operations.get(call.operation_key);
  if (operation === undefined) return 'person';
  return reconcileModeOf(operation, broker.providers.get(operation.provider));
}

/**
 * The configured route matching what the call's row records: key, reach,
 * credential kind and provider, never another that shares only its key
 * (catalogue #439). The row records no credential, so when two configured
 * routes match, either account could have carried it and an absence on one
 * proves nothing: the reason a person records the outcome instead. One match
 * may still be a route re-pointed to another credential since (catalogue #943).
 */
function carryingRoute(broker: Broker, call: Asked, provider: string): BrokerRoute | string {
  const matching = broker.routes.filter(
    (one) =>
      one.key === call.route_key &&
      one.reach === call.route_reach &&
      one.credentialKind === call.credential_kind &&
      one.provider === provider,
  );
  if (matching.length > 1) {
    return 'more than one configured route matches its route; a person records the outcome';
  }
  return matching[0] ?? 'no configured route reaches its provider';
}

/**
 * Ask the call's provider whether it began the call, or `waits` when the
 * route has no room for it. A failed lookup is no proof, never a throw.
 */
async function ask(
  database: Database,
  businessId: BusinessId,
  broker: Broker,
  call: Asked,
): Promise<Proof | 'waits'> {
  const operation = broker.operations.get(call.operation_key);
  const adapter = operation === undefined ? undefined : broker.providers.get(operation.provider);
  if (operation === undefined || adapter?.lookup === undefined || !adapter.readLookup) {
    return nothing('no lookup is declared for this operation; a person records the outcome');
  }
  const route = carryingRoute(broker, call, operation.provider);
  if (typeof route === 'string') return nothing(route);
  // A person's own subscription is never carried by unattended work (AW-01's credential rule).
  if (route.credentialKind === 'subscription') {
    return nothing("the route's credential is a person's own; a person records the outcome");
  }
  const request = adapter.lookup(call.id);
  const slot = await database.withBusiness(businessId, async (tx) =>
    (await atCeiling(tx, operation, route))
      ? null
      : await takeSlot(tx, call.id, operation.timeoutMs + SLOT_MARGIN_MS),
  );
  if (slot === null) return 'waits';
  try {
    const outcome = await broker.custody.dispatch(route.credentialRef, {
      destination: operation.destination,
      path: request.path,
      method: request.method,
      body: request.body,
      timeoutMs: operation.timeoutMs,
      maxResponseBytes: LOOKUP_BYTES,
    });
    return proofOf(outcome, operation, adapter);
  } catch {
    return { proved: false, reason: 'custody could not ask the provider', silent: true };
  } finally {
    await database.withBusiness(businessId, async (tx) => {
      await giveSlot(tx, call.id, slot);
    });
  }
}

/**
 * The lookup's slot on its call, in the gate's transaction: null when the
 * call is no longer held unknown or another pass's slot on it is unexpired.
 * The answer is the slot's end, which only this taking wrote, so the give
 * back clears this slot and never a later one.
 */
async function takeSlot(tx: TenantQuery, callId: string, boundMs: number): Promise<string | null> {
  const [taken] = await tx.query<{ until: string }>(
    `update public.model_calls set lookup_until = clock_timestamp() + $3 * interval '1 millisecond'
      where business_id = $1 and id = $2 and state = 'liability_unknown' and outcome is null
        and (lookup_until is null or lookup_until <= clock_timestamp())
      returning lookup_until::text as until`,
    [tx.businessId, callId, boundMs],
  );
  return taken?.until ?? null;
}

/** Sent as text: a parameter typed `timestamptz` would pass through a JS Date and lose microseconds. */
async function giveSlot(tx: TenantQuery, callId: string, slot: string): Promise<void> {
  await tx.query(
    `update public.model_calls set lookup_until = null
      where business_id = $1 and id = $2 and lookup_until = $3::text::timestamptz`,
    [tx.businessId, callId, slot],
  );
}

/**
 * The answer on the call, only while it is still unknown and no person has
 * decided. A release gives back what a top-up or a stop counted of it
 * (`giveBack`), under its envelope's lock, taken first as settlement takes it.
 */
async function record(
  tx: TenantQuery,
  call: Asked,
  proof: Proof,
  broker: Broker,
): Promise<ProviderProof> {
  const callId = call.id;
  const reason = proof.proved ? `proved nothing happened: ${proof.code}` : proof.reason;
  const note = (proof.proved ? reason : `could establish nothing: ${reason}`).slice(0, NOTE_MOST);
  if (proof.proved) await lockEnvelope(tx, callId);
  const moved = await tx.query(
    `update public.model_calls
        set reconcile_note = $3, reconcile_mode = coalesce(reconcile_mode, $5),
            state = case when $4 then 'released' else state end,
            ended_at = case when $4 then clock_timestamp() else ended_at end
      where business_id = $1 and id = $2 and state = 'liability_unknown' and outcome is null
      returning id`,
    [tx.businessId, callId, note, proof.proved, modeOf(broker, call)],
  );
  if (proof.proved && moved.length > 0) {
    await giveBack(tx, callId);
    await broker.audit(tx, {
      action: 'model.call_released',
      outcome: 'applied',
      refusalCode: null,
      detail: {
        callId,
        operation: call.operation_key,
        releasedMinor: Number(call.reserved_minor),
        reason,
      },
    });
  }
  return { callId, proved: proof.proved, reason };
}

/**
 * The provider phase for one business, as system work. `unanswered` is the
 * pass's: the providers that gave a lookup no answer in any business so far.
 */
export async function reconcileProviderCalls(
  database: Database,
  businessId: BusinessId,
  broker: Broker,
  unanswered: Set<string> = new Set(),
): Promise<readonly ProviderProof[]> {
  const asked = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<Asked>(
        `select c.id, c.operation_key, c.route_key, c.route_reach, c.credential_kind,
                c.reserved_minor::text as reserved_minor
           from public.model_calls c
           left join public.attempts att
             on att.business_id = c.business_id and att.reservation_id = c.reservation_id
          where c.business_id = $1 and c.state = 'liability_unknown' and c.outcome is null
            and c.reconcile_mode is distinct from 'person'
            and (att.state = 'liability_unknown' or c.planning_envelope_id is not null)
          order by c.unknown_since, c.id
          limit $2`,
        [tx.businessId, MOST],
      ),
  );
  const proofs: ProviderProof[] = [];
  for (const call of asked) {
    const provider = broker.operations.get(call.operation_key)?.provider ?? '';
    // Sequential: one lookup at a time, each through the route's gate.
    const proof = unanswered.has(provider)
      ? nothing('its provider gave an earlier lookup in this pass no answer')
      : // eslint-disable-next-line no-await-in-loop
        await ask(database, businessId, broker, call);
    if (proof === 'waits') {
      proofs.push({ callId: call.id, proved: false, reason: WAITS });
    } else {
      if (!proof.proved && proof.silent === true) unanswered.add(provider);
      // eslint-disable-next-line no-await-in-loop
      const recorded = await database.withBusiness(
        businessId,
        async (tx) => await record(tx, call, proof, broker),
      );
      proofs.push(recorded);
    }
  }
  return proofs;
}
