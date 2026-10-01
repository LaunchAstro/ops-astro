// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10: the provider phase of the one reconciliation pass. A call held as
// unknown liability whose worker has stopped (its step is held unknown too)
// is asked about at its provider, through custody, by the operation id the
// call carried. Only an answer that is the operation's declared proof that
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

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { proofOf, reconcileModeOf, type Proof } from './broker-fault.ts';
import type { Broker } from './broker-types.ts';

/** The most a lookup answer is read: one short code. */
const LOOKUP_BYTES = 4 * 1024;

/** The most calls one pass asks about in one business; the rest wait for the next pass. */
const MOST = 50;

const NOTE_MOST = 300;

export interface ProviderProof {
  readonly callId: string;
  readonly proved: boolean;
  readonly reason: string;
}

interface Asked {
  readonly id: string;
  readonly operation_key: string;
  readonly route_key: string | null;
  readonly reserved_minor: string;
}

const nothing = (reason: string): Proof => ({ proved: false, reason });

/** How the call is reconciled; a call the sweep held from a lost worker learns it here. */
function modeOf(broker: Broker, call: Asked): 'provider_lookup' | 'person' {
  const operation = broker.operations.get(call.operation_key);
  if (operation === undefined) return 'person';
  return reconcileModeOf(operation, broker.providers.get(operation.provider));
}

/** Ask the call's provider whether it began the call. Never throws: a failure is no proof. */
async function ask(broker: Broker, call: Asked): Promise<Proof> {
  const operation = broker.operations.get(call.operation_key);
  const adapter = operation === undefined ? undefined : broker.providers.get(operation.provider);
  if (operation === undefined || adapter?.lookup === undefined || !adapter.readLookup) {
    return nothing('no lookup is declared for this operation; a person records the outcome');
  }
  const route = broker.routes.find((one) => one.key === call.route_key);
  if (route === undefined) return nothing('no configured route reaches its provider');
  // A person's own subscription is never carried by unattended work (AW-01's credential rule).
  if (route.credentialKind === 'subscription') {
    return nothing("the route's credential is a person's own; a person records the outcome");
  }
  const request = adapter.lookup(call.id);
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
  }
}

/** The answer on the call, only while it is still unknown and no person has decided. */
async function record(
  tx: TenantQuery,
  call: Asked,
  proof: Proof,
  broker: Broker,
): Promise<ProviderProof> {
  const callId = call.id;
  const reason = proof.proved ? `proved nothing happened: ${proof.code}` : proof.reason;
  const note = (proof.proved ? reason : `could establish nothing: ${reason}`).slice(0, NOTE_MOST);
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
        `select c.id, c.operation_key, c.route_key, c.reserved_minor::text as reserved_minor
           from public.model_calls c
           join public.attempts att
             on att.business_id = c.business_id and att.reservation_id = c.reservation_id
          where c.business_id = $1 and c.state = 'liability_unknown' and c.outcome is null
            and c.reconcile_mode is distinct from 'person' and att.state = 'liability_unknown'
          order by c.unknown_since, c.id
          limit $2`,
        [tx.businessId, MOST],
      ),
  );
  const proofs: ProviderProof[] = [];
  for (const call of asked) {
    const provider = broker.operations.get(call.operation_key)?.provider ?? '';
    // Sequential: one lookup at a time keeps the pass inside the route's ceiling.
    const proof = unanswered.has(provider)
      ? nothing('its provider gave an earlier lookup in this pass no answer')
      : // eslint-disable-next-line no-await-in-loop
        await ask(broker, call);
    if (!proof.proved && proof.silent === true) unanswered.add(provider);
    // eslint-disable-next-line no-await-in-loop
    const recorded = await database.withBusiness(
      businessId,
      async (tx) => await record(tx, call, proof, broker),
    );
    proofs.push(recorded);
  }
  return proofs;
}
