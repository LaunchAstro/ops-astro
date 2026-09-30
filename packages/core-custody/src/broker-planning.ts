// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04's planning budget (U10, migration 0063): every planning reply before
// the accept is priced, against a small budget of its own. The business's
// planning cap (`budget_caps` key `planning`) is the allowance; none set means
// no planning spend. Each conversation spends through one planning envelope.
// A reply holds its operation's priced maximum as its own call row, under the
// cap's row lock, as a task call holds out of its reservation (0042); it then
// settles at its price, is released on proof nothing happened, or stays held
// as unknown liability. Nothing here is a second ledger: committed is the
// calls' holds and settled actuals, read under that lock.
//
// Lock order: the cap (`for update`, the contract's first class), then AW-01's
// ceiling key and route key (`atCeiling`), as `core-runtime/src/locks.ts` says.

import { randomUUID } from 'node:crypto';
import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import {
  localRoute,
  outsideFields,
  ownsConversation,
  refused,
  type ConversationCallRequest,
} from './broker-conversation.ts';
import {
  atCeiling,
  registerPromptCopy,
  WAIT_SECONDS,
  type ReservedCall,
} from './broker-reserve.ts';
import { hold, release, settlementOf, settlePriced } from './broker-settle.ts';
import type {
  Broker,
  BrokerRoute,
  ModelCaller,
  ModelCallResult,
  ResolvedField,
} from './broker-types.ts';

export interface PlanningAllowance {
  /** Whether the business has a planning cap: none set, no planning spend. */
  readonly set: boolean;
  readonly currency: string | null;
  readonly limitMinor: number;
  /** The cap less every planning call's hold or settled actual, in the business. */
  readonly leftMinor: number;
  /** The caller's own conversation: settled actuals and what is still held. */
  readonly conversation: { readonly spentMinor: number; readonly heldMinor: number };
}

interface Cap {
  readonly id: string;
  readonly limit_minor: string;
  readonly currency: string;
}

/** A call's committed amount: its actual once settled, its hold while held, else nothing. */
const COMMITTED = `case when m.state = 'settled' then m.actual_minor
                        when m.state in ('reserved', 'dispatched', 'liability_unknown')
                          then m.reserved_minor
                        else 0 end`;

async function planningCap(tx: TenantQuery, lock: boolean): Promise<Cap | undefined> {
  const [cap] = await tx.query<Cap>(
    `select id, limit_minor::text, currency from public.budget_caps
      where business_id = $1 and key = 'planning'${lock ? ' for update' : ''}`,
    [tx.businessId],
  );
  return cap;
}

async function committedUnder(tx: TenantQuery, capId: string): Promise<number> {
  const [row] = await tx.query<{ committed: string }>(
    `select coalesce(sum(${COMMITTED}), 0)::text as committed
       from public.model_calls m
       join public.planning_envelopes e
         on e.business_id = m.business_id and e.id = m.planning_envelope_id
      where m.business_id = $1 and e.cap_id = $2`,
    [tx.businessId, capId],
  );
  return Number(row?.committed ?? 0);
}

/** The conversation's one envelope, opened on its first priced reply. */
async function envelopeOf(
  tx: TenantQuery,
  capId: string,
  { conversation }: ConversationCallRequest,
): Promise<string> {
  await tx.query(
    `insert into public.planning_envelopes
       (business_id, id, cap_id, conversation_id, owner_person_id)
     values ($1, $2, $3, $4, $5)
     on conflict (business_id, conversation_id) do nothing`,
    [tx.businessId, randomUUID(), capId, conversation.id, conversation.ownerPersonId],
  );
  const [envelope] = await tx.query<{ id: string }>(
    `select id from public.planning_envelopes
      where business_id = $1 and conversation_id = $2 and owner_person_id = $3`,
    [tx.businessId, conversation.id, conversation.ownerPersonId],
  );
  if (envelope === undefined)
    throw new Error("the conversation's planning envelope is not its owner's");
  return envelope.id;
}

type Held = { readonly ok: true; readonly reserved: ReservedCall } | ModelCallResult;

/** Under the cap's lock: room for the priced maximum, then the envelope and the held, sent row. */
async function holdPlanning(
  tx: TenantQuery,
  request: ConversationCallRequest,
  operation: ModelOperation,
  route: BrokerRoute,
): Promise<Held> {
  const cap = await planningCap(tx, true);
  if (cap === undefined) return refused('BUDGET_UNAVAILABLE');
  if (await atCeiling(tx, operation, route)) {
    return { ok: false, code: 'RATE_LIMITED', callId: null, retryAfterSeconds: WAIT_SECONDS };
  }
  const committed = await committedUnder(tx, cap.id);
  if (committed + operation.maximumMinor > Number(cap.limit_minor)) {
    return refused('BUDGET_UNAVAILABLE');
  }
  const envelopeId = await envelopeOf(tx, cap.id, request);
  const callId = randomUUID();
  await tx.query(
    `insert into public.model_calls
       (business_id, id, conversation_id, planning_envelope_id, operation_key, state,
        reserved_minor, route_key, route_reach, credential_kind, started_at)
     values ($1, $2, $3, $4, $5, 'dispatched', $6, $7, $8, $9, clock_timestamp())`,
    [
      tx.businessId,
      callId,
      request.conversation.id,
      envelopeId,
      operation.key,
      operation.maximumMinor,
      route.key,
      route.reach,
      route.credentialKind,
    ],
  );
  await registerPromptCopy(tx, callId);
  return {
    ok: true,
    reserved: { callId, operation, route, reservedMinor: operation.maximumMinor },
  };
}

/** Through custody, then settled at its price within the hold, released, or held for a person. */
async function sendPlanning(
  database: Database,
  businessId: BusinessId,
  reserved: ReservedCall,
  fields: readonly ResolvedField[],
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId, operation, route, reservedMinor } = reserved;
  const adapter = broker.providers.get(operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${operation.provider}`);
  const built = adapter.build(Object.fromEntries(fields.map((field) => [field.name, field.value])));
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  const settlement = settlementOf(outcome, operation, adapter);
  return await database.withBusiness(businessId, async (tx) => {
    if (settlement.kind === 'unknown') return await hold(tx, reserved, null, settlement, broker);
    if (settlement.kind === 'nothing')
      return await release(tx, reserved, settlement.reason, broker);
    const { costMinor } = settlement;
    if (!Number.isSafeInteger(costMinor) || costMinor < 0 || costMinor > reservedMinor) {
      const observed = Number.isSafeInteger(costMinor) ? costMinor : null;
      return await hold(tx, reserved, observed, null, broker);
    }
    await settlePriced(tx, reserved, settlement, broker);
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

/**
 * A priced planning reply from the owner's own conversation. The conversation
 * seam's checks first (the owner, the catalogue, a local route under AW-03's
 * rule), then the hold under the planning cap, then the send.
 */
export async function callModelForPlanning(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ConversationCallRequest,
  broker: Broker,
): Promise<ModelCallResult> {
  if (!ownsConversation(businessId, caller, request)) return refused('AUTHORITY_LOST');
  const operation = broker.operations.get(request.operation);
  if (operation === undefined) return refused('OPERATION_NOT_CATALOGUED');
  if (operation.nothingHappened === 'not_reconcilable') return refused('EFFECT_NOT_RECONCILABLE');
  const fields = outsideFields(request.fields);
  const chosen = localRoute(operation, fields, caller, broker);
  if (!chosen.ok) return refused(chosen.code);
  const held = await database.withBusiness(
    businessId,
    async (tx) => await holdPlanning(tx, request, operation, chosen.route),
  );
  if (!('reserved' in held)) return held;
  return await sendPlanning(database, businessId, held.reserved, fields, broker);
}

/**
 * The allowance line and the planning spend. The cap and what is left are the
 * business's; the spend is the person's own conversation only, filtered by its
 * owner inside the query, so another person's conversation reads as none.
 */
export async function readPlanningAllowance(
  tx: TenantQuery,
  personId: string,
  conversationId: string,
): Promise<PlanningAllowance> {
  const cap = await planningCap(tx, false);
  const [own] = await tx.query<{ spent: string; held: string }>(
    `select coalesce(sum(case when m.state = 'settled' then m.actual_minor else 0 end), 0)::text
              as spent,
            coalesce(sum(case when m.state in ('reserved', 'dispatched', 'liability_unknown')
                              then m.reserved_minor else 0 end), 0)::text as held
       from public.planning_envelopes e
       join public.model_calls m
         on m.business_id = e.business_id and m.planning_envelope_id = e.id
      where e.business_id = $1 and e.conversation_id = $2 and e.owner_person_id = $3`,
    [tx.businessId, conversationId, personId],
  );
  const conversation = { spentMinor: Number(own?.spent ?? 0), heldMinor: Number(own?.held ?? 0) };
  if (cap === undefined) {
    return { set: false, currency: null, limitMinor: 0, leftMinor: 0, conversation };
  }
  const limitMinor = Number(cap.limit_minor);
  const leftMinor = Math.max(0, limitMinor - (await committedUnder(tx, cap.id)));
  return { set: true, currency: cap.currency, limitMinor, leftMinor, conversation };
}
