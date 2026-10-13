// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's conversation seam (ORCH35, option a): a person's model call from
// their own conversation, which has no task lease, run, step or approved
// version. Local routes only and unpriced: no money moves, so nothing is
// reserved, and a cloud route is refused before anything is written (AW-03
// egress off), save LA-1's laptop carve-out: the owner's own GPT session
// (`carriesLocally`), a cloud subscription judged by owner line 72's source
// rule (`broker-conversation-source.ts`). A priced planning reply takes the
// same checks and holds against the planning budget (`broker-planning.ts`, AW-04's U10), and a paid
// chat reply takes the held path (`broker-priced.ts`, #1508).

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import { eligibleRoutes, type ModelOperation } from '../../core-connectors/src/index.ts';
import { carriesLocally, mayCarry } from './credentials.ts';
import { sendingCarrier } from './broker-carrier.ts';
import { atCeiling, WAIT_SECONDS } from './broker-reserve.ts';
import { sendAndSettle } from './broker-conversation-send.ts';
import { carriedIn } from './broker-carriage.ts';
import { insertStarted, messageCall } from './broker-message-call.ts';
import { conversationSource, judgedFields } from './broker-conversation-source.ts';
import { conversationAdmitFor } from './broker-admission.ts';
import type {
  Broker,
  BrokerRefusal,
  BrokerRoute,
  ClaimedField,
  ModelCaller,
  ModelCallResult,
  ResolvedField,
} from './broker-types.ts';
import type { ConversationCallRequest } from './broker-conversation-types.ts';

export const refused = (code: BrokerRefusal): ModelCallResult => ({
  ok: false,
  code,
  callId: null,
});

export const RATE_LIMITED: ModelCallResult = {
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

/**
 * The request's fields as the broker acts on them, judged by the
 * conversation's source (owner line 72, `broker-conversation-source.ts`), and
 * whether it is a client's work. Read in a transaction of its own before any
 * route is chosen; the command layer's held page check refuses a client link
 * that lands after it.
 */
export async function judged(
  database: Database,
  businessId: BusinessId,
  request: ConversationCallRequest,
): Promise<{ readonly fields: readonly ResolvedField[]; readonly clientWork: boolean }> {
  const source = await database.withBusiness(
    businessId,
    async (tx) => await conversationSource(tx, request),
  );
  return { fields: judgedFields(request.fields, source), clientWork: source.clientWork };
}

/** A route the fields may take and the person's own session may carry, or why not. */
export function localRoute(
  operation: ModelOperation,
  fields: readonly ResolvedField[],
  caller: ModelCaller,
  broker: Broker,
  clientWork: boolean,
):
  | { readonly ok: true; readonly route: BrokerRoute }
  | { readonly ok: false; readonly code: BrokerRefusal } {
  // LA-1's laptop carve-out: the owner's GPT session is a cloud route carried by a
  // subscription, offered here only where the broker carries the carve-out
  // (`carriesLocally`). It is judged as the cloud route it is (owner line 72): it
  // takes the owner's own free text and never a client's work. Every other cloud
  // route stays refused.
  const candidates = broker.routes.filter(
    (route) =>
      (route.reach === 'local' || carriesLocally(broker, route)) &&
      route.provider === operation.provider,
  );
  if (clientWork && candidates.some((route) => route.credentialKind === 'subscription')) {
    return { ok: false, code: 'SUBSCRIPTION_NOT_FOR_CLIENT_WORK' };
  }
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
    clientWork,
  });
  return carry.ok ? { ok: true, route } : { ok: false, code: carry.code };
}

/**
 * A person's unpriced model call from their own conversation, streamed only where
 * custody presents no credential the answer could echo (`sendingCarrier`). Every check runs before
 * anything is written: the owner, the catalogue, a local route (a cloud one is
 * refused, AW-03 egress off), an unpriced operation (#1508, option B: a priced
 * one is refused), then AW-01's ceilings. The answer settles at
 * nothing; a priced answer is above a hold of nothing, so it is held as
 * unknown liability for a person, as any call above its hold is (O9).
 */
export async function callModelUnpriced(
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
  const { fields, clientWork } = await judged(database, businessId, request);
  const chosen = localRoute(operation, fields, caller, broker, clientWork);
  if (!chosen.ok) return refused(chosen.code);
  // #1508, option B: this seam holds nothing, so it sends only an unpriced operation.
  if (operation.maximumMinor > 0) return refused('BUDGET_UNAVAILABLE');
  const { route } = chosen;
  const { account, presentsNothing } = await sendingCarrier(broker, route, operation.destination);
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
    { ...request, streamed, admit: conversationAdmitFor(database, businessId, request, route) },
  );
}
