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
import { sendingCarrier } from './broker-carrier.ts';
import {
  atCeiling,
  registerPromptCopy,
  WAIT_SECONDS,
  type ReservedCall,
} from './broker-reserve.ts';
import { hold, release, settlementOf, settlePriced, type Settlement } from './broker-settle.ts';
import { carriedIn, writeCarriers } from './broker-carriage.ts';
import type {
  Broker,
  BrokerRefusal,
  BrokerRoute,
  Carrier,
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
   * Where the answer's display text goes as it is written, for an operation
   * that streams (`pieces`). Provisional: only the settled answer is kept.
   */
  readonly onPiece?: (text: string) => void;
  /** The person's message the call answers: one message has at most one call (#1531). */
  readonly messageId?: string;
}

export const refused = (code: BrokerRefusal): ModelCallResult => ({
  ok: false,
  code,
  callId: null,
});

const RATE_LIMITED: ModelCallResult = {
  ok: false,
  code: 'RATE_LIMITED',
  callId: null,
  retryAfterSeconds: WAIT_SECONDS,
};

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

/**
 * The message's call, if one was made: a retry is answered from it, never a
 * second call (#1531). A kept reply is found before the broker is asked. A
 * call still with the model, or settled with its reply kept or being kept, is
 * on its way; any other ending kept nothing.
 */
async function messageCall(
  tx: TenantQuery,
  messageId: string | undefined,
): Promise<ModelCallResult | undefined> {
  if (messageId === undefined) return undefined;
  const [call] = await tx.query<{
    readonly id: string;
    readonly conversation_id: string;
    readonly state: string;
    readonly recent: boolean;
  }>(
    `select id, conversation_id, state,
            ended_at > clock_timestamp() - interval '30 seconds' as recent
       from public.model_calls
      where business_id = $1 and conversation_message_id = $2`,
    [tx.businessId, messageId],
  );
  if (call === undefined) return undefined;
  const answering =
    call.state === 'dispatched' ||
    (call.state === 'settled' &&
      (call.recent || (await replyLanded(tx, call.conversation_id, messageId))));
  return { ok: false, code: answering ? 'STILL_ANSWERING' : 'ANSWER_ENDED', callId: call.id };
}

/**
 * A settled call's reply, kept now or by a keep queued on the conversation:
 * its row is taken as the keep takes it, so a keep waiting there commits
 * first, and the reply is read after the wait. A keep in its first 30 s may
 * not have asked for the row yet; `messageCall` counts those as on their way.
 */
async function replyLanded(
  tx: TenantQuery,
  conversationId: string,
  messageId: string,
): Promise<boolean> {
  await tx.query(
    `select 1 from public.conversations where business_id = $1 and id = $2 for update`,
    [tx.businessId, conversationId],
  );
  const kept = await tx.query(
    `select 1 from public.conversation_messages
      where business_id = $1 and conversation_id = $2 and answers_message_id = $3`,
    [tx.businessId, conversationId, messageId],
  );
  return kept.length > 0;
}

/**
 * The row, started: nothing held, the conversation and its message, no task
 * fact. A message that has a call already gets none (the unique index decides
 * a race), and undefined comes back. A carried deployment's call is written
 * with its carriers row, naming the agent.
 */
async function insertStarted(
  tx: TenantQuery,
  request: ConversationCallRequest,
  operation: ModelOperation,
  route: BrokerRoute,
  account: string | null,
  carrier: Carrier | undefined,
): Promise<string | undefined> {
  const callId = randomUUID();
  const inserted = await tx.query(
    `insert into public.model_calls
       (business_id, id, conversation_id, conversation_message_id, operation_key, state,
        reserved_minor, route_key, route_reach, credential_kind, provider, credential_ref, account,
        started_at)
     values ($1, $2, $3, $4, $5, 'dispatched', 0, $6, $7, $8, $9, $10, $11, clock_timestamp())
     on conflict (business_id, conversation_message_id) where conversation_message_id is not null
     do nothing
     returning id`,
    [
      tx.businessId,
      callId,
      request.conversation.id,
      request.messageId ?? null,
      operation.key,
      route.key,
      route.reach,
      route.credentialKind,
      route.provider,
      route.credentialRef,
      account,
    ],
  );
  if (inserted.length === 0) return undefined;
  await registerPromptCopy(tx, callId);
  if (carrier !== undefined) await writeCarriers(tx, callId, carrier);
  return callId;
}

/** Through custody, then the answer settles at nothing or is held (never settled above nothing). */
async function sendAndSettle(
  database: Database,
  businessId: BusinessId,
  called: ReservedCall,
  fields: readonly ResolvedField[],
  broker: Broker,
  asked: Pick<ConversationCallRequest, 'model' | 'onPiece'> & { readonly streamed: boolean },
): Promise<ModelCallResult> {
  const { callId, operation, route } = called;
  const { model, onPiece, streamed } = asked;
  const adapter = broker.providers.get(operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${operation.provider}`);
  const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));
  // AW-10: the call names itself to the provider, so a lookup can ask about it.
  const built = adapter.build(values, callId, model, streamed);
  const reader = onPiece === undefined || !streamed ? undefined : operation.pieces?.();
  const outcome = await broker.custody.dispatch(
    route.credentialRef,
    {
      destination: operation.destination,
      path: built.path,
      method: built.method,
      body: built.body,
      timeoutMs: operation.timeoutMs,
      maxResponseBytes: operation.maxResponseBytes,
    },
    reader === undefined || onPiece === undefined
      ? undefined
      : (chunk) => {
          for (const text of reader.push(chunk)) onPiece(text);
        },
  );
  const settlement = settlementOf(outcome, operation, adapter, streamed);
  return await database.withBusiness(
    businessId,
    async (tx) => await settledFor(tx, called, settlement, broker),
  );
}

/**
 * Custody's outcome for the person waiting on it: held, released, or settled
 * at nothing. Only a call still open settles: one the sweep held, or anything
 * else moved, is no success and keeps no answer.
 */
async function settledFor(
  tx: TenantQuery,
  called: ReservedCall,
  settlement: Settlement,
  broker: Broker,
): Promise<ModelCallResult> {
  const { callId } = called;
  if (settlement.kind === 'unknown') return await hold(tx, called, null, settlement, broker);
  if (settlement.kind === 'nothing') return await release(tx, called, settlement.reason, broker);
  if (settlement.costMinor !== 0) {
    const observed = Number.isSafeInteger(settlement.costMinor) ? settlement.costMinor : null;
    return await hold(tx, called, observed, null, broker);
  }
  const [call] = await tx.query<{ readonly state: string }>(
    'select state from public.model_calls where business_id = $1 and id = $2 for update',
    [tx.businessId, callId],
  );
  if (call?.state !== 'dispatched' || !(await settlePriced(tx, called, settlement, broker))) {
    return { ok: false, code: 'DECISION_STALE', callId };
  }
  const { text } = settlement.answer;
  return { ok: true, callId, text, reservedMinor: 0, actualMinor: 0, releasedMinor: 0 };
}

/**
 * A person's model call from their own conversation. Every check runs before
 * anything is written: the owner, the catalogue, a local route (a cloud one is
 * refused, AW-03 egress off), an unpriced operation (#1508, option B: a priced
 * one is refused), then AW-01's ceilings. The answer settles at
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
  // #1508, option B: this seam holds nothing, so it sends only an unpriced operation.
  if (operation.maximumMinor > 0) return refused('BUDGET_UNAVAILABLE');
  const { route } = chosen;
  const { account, presentsNothing } = await sendingCarrier(broker, route, operation.destination);
  // Streamed only where custody sends no credential the answer could echo.
  const streamed = presentsNothing && operation.fold !== undefined;
  const started = await database.withBusiness(
    businessId,
    async (tx): Promise<string | ModelCallResult> => {
      const earlier = await messageCall(tx, request.messageId);
      if (earlier !== undefined) return earlier;
      // The ceiling's lock waits out a twin asking at this moment; its call is read after it.
      if (await atCeiling(tx, operation, route)) {
        return (await messageCall(tx, request.messageId)) ?? RATE_LIMITED;
      }
      const { carrier } = broker;
      if (carrier !== undefined && !(await carriedIn(tx, request.conversation.id, carrier))) {
        return refused('CARRIAGE_UNAVAILABLE');
      }
      return (
        (await insertStarted(tx, request, operation, route, account, carrier)) ??
        (await messageCall(tx, request.messageId)) ??
        RATE_LIMITED
      );
    },
  );
  if (typeof started !== 'string') return started;
  const callId = started;
  return await sendAndSettle(
    database,
    businessId,
    { callId, operation, route, reservedMinor: 0 },
    fields,
    broker,
    { ...request, streamed },
  );
}
