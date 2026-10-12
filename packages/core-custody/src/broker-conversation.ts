// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's conversation seam (ORCH35, option a): a person's model call from
// their own conversation, which has no task lease, run, step or approved
// version. Local routes only and unpriced: no money moves, so nothing is
// reserved, and a cloud route is refused before anything is written (AW-03
// egress off), save LA-1's laptop carve-out: the owner's own GPT session
// (`carriesLocally`), for the owner's own typed message. A priced planning reply takes the same checks and holds
// against the planning budget (`broker-planning.ts`, AW-04's U10).

import { randomUUID } from 'node:crypto';
import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { eligibleRoutes, type ModelOperation } from '../../core-connectors/src/index.ts';
import { carriesLocally, mayCarry } from './credentials.ts';
import { sendingAccount } from './broker-carrier.ts';
import { endBy } from './custody.ts';
import {
  atCeiling,
  registerPromptCopy,
  WAIT_SECONDS,
  type ReservedCall,
} from './broker-reserve.ts';
import { closed, hold, release, settlementOf, settlePriced } from './broker-settle.ts';
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
  /** The conversation's model (CS-7.30), checked as offered by the command layer; absent, the default. */
  readonly model?: string;
  /**
   * The caller's authority judged again in the transaction that writes the
   * call's row, before any of the broker's locks: false refuses the call with
   * nothing written or sent. The command layer's, for what it checked earlier.
   */
  readonly stillHeld?: (tx: TenantQuery) => Promise<boolean>;
}

/**
 * How long a started conversation call counts as in flight under its route's ceiling before
 * the sweep holds it (`sweepModelCalls`): five times the longest wait custody allows (120 s).
 * Custody ends the call before then (`endBy`), so a call that waited past it is never sent.
 */
export const CONVERSATION_CALL_LIFE_MS: number = 10 * 60_000;

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
  // LA-1's laptop carve-out: the owner's GPT session is a cloud route, taken here only for
  // the person's own typed message in their own conversation, and only where the broker
  // carries the carve-out (`carriesLocally`). Every other cloud route stays refused.
  const local = broker.routes.filter(
    (route) =>
      (route.reach === 'local' || carriesLocally(broker, route)) &&
      route.provider === operation.provider,
  );
  // The carve-out's route counts as local for the data classes, and is recorded as admitted:
  // the conversation row's reach is `local` by AW-03's own constraint (0107), and its
  // provider `local_gpt` says the answer came from the owner's GPT session.
  const candidates = local.map((route): BrokerRoute =>
    carriesLocally(broker, route) ? Object.assign({}, route, { reach: 'local' as const }) : route,
  );
  const choice = eligibleRoutes(operation.fields, fields, candidates);
  const route = choice.ok
    ? candidates.find((candidate) => choice.routes.includes(candidate))
    : undefined;
  if (route === undefined) return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  const carry = mayCarry(route.credentialKind, {
    unattended: false,
    sessionPersonId: caller.attendedByPersonId,
    workForPersonId: caller.attendedByPersonId,
    tenantInstallation: broker.installation,
    credentialInstallation: route.installation,
    localOwnerTesting: carriesLocally(broker, route),
  });
  return carry.ok ? { ok: true, route } : { ok: false, code: carry.code };
}

/** The row, started: nothing held, the conversation and no task fact. */
async function insertStarted(
  tx: TenantQuery,
  conversationId: string,
  operation: ModelOperation,
  route: BrokerRoute,
  account: string | null,
): Promise<string> {
  const callId = randomUUID();
  await tx.query(
    `insert into public.model_calls
       (business_id, id, conversation_id, operation_key, state, reserved_minor,
        route_key, route_reach, credential_kind, provider, credential_ref, account, started_at)
     values ($1, $2, $3, $4, 'dispatched', 0, $5, $6, $7, $8, $9, $10, clock_timestamp())`,
    [
      tx.businessId,
      callId,
      conversationId,
      operation.key,
      route.key,
      route.reach,
      route.credentialKind,
      route.provider,
      route.credentialRef,
      account,
    ],
  );
  await registerPromptCopy(tx, callId);
  return callId;
}

/**
 * Through custody, then the answer settles at its price within the hold (nothing, on the
 * conversation seam; the planning reply's maximum, `broker-planning.ts`), is released on proof
 * nothing happened, or is held for a person.
 */
export async function sendAndSettle(
  database: Database,
  businessId: BusinessId,
  called: ReservedCall,
  fields: readonly ResolvedField[],
  broker: Broker,
  sent: { readonly model: string | undefined; readonly notAfter: number },
): Promise<ModelCallResult> {
  const { callId, operation, route, reservedMinor } = called;
  const adapter = broker.providers.get(operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${operation.provider}`);
  const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));
  // AW-10: the call names itself to the provider, so a lookup can ask about it.
  const built = adapter.build(values, callId, sent.model);
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
    notAfter: sent.notAfter,
  });
  const settlement = settlementOf(outcome, operation, adapter);
  return await database.withBusiness(businessId, async (tx) => {
    if (settlement.kind === 'unknown') return await hold(tx, called, null, settlement, broker);
    if (settlement.kind === 'nothing') return await release(tx, called, settlement.reason, broker);
    const { costMinor } = settlement;
    if (!Number.isSafeInteger(costMinor) || costMinor < 0 || costMinor > reservedMinor) {
      const observed = Number.isSafeInteger(costMinor) ? costMinor : null;
      return await hold(tx, called, observed, null, broker);
    }
    if (!(await settlePriced(tx, called, settlement, broker))) return closed(callId);
    const { text } = settlement.answer;
    const releasedMinor = reservedMinor - costMinor;
    return { ok: true, callId, text, reservedMinor, actualMinor: costMinor, releasedMinor };
  });
}

/**
 * A person's model call from their own conversation. Every check runs before
 * anything is written: the owner, the catalogue, a local route (a cloud one is
 * refused, AW-03 egress off), then AW-01's ceilings. The answer settles at
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
  if (!chosen.ok) return refused(chosen.code);
  const { route } = chosen;
  const account = await sendingAccount(broker, route, operation.destination);
  const notAfter = endBy(Date.now(), CONVERSATION_CALL_LIFE_MS);
  const callId = await database.withBusiness(businessId, async (tx) => {
    if (request.stillHeld !== undefined && !(await request.stillHeld(tx))) return 'lost';
    return (await atCeiling(tx, operation, route))
      ? null
      : await insertStarted(tx, request.conversation.id, operation, route, account);
  });
  if (callId === 'lost') return refused('AUTHORITY_LOST');
  if (callId === null) {
    return { ok: false, code: 'RATE_LIMITED', callId: null, retryAfterSeconds: WAIT_SECONDS };
  }
  return await sendAndSettle(
    database,
    businessId,
    { callId, operation, route, reservedMinor: 0 },
    fields,
    broker,
    { model: request.model, notAfter },
  );
}
