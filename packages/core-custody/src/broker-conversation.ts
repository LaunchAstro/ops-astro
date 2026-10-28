// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's conversation seam (ORCH35, option a): a person's model call from
// their own conversation, which has no task lease, run, step or approved
// version. Local routes only and unpriced: no money moves, so nothing is
// reserved, and a cloud route is refused before anything is written (AW-03
// egress off), save LA-1's laptop carve-out: the owner's own GPT session
// (`carriesLocally`), for the owner's own typed message, and the owner's
// ChatGPT plan for his own typed message, judged again under the locks
// before the call is written (#2175, `broker-conversation-plan.ts`). A priced planning reply takes the same checks and holds
// against the planning budget (`broker-planning.ts`, AW-04's U10), and a paid
// chat reply takes the held path (`broker-priced.ts`, #1508).

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { eligibleRoutes, type ModelOperation } from '../../core-connectors/src/index.ts';
import { carriesLocally, carriesOnPlan, mayCarry } from './carry-rule.ts';
import { planHolds, planRoute } from './broker-conversation-plan.ts';
import { HERMES_PROVIDER_KEY, hermesStanding } from './hermes-standing.ts';
import { sendingCarrier } from './broker-carrier.ts';
import { atCeiling, WAIT_SECONDS } from './broker-reserve.ts';
import { oversized } from './broker-size.ts';
import { sendAndSettle } from './broker-conversation-send.ts';
import { carriedIn } from './broker-carriage.ts';
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

/**
 * Only the owner, in their own session, with no delegation between them and the call;
 * Hermes Agent's operation only for a person its list names (#2270), whatever the
 * command layer offered.
 */
export function ownsConversation(
  businessId: BusinessId,
  caller: ModelCaller,
  { conversation, operation }: ConversationCallRequest,
  broker: Pick<Broker, 'operations' | 'hermesPeople'>,
): boolean {
  const hermes = broker.operations.get(operation)?.provider === HERMES_PROVIDER_KEY;
  return (
    conversation.businessId === businessId &&
    caller.delegationId === null &&
    caller.attendedByPersonId !== null &&
    caller.attendedByPersonId === conversation.ownerPersonId &&
    (!hermes || hermesStanding(broker, businessId, caller))
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
    // A typed message is no run the owner started: the plan's route refuses it.
    planRoute: carriesOnPlan(route),
  });
  return carry.ok ? { ok: true, route } : { ok: false, code: carry.code };
}

/**
 * The route and the fields as the broker found them: the owner's plan for his
 * own typed message only, as owner work (#2175); anything else a local route.
 */
function routeFor(
  operation: ModelOperation,
  request: ConversationCallRequest,
  caller: ModelCaller,
  broker: Broker,
):
  | { readonly ok: true; readonly route: BrokerRoute; readonly fields: readonly ResolvedField[] }
  | { readonly ok: false; readonly code: BrokerRefusal } {
  if (carriesOnPlan(operation)) {
    return planRoute(operation, request.fields, caller, broker, request.plan);
  }
  const fields = outsideFields(request.fields);
  const chosen = localRoute(operation, fields, caller, broker);
  return chosen.ok ? { ...chosen, fields } : chosen;
}

/** A twin's call for the message, or a plan call's standing lost under its locks (#2175). */
async function earlierOrLost(
  tx: TenantQuery,
  request: ConversationCallRequest,
  caller: ModelCaller,
  operation: ModelOperation,
): Promise<ModelCallResult | undefined> {
  const earlier = await messageCall(tx, request.messageId);
  if (earlier !== undefined || !carriesOnPlan(operation) || request.plan === undefined) {
    return earlier;
  }
  const lost = await planHolds(tx, caller.attendedByPersonId, request.plan);
  return lost === undefined ? undefined : refused(lost);
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
  if (!ownsConversation(businessId, caller, request, broker)) return refused('AUTHORITY_LOST');
  const operation = broker.operations.get(request.operation);
  if (operation === undefined) return refused('OPERATION_NOT_CATALOGUED');
  if (operation.nothingHappened === 'not_reconcilable') return refused('EFFECT_NOT_RECONCILABLE');
  const chosen = routeFor(operation, request, caller, broker);
  if (!chosen.ok) return refused(chosen.code);
  const { fields } = chosen;
  // #1508, option B: this seam holds nothing, so it sends only an unpriced operation.
  if (operation.maximumMinor > 0) return refused('BUDGET_UNAVAILABLE');
  // Sized against its adapter's limit (Hermes Agent's) before any row or send.
  if (oversized(broker, operation, fields, request.model)) return refused('PROMPT_TOO_LARGE');
  const { route } = chosen;
  const { account, presentsNothing } = await sendingCarrier(broker, route, operation.destination);
  const streamed = presentsNothing && operation.fold !== undefined;
  const started = await database.withBusiness(
    businessId,
    async (tx): Promise<string | ModelCallResult> => {
      const earlier = await earlierOrLost(tx, request, caller, operation);
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
