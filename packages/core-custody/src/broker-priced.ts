// SPDX-License-Identifier: AGPL-3.0-only
//
// The conversation seam, split on price (#1508, option A). An unpriced call
// is `callModelUnpriced`, unchanged. A paid call takes the held path, and only
// through the carve-out (`carriesOutside`): every other priced operation is
// refused as option B refused it, before anything is written.
//
// The held path, in order:
// 1. Checks that write nothing: the owner, the route the carve-out admits, a
//    model of that provider's, the request built and within its size.
// 2. The hold, in one transaction under the cap's lock (`holdPriced`): the
//    message's call first, the ceiling, room for the most, the row.
// 3. The send, admitted again at the handoff: the call still `dispatched`, and
//    the caller's grants, session, conversation and page judged at one locked
//    instant in a transaction held open until custody has started. A carried
//    call is judged instead at its offer and its send (`carriage-origin.ts`),
//    its outside standing with them, and settles only through its fence.
// 4. The settle and the kept reply in one transaction, as the caller: a
//    settled paid call always has its reply. An answer from another model, an
//    unknown cost, a cost above the hold, or a reply that cannot be kept holds
//    the most; a call another writer ended moves no money and keeps nothing.

import { randomUUID } from 'node:crypto';
import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { openrouterModel, type ModelOperation } from '../../core-connectors/src/index.ts';
import { MALFORMED, WORKER_LOST } from './broker-fault.ts';
import {
  callModelUnpriced,
  localRoute,
  outsideFields,
  ownsConversation,
  refused,
} from './broker-conversation.ts';
import type { ConversationCallRequest } from './broker-conversation-types.ts';
import { holdPriced } from './broker-hold.ts';
import { sendingAccount } from './broker-carrier.ts';
import type { ReservedCall } from './broker-reserve.ts';
import { hold, release, settlementOf, settlePriced, type Settlement } from './broker-settle.ts';
import { carriesOutside } from './outside-carriage.ts';
import type { Admission, Admit } from './custody.ts';
import type {
  Broker,
  BrokerRoute,
  ModelCaller,
  ModelCallResult,
  PaidSeams,
  ResolvedField,
} from './broker-types.ts';

/** The states an answer may close, as `broker-settle.ts` has them. */
const ANSWERABLE: ReadonlySet<string> = new Set(['reserved', 'dispatched', 'liability_unknown']);

/** The outside route the carve-out admits for this call, if one does. */
function outsideRoute(
  businessId: BusinessId,
  caller: ModelCaller,
  operation: ModelOperation,
  fields: readonly ResolvedField[],
  paid: PaidSeams,
  broker: Broker,
): BrokerRoute | undefined {
  const call = {
    businessId,
    operation,
    caller,
    fieldNames: fields.map((field) => field.name),
    authors: paid.authors,
  };
  return broker.routes.find((route) => carriesOutside(broker, route, call));
}

/**
 * A person's model call from their own conversation: an unpriced one as
 * before; a priced one only on the held path, through the carve-out.
 */
export async function callModelInConversation(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ConversationCallRequest,
  broker: Broker,
): Promise<ModelCallResult> {
  const operation = broker.operations.get(request.operation);
  if (operation === undefined || operation.maximumMinor === 0) {
    return await callModelUnpriced(database, businessId, caller, request, broker);
  }
  if (!ownsConversation(businessId, caller, request, broker)) return refused('AUTHORITY_LOST');
  if (operation.nothingHappened === 'not_reconcilable') return refused('EFFECT_NOT_RECONCILABLE');
  const fields = outsideFields(request.fields);
  const { paid } = request;
  // Option B for every priced call the carve-out does not take.
  const route =
    paid === undefined
      ? undefined
      : outsideRoute(businessId, caller, operation, fields, paid, broker);
  if (route === undefined || paid === undefined) {
    const chosen = localRoute(operation, fields, caller, broker);
    return refused(chosen.ok ? 'BUDGET_UNAVAILABLE' : chosen.code);
  }
  // A paid model is the one the person picked, never a default (C7).
  if (openrouterModel(request.model) === undefined) return refused('LOCAL_MODEL_REQUIRED');
  return await heldCall(database, businessId, request, { operation, route, fields, paid }, broker);
}

interface Chosen {
  readonly operation: ModelOperation;
  readonly route: BrokerRoute;
  readonly fields: readonly ResolvedField[];
  readonly paid: PaidSeams;
}

async function heldCall(
  database: Database,
  businessId: BusinessId,
  request: ConversationCallRequest,
  chosen: Chosen,
  broker: Broker,
): Promise<ModelCallResult> {
  const { operation, route, fields, paid } = chosen;
  const adapter = broker.providers.get(operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${operation.provider}`);
  const callId = randomUUID();
  const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));
  const built = adapter.build(values, callId, request.model, false);
  if (adapter.bodyLimit !== undefined && Buffer.byteLength(built.body) > adapter.bodyLimit) {
    return refused('PROMPT_TOO_LARGE');
  }
  const account = await sendingAccount(broker, route, operation.destination);
  const held = await database.withBusiness(
    businessId,
    async (tx) =>
      await holdPriced(tx, request, operation, route, { account, carrier: broker.carrier }, callId),
  );
  if (!('reserved' in held)) return held;
  const { carrier } = broker;
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
    piecesOf(operation, request.onPiece),
    carrier === undefined ? admission(paid, callId) : undefined,
    carrier === undefined ? undefined : request.carry?.(callId),
  );
  const settlement = settlementOf(outcome, operation, adapter);
  const asked = { reserved: held.reserved, settlement, model: request.model, broker };
  // Kept as the caller; one who can no longer be keeps nothing, and the money is judged alone.
  return (
    (await paid.asCaller(async (tx, as) => await settleAndKeep(tx, asked, as.keep))) ??
    (await database.withBusiness(businessId, async (tx) => await settleAndKeep(tx, asked)))
  );
}

/** A promise and the function that settles it. */
function opened<T>(): { readonly promise: Promise<T>; readonly settle: (value: T) => void } {
  const box: { settle?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    box.settle = resolve;
  });
  return { promise, settle: (value) => box.settle?.(value) };
}

/**
 * Custody's display texts for the person, as the operation reads them; none
 * where the caller takes none or the operation streams nothing. Provisional:
 * only the settled answer is kept.
 */
function piecesOf(
  operation: ModelOperation,
  onPiece: ((text: string) => void) | undefined,
): ((chunk: string) => void) | undefined {
  const reader = onPiece === undefined ? undefined : operation.pieces?.();
  if (reader === undefined || onPiece === undefined) return undefined;
  return (chunk) => {
    for (const text of reader.push(chunk)) onPiece(text);
  };
}

/**
 * The judgement at the handoff, in the caller's transaction: the call still
 * `dispatched` under its own lock (a swept call is never sent), then what the
 * send rests on. Admitted, the transaction stays open; at custody's `started`
 * it answers one statement more before custody sends (`go`), so a change to
 * any of it waits for the send, and a transaction lost since the verdict sends
 * nothing. Anything else, including a lock held elsewhere, admits nothing.
 */
function admission(paid: PaidSeams, callId: string): Admit {
  return async () => {
    const verdict = opened<Admission | undefined>();
    const step = opened<boolean>();
    const held = opened<boolean>();
    const admitted: Admission = {
      go: async () => {
        step.settle(true);
        return await held.promise;
      },
      end: () => step.settle(false),
    };
    const lost = (): void => {
      verdict.settle(undefined);
      held.settle(false);
    };
    void paid
      .asCaller(async (tx, as) => {
        if (!((await stillDispatched(tx, callId)) && (await as.stillAdmitted()))) return;
        verdict.settle(admitted);
        if (!(await step.promise)) return;
        await tx.query('select 1');
        held.settle(true);
      })
      .then(lost, lost);
    return await verdict.promise;
  };
}

async function stillDispatched(tx: TenantQuery, callId: string): Promise<boolean> {
  const [call] = await tx.query<{ readonly state: string }>(
    'select state from public.model_calls where business_id = $1 and id = $2 for update',
    [tx.businessId, callId],
  );
  return call?.state === 'dispatched';
}

interface Asked {
  readonly reserved: ReservedCall;
  readonly settlement: Settlement;
  readonly model: string | undefined;
  readonly broker: Broker;
}

/** The answer came from a model the asked one may be named as, so another model's answer is never kept. */
const fromAsked = (model: string | undefined, answered: string | null): boolean =>
  answered !== null && (openrouterModel(model)?.acceptedIds.includes(answered) ?? false);

/** Held as the provider's answer, named in the call's provider code (0110's shape). */
const MISMATCH = { kind: 'unknown', ...MALFORMED, providerCode: 'model_mismatch' } as const;

/**
 * The settle and the kept reply, one transaction under the call's lock: both
 * or neither. A paid call settles only at a whole cost within its hold, from
 * the model asked, with its reply kept; anything else is released on proof
 * that nothing happened, or holds the most.
 */
async function settleAndKeep(
  tx: TenantQuery,
  asked: Asked,
  keep?: (text: string) => Promise<boolean>,
): Promise<ModelCallResult> {
  const { reserved, settlement, model, broker } = asked;
  const [call] = await tx.query<{ readonly state: string }>(
    'select state from public.model_calls where business_id = $1 and id = $2 for update',
    [tx.businessId, reserved.callId],
  );
  if (call === undefined || !ANSWERABLE.has(call.state)) return await settleLost(tx, asked);
  if (settlement.kind === 'unknown') return await hold(tx, reserved, null, settlement, broker);
  if (settlement.kind === 'nothing') return await release(tx, reserved, settlement.reason, broker);
  const { costMinor, answer } = settlement;
  const observed = Number.isSafeInteger(costMinor) ? costMinor : null;
  if (observed === null || observed < 0 || observed > reserved.reservedMinor) {
    return await hold(tx, reserved, observed, null, broker);
  }
  if (!fromAsked(model, answer.model)) return await hold(tx, reserved, observed, MISMATCH, broker);
  // A carried call settles only through its fence: the runner sent to, before its `answer_by`.
  const { custody } = broker;
  if (custody.fenceIn !== undefined && !(await custody.fenceIn(tx, reserved.callId))) {
    // Already held by the sweep: the most stays held, and the cost it reported is still recorded.
    if (call.state === 'liability_unknown') return await settleLost(tx, asked);
    return await hold(tx, reserved, observed, { kind: 'unknown', ...WORKER_LOST }, broker);
  }
  if (keep === undefined || !(await keep(answer.text))) {
    return await hold(tx, reserved, observed, null, broker);
  }
  await settlePriced(tx, reserved, settlement, broker);
  return {
    ok: true,
    callId: reserved.callId,
    text: answer.text,
    reservedMinor: reserved.reservedMinor,
    actualMinor: observed,
    releasedMinor: reserved.reservedMinor - observed,
  };
}

/** A call another writer ended first: no money moves, nothing is kept, and the loss is recorded. */
async function settleLost(tx: TenantQuery, asked: Asked): Promise<ModelCallResult> {
  const { reserved, settlement, broker } = asked;
  const observedMinor = settlement.kind === 'priced' ? settlement.costMinor : null;
  await broker.audit(tx, {
    action: 'model.call_settle_lost',
    outcome: 'refused',
    refusalCode: 'DECISION_STALE',
    detail: { callId: reserved.callId, operation: reserved.operation.key, observedMinor },
  });
  return { ok: false, code: 'DECISION_STALE', callId: reserved.callId };
}
