// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's conversation seam (ORCH35, option a): a person's model call from
// their own conversation, which has no task lease, run, step or approved
// version. Local routes only and unpriced: no money moves, so nothing is
// reserved, and a cloud route is refused before anything is written (AW-03
// egress off). A priced planning reply takes the same checks and holds
// against the planning budget (`broker-planning.ts`, AW-04's U10).

import { randomUUID } from 'node:crypto';
import {
  slotOf,
  TASK_SPINE,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import { eligibleRoutes, type ModelOperation } from '../../core-connectors/src/index.ts';
import { mayCarry } from './credentials.ts';
import {
  atCeiling,
  registerPromptCopy,
  WAIT_SECONDS,
  type ReservedCall,
} from './broker-reserve.ts';
import { hold, release, settlementOf, settlePriced } from './broker-settle.ts';
import type {
  Broker,
  BrokerRefusal,
  BrokerRoute,
  ClaimedField,
  ModelCaller,
  ModelCallResult,
  ResolvedField,
} from './broker-types.ts';

/**
 * The conversation as the command layer found it, from its own row under the
 * caller's business (the conversation's table and its checks are SL12's; the
 * foreign key joins at the batch 3 join). The broker rechecks each fact
 * against the authenticated caller, never the body.
 */
export interface ConversationScope {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
}

export interface ConversationCallRequest {
  readonly conversation: ConversationScope;
  readonly operation: string;
  readonly fields: readonly ClaimedField[];
}

export const refused = (code: BrokerRefusal): ModelCallResult => ({
  ok: false,
  code,
  callId: null,
});

/** S3: a claim of business-internal only narrows; the person's words are outside. */
export function outsideFields(fields: readonly ClaimedField[]): readonly ResolvedField[] {
  return fields.map((field) => ({
    name: field.name,
    source: field.source === 'business_internal' ? ('outside' as const) : field.source,
    value: field.value,
  }));
}

/** Only the owner, in their own session, with no delegation between them and the call. */
export function ownsConversation(
  businessId: BusinessId,
  caller: ModelCaller,
  { conversation }: ConversationCallRequest,
): boolean {
  return (
    conversation.businessId === businessId &&
    caller.delegationId === null &&
    caller.attendedByPersonId !== null &&
    caller.attendedByPersonId === conversation.ownerPersonId
  );
}

/** A local route the fields may take and the person's own session may carry, or why not. */
export function localRoute(
  operation: ModelOperation,
  fields: readonly ResolvedField[],
  caller: ModelCaller,
  broker: Broker,
):
  | { readonly ok: true; readonly route: BrokerRoute }
  | { readonly ok: false; readonly code: BrokerRefusal } {
  const local = broker.routes.filter(
    (route) => route.reach === 'local' && route.provider === operation.provider,
  );
  const choice = eligibleRoutes(operation.fields, fields, local);
  const route = choice.ok
    ? local.find((candidate) => choice.routes.some((eligible) => eligible.key === candidate.key))
    : undefined;
  if (route === undefined) return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  const carry = mayCarry(route.credentialKind, {
    unattended: false,
    sessionPersonId: caller.attendedByPersonId,
    workForPersonId: caller.attendedByPersonId,
    tenantInstallation: broker.installation,
    credentialInstallation: route.installation,
  });
  return carry.ok ? { ok: true, route } : { ok: false, code: carry.code };
}

/** A map's client link, the map held `for share`; nothing for a parent that is no map. */
const HOLD_MAP = `select ${slotOf(TASK_SPINE, 'client')}::text as client from public.records
      where business_id = $1 and id = $2 and data ->> 'type' = 'map'
      for share`;

/**
 * A task's client for egress (C60, WF-6, WF-7): its own client link, else its
 * map's. `task.reparent` and `task.set_party` can leave a scoped map's ticket
 * with no link of its own, or another client's, and the map's still covers
 * it. `query(lock)` reads the task's `client` and `parent` (a ticket's map is
 * its parent): read once unheld, then the map is held `for share` before the
 * task, the order `map.scope` takes them in. A parent that moved in between
 * is held after the task, whose parent is fixed from then on.
 */
export async function withMapClient<
  Row extends { readonly client: string | null; readonly parent: string | null },
>(
  tx: TenantQuery,
  query: (lock: string) => string,
  parameters: readonly unknown[],
): Promise<{ readonly row: Row; readonly clientId: string | null } | undefined> {
  const holdMap = async (id: string | null): Promise<string | null> => {
    if (id === null) return null;
    const [map] = await tx.query<{ readonly client: string | null }>(HOLD_MAP, [tx.businessId, id]);
    return map?.client ?? null;
  };
  const [peek] = await tx.query<Row>(query(''), parameters);
  const parent = peek?.parent ?? null;
  const before = await holdMap(parent);
  const [row] = await tx.query<Row>(query('for share of t'), parameters);
  if (row === undefined) return undefined;
  const map = row.parent === parent ? before : await holdMap(row.parent);
  return { row, clientId: row.client ?? map };
}

/**
 * The task the conversation is scoped to (C60), held as the ticket path holds
 * its run's task, so a `task.set_party`, `task.reparent` or `map.scope` in
 * flight is waited on. A map is a task; a ticket's client is its own or its
 * map's (WF-6). No row, or no scope: no client.
 */
const scopedTask = (lock: string): string =>
  `select t.${slotOf(TASK_SPINE, 'client')}::text as client,
          t.${slotOf(TASK_SPINE, 'parent')}::text as parent
     from public.conversations c
     join public.records t on t.business_id = c.business_id and t.id = c.scope_record_id
    where c.business_id = $1 and c.id = $2
    ${lock}`;

async function scopedClient(tx: TenantQuery, conversationId: string): Promise<string | null> {
  const held = await withMapClient(tx, scopedTask, [tx.businessId, conversationId]);
  return held?.clientId ?? null;
}

/** The row, started: nothing held, the conversation and no task fact. */
async function insertStarted(
  tx: TenantQuery,
  conversationId: string,
  operation: ModelOperation,
  route: BrokerRoute,
): Promise<string> {
  const callId = randomUUID();
  await tx.query(
    `insert into public.model_calls
       (business_id, id, conversation_id, operation_key, state, reserved_minor,
        route_key, route_reach, credential_kind, started_at)
     values ($1, $2, $3, $4, 'dispatched', 0, $5, $6, $7, clock_timestamp())`,
    [
      tx.businessId,
      callId,
      conversationId,
      operation.key,
      route.key,
      route.reach,
      route.credentialKind,
    ],
  );
  await registerPromptCopy(tx, callId);
  return callId;
}

/** Through custody, then the answer settles at nothing or is held (never settled above nothing). */
async function sendAndSettle(
  database: Database,
  businessId: BusinessId,
  called: ReservedCall,
  fields: readonly ResolvedField[],
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId, operation, route } = called;
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
    if (settlement.kind === 'unknown') return await hold(tx, called, null, settlement, broker);
    if (settlement.kind === 'nothing') return await release(tx, called, settlement.reason, broker);
    if (settlement.costMinor !== 0) {
      const observed = Number.isSafeInteger(settlement.costMinor) ? settlement.costMinor : null;
      return await hold(tx, called, observed, null, broker);
    }
    await settlePriced(tx, called, settlement, broker);
    const { text } = settlement.answer;
    return { ok: true, callId, text, reservedMinor: 0, actualMinor: 0, releasedMinor: 0 };
  });
}

/**
 * A person's model call from their own conversation. Every check runs before
 * anything is written: the owner, the catalogue, the scoped task's client (a
 * client's material goes to no model, C60 and WF-6, before any route), a local
 * route (a cloud one is refused, AW-03 egress off), then AW-01's ceilings. The answer settles at
 * nothing; a priced answer is above a hold of nothing, so it is held as
 * unknown liability for a person, as any call above its hold is (O9).
 */
export async function callModelInConversation(
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
  const started = await database.withBusiness(businessId, async (tx) => {
    if ((await scopedClient(tx, request.conversation.id)) !== null) return 'CLIENT_MODEL_USE_OFF';
    if (!chosen.ok) return chosen.code;
    if (await atCeiling(tx, operation, chosen.route)) return 'RATE_LIMITED';
    const { route } = chosen;
    return { callId: await insertStarted(tx, request.conversation.id, operation, route), route };
  });
  if (started === 'RATE_LIMITED') {
    return { ok: false, code: 'RATE_LIMITED', callId: null, retryAfterSeconds: WAIT_SECONDS };
  }
  if (typeof started === 'string') return refused(started);
  return await sendAndSettle(
    database,
    businessId,
    { ...started, operation, reservedMinor: 0 },
    fields,
    broker,
  );
}
