// SPDX-License-Identifier: AGPL-3.0-only
//
// Step 1 of a model call (AW-01): the hold, or a refusal recorded as a step.

import { randomUUID } from 'node:crypto';
import {
  advisoryLock,
  hasRoom,
  refuseCommand,
  type CommandRefusal,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import {
  eligibleRoutes,
  LOCAL_MODEL_REQUIRED_WORDS,
  type ModelOperation,
} from '../../core-connectors/src/index.ts';
import { carriesLocally, carriesOnPlan, mayCarry } from './carry-rule.ts';
import { HERMES_PROVIDER_KEY } from './hermes-standing.ts';
import { registerPromptCopy } from './broker-copy.ts';
import { heldUnknown } from './broker-holds.ts';
import { committedMinor, lockFacts, type Facts } from './broker-facts.ts';
import { clientRefusal } from './broker-sources.ts';
import { placeOf, type Place } from './broker-limit.ts';
import { fieldsOf } from './broker-turn.ts';
import { oversized } from './broker-size.ts';
import { endCodeOfRefusal, retireAttempt } from './broker-stop.ts';
import { stopAtCeiling } from './broker-wait.ts';
import type {
  Broker,
  BrokerRefusal,
  BrokerRoute,
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
  ResolvedField,
} from './broker-types.ts';

export const WAIT_SECONDS = 5;

export { promptCopyRegistered, registerPromptCopy } from './broker-copy.ts';

async function recordRefusal(
  tx: TenantQuery,
  facts: Facts,
  operationKey: string,
  code: BrokerRefusal,
  broker: Broker,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.model_calls (${CALL_COLUMNS}, operation_key, state, reserved_minor,
        refusal_code, ended_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'refused', 0, $11, clock_timestamp())`,
    [tx.businessId, id, ...callFacts(facts), operationKey, code],
  );
  await broker.audit(tx, {
    action: 'model.call_refused',
    outcome: 'refused',
    refusalCode: code,
    detail: { callId: id, operation: operationKey, code },
  });
  return id;
}

/** A held call, not yet sent: what the reserving transaction hands the send. */
export interface ReservedCall {
  readonly callId: string;
  readonly operation: ModelOperation;
  readonly route: BrokerRoute;
  readonly reservedMinor: number;
}

/**
 * A reserve refusal carries the register's shape, made where the broker
 * decides, so the command layer answers with it unchanged.
 */
export type ReserveRefusal = Extract<ModelCallResult, { code: BrokerRefusal }> & {
  readonly refusal: CommandRefusal;
};

export type Reservation = { readonly ok: true; readonly reserved: ReservedCall } | ReserveRefusal;

const FIXES: Partial<Record<BrokerRefusal, readonly string[]>> = {
  RATE_LIMITED: ["The operation's ceiling was reached, so the run stopped here."],
  BUDGET_UNAVAILABLE: ["The run's reservation has no room for this call's priced maximum."],
  OPERATION_NOT_CATALOGUED: ['Name an operation the broker has registered.'],
  EFFECT_NOT_RECONCILABLE: [
    'An operation with no proof that nothing happened is never dispatched.',
  ],
  CLIENT_MODEL_USE_OFF: [
    "Model use is off for this task's client: its work reaches no model, local or cloud.",
    'Personal information stays out of cloud AI until a local model exists.',
  ],
  SOURCE_UNREADABLE: [
    "A bound field's row could not be read: bind it to a live task of this business, and a key it holds as text.",
  ],
};

/** The refusal in the register's words: the plain words, the wait, then the fix. */
function refusing(
  code: BrokerRefusal,
  callId: string | null,
  said: { readonly words?: string; readonly retryAfterSeconds?: number } = {},
): ReserveRefusal {
  const fixes = [
    ...(said.words === undefined ? [] : [said.words]),
    ...(said.retryAfterSeconds === undefined
      ? []
      : [`Wait ${String(said.retryAfterSeconds)} seconds.`]),
    ...(FIXES[code] ?? []),
  ];
  return { ok: false, code, callId, ...said, refusal: refuseCommand(code, ['model.call'], fixes) };
}

/**
 * Step 1 in the caller's transaction, so the command layer commits the hold, the copy
 * registration and its own register row as one: a repeat of the operation finds the row, and
 * two at once cannot both hold. A refusal with a `callId` wrote its step; one without wrote nothing.
 */
export async function reserveModelCall(
  tx: TenantQuery,
  caller: ModelCaller,
  request: ModelCallRequest,
  broker: Broker,
): Promise<Reservation> {
  const checked = await lockFacts(tx, caller, request);
  if (!checked.ok) return refusing(checked.code, null);
  const { facts } = checked;
  const operation = broker.operations.get(request.operation);
  // #1623 R1: a recorded refusal is definitive. It ends the attempt here, with its code;
  // the budget stop's one transition (`stopAtBudget`) records its own.
  const refused = async (code: BrokerRefusal, words?: string): Promise<ReserveRefusal> => {
    const callId = await recordRefusal(tx, facts, request.operation, code, broker);
    if (code !== 'BUDGET_UNAVAILABLE') await retireAttempt(tx, facts, endCodeOfRefusal(code));
    return refusing(code, callId, words === undefined ? {} : { words });
  };
  if (await heldUnknown(tx, facts.reservationId)) return await refused('LIABILITY_UNKNOWN');
  // #2270: Hermes Agent answers a listed person's own conversation only, never a run.
  if (operation === undefined || operation.provider === HERMES_PROVIDER_KEY)
    return await refused('OPERATION_NOT_CATALOGUED');
  if (operation.nothingHappened === 'not_reconcilable')
    return await refused('EFFECT_NOT_RECONCILABLE');
  // C60, before any route is chosen: a client's model use is off and cannot be
  // switched on while no local model exists (owner line 72), so no call on a
  // client's task reaches a route, naming any subscription offered (C32 stores it).
  if (facts.clientId !== null) return await refused(clientRefusal(broker.routes, operation));
  // #1623 R3: the attempt's calls stop at its limit, counted under the run lock.
  const place = await placeOf(tx, facts.leaseId, broker.callLimit);
  if (place !== undefined && place.ordinal >= place.limit)
    return await refused('CALL_LIMIT_REACHED');
  // S3: each source is the broker's finding, from its row, never the caller's claim; a
  // turn's ordinal is the attempt's count, and each part is bound to what the broker owns.
  const resolved = await fieldsOf(tx, request, operation, facts, place?.ordinal ?? -1);
  if (!resolved.ok) return await refused(resolved.code);
  const route = routeFor(operation, caller, resolved.fields, facts, broker);
  if (!route.ok) return await refused(route.code, route.words);
  if (oversized(broker, operation, resolved.fields)) return await refused('PROMPT_TOO_LARGE');
  if (await atCeiling(tx, operation, route.route)) return await refused('RATE_LIMITED');
  const spent = await committedMinor(tx, facts.reservationId);
  if (operation.maximumMinor > facts.heldMinor - spent) {
    // AW-05: the approved ceiling is the stop; the refusal commits with the wait.
    return await refused('BUDGET_UNAVAILABLE', await stopAtCeiling(tx, facts, spent));
  }
  const callId = await insertHold(tx, facts, operation, route.route, place);
  await registerPromptCopy(tx, callId);
  return {
    ok: true,
    reserved: { callId, operation, route: route.route, reservedMinor: operation.maximumMinor },
  };
}

/** The data classes choose the eligible routes before any route is chosen; then the credential rule checks its kind. */
function routeFor(
  operation: ModelOperation,
  caller: ModelCaller,
  fields: readonly ResolvedField[],
  facts: Facts,
  broker: Broker,
):
  | { readonly ok: true; readonly route: BrokerRoute }
  | { readonly ok: false; readonly code: BrokerRefusal; readonly words?: string } {
  const offered = broker.routes.filter((route) => route.provider === operation.provider);
  // The plan's route is named before the data classes choose, as a client's task is (C60).
  if (offered.some((route) => carriesOnPlan(route)) && !facts.ownerStarted)
    return { ok: false, code: 'SUBSCRIPTION_NOT_OWNER_STARTED' };
  const choice = eligibleRoutes(operation.fields, fields, offered);
  const local = {
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
    words: LOCAL_MODEL_REQUIRED_WORDS,
  } as const;
  if (!choice.ok) return local;
  // The route the data classes found eligible, itself: never another that shares its key.
  const route = broker.routes.find((candidate) => choice.routes.includes(candidate));
  if (route === undefined) return local;
  const carry = mayCarry(route.credentialKind, {
    unattended: caller.attendedByPersonId === null,
    sessionPersonId: caller.attendedByPersonId,
    workForPersonId: facts.workForPersonId,
    tenantInstallation: broker.installation,
    credentialInstallation: route.installation,
    localOwnerTesting: carriesLocally(broker, route),
    clientWork: facts.clientId !== null,
    planRoute: carriesOnPlan(route),
    ownerStarted: facts.ownerStarted,
  });
  if (!carry.ok) return { ok: false, code: carry.code };
  return { ok: true, route };
}

/**
 * The durable ceilings, counting a call from its hold until it ends and a
 * lookup's unexpired slot as one (AW-10, 20261004040000): first the business's own per
 * operation (`hasRoom`), then the route's, the installation's, locked per route.
 */
export async function atCeiling(
  tx: TenantQuery,
  operation: ModelOperation,
  route: BrokerRoute,
): Promise<boolean> {
  const inFlight = async (q: TenantQuery): Promise<number> => {
    const [flight] = await q.query<{ n: string }>(
      `select count(*)::text as n from public.model_calls
        where business_id = $1 and operation_key = $2
          and (state in ('reserved', 'dispatched') or lookup_until > clock_timestamp())`,
      [q.businessId, operation.key],
    );
    return Number(flight?.n ?? 0);
  };
  const name = `model_call:${operation.key}`;
  if (!(await hasRoom(tx, [{ name, limit: operation.concurrency, count: inFlight }]))) return true;
  return !(await routeHasRoom(tx, route));
}

/**
 * The fair share: whether this business may hold one more call on the route, given every
 * business's calls in flight there. Only the broker's role may ask (migration 0085,
 * `model_route_room`); the application takes it for this one statement and gives it back,
 * transaction-local as the wrapper sets the business (`set_config(..., true)`: no `set`
 * statement is sent). A failed statement aborts the transaction, which undoes the role too.
 */
async function routeHasRoom(tx: TenantQuery, route: BrokerRoute): Promise<boolean> {
  await advisoryLock(tx, `model_route:${route.key}`);
  await tx.query(`select set_config('role', 'ops_astro_broker', true)`);
  const [answer] = await tx.query<{ room: number }>(
    'select public.model_route_room($1, $2) as room',
    [route.key, route.ceiling],
  );
  await tx.query(`select set_config('role', 'none', true)`);
  return answer?.room === 1;
}

/** The hold: a `reserved` row at the operation's priced maximum, on the route it will take, in its place. */
async function insertHold(
  tx: TenantQuery,
  facts: Facts,
  operation: ModelOperation,
  route: BrokerRoute,
  place: Place | undefined,
): Promise<string> {
  const callId = randomUUID();
  await tx.query(
    `insert into public.model_calls (${CALL_COLUMNS}, operation_key, state, reserved_minor,
        route_key, route_reach, credential_kind, call_ordinal, call_limit)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', $11, $12, $13, $14, $15, $16)`,
    [
      tx.businessId,
      callId,
      ...callFacts(facts),
      operation.key,
      operation.maximumMinor,
      route.key,
      route.reach,
      route.credentialKind,
      place?.ordinal ?? null,
      place?.limit ?? null,
    ],
  );
  return callId;
}

/** A call row's leading columns: the business, its id, then `callFacts`' order. */
const CALL_COLUMNS = `business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
       delegation_id, caller_delegation_id`;

/** The call's facts in `CALL_COLUMNS`' order: the lease's delegation, then the caller's (0104). */
function callFacts(facts: Facts): readonly (string | null)[] {
  return [
    facts.runId,
    facts.stepId,
    facts.leaseId,
    facts.versionId,
    facts.reservationId,
    facts.delegationId,
    facts.callerDelegationId,
  ];
}
