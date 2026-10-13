// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's conversation seam (ORCH35, option a): a person's model call from
// their own conversation, which has no task lease, run, step or approved
// version. Local routes only and unpriced: no money moves, so nothing is
// reserved, and a cloud route is refused before anything is written (AW-03
// egress off), save LA-1's laptop carve-out: the owner's own GPT session
// (`carriesLocally`), for the owner's own typed message. A priced planning reply takes the same checks and holds
// against the planning budget (`broker-planning.ts`, AW-04's U10).

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { eligibleRoutes, type ModelOperation } from '../../core-connectors/src/index.ts';
import { carriesLocally, mayCarry } from './credentials.ts';
import { sendingCarrier } from './broker-carrier.ts';
import { atCeiling, WAIT_SECONDS, type ReservedCall } from './broker-reserve.ts';
import { hold, release, settlementOf, settlePriced, type Settlement } from './broker-settle.ts';
import { carriedIn } from './broker-carriage.ts';
import type { ConversationCallRequest } from './broker-conversation-types.ts';
import { insertStarted, messageCall } from './broker-message-call.ts';
import type {
  Broker,
  BrokerRefusal,
  BrokerRoute,
  ClaimedField,
  ModelCaller,
  ModelCallResult,
  ResolvedField,
} from './broker-types.ts';

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
  return await sendAndSettle(
    database,
    businessId,
    { callId: started, operation, route, reservedMinor: 0 },
    fields,
    broker,
    { ...request, streamed },
  );
}
