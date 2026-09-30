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
import { mayCarry } from './credentials.ts';
import { committedMinor, lockFacts, type Facts } from './broker-facts.ts';
import { resolveFields } from './broker-sources.ts';
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

/** Register the outbound prompt's copy before it is first materialised. */
export async function registerPromptCopy(tx: TenantQuery, callId: string): Promise<void> {
  await tx.query(
    `insert into public.copy_registrations
       (business_id, id, copy_class, copy_key, invalidation_trigger, retention_class)
     values ($1, $2, 'outbound_prompt', $3, 'call_ended', 'transient')`,
    [tx.businessId, randomUUID(), `model_call:${callId}`],
  );
}

/** Refuses unless the copy is registered: nothing is copied or sent before this answers true. */
export async function promptCopyRegistered(tx: TenantQuery, callId: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from public.copy_registrations
      where business_id = $1 and copy_class = 'outbound_prompt' and copy_key = $2`,
    [tx.businessId, `model_call:${callId}`],
  );
  return rows.length === 1;
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
  RATE_LIMITED: ['Wait, then send the call again with a new operation id.'],
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
 * Step 1 in the caller's transaction, so the command layer commits the hold,
 * the copy registration and its own register row as one: a repeat of the
 * operation finds the row, and two at once cannot both hold. A refusal with a
 * `callId` wrote its step; one without wrote nothing.
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
  const refused = async (code: BrokerRefusal, words?: string): Promise<ReserveRefusal> =>
    refusing(
      code,
      await recordRefusal(tx, facts, request.operation, code, broker),
      words === undefined ? {} : { words },
    );
  if (operation === undefined) return await refused('OPERATION_NOT_CATALOGUED');
  if (operation.nothingHappened === 'not_reconcilable')
    return await refused('EFFECT_NOT_RECONCILABLE');
  // C60, before any route is chosen: a client's model use is off by default
  // and cannot be switched on while no local model exists (owner line 72), so
  // no call on a client's task reaches a route. The setting itself is stored
  // on the client record once there is one (C32).
  if (facts.clientId !== null) return await refused('CLIENT_MODEL_USE_OFF');
  // S3: each field's source is the broker's finding, from its row, never the caller's claim.
  const resolved = resolveFields(request.fields, facts.source);
  if (!resolved.ok) return await refused(resolved.code);
  const route = routeFor(operation, caller, resolved.fields, facts, broker);
  if (!route.ok) return await refused(route.code, route.words);
  if (await atCeiling(tx, operation, route.route)) {
    return refusing('RATE_LIMITED', null, { retryAfterSeconds: WAIT_SECONDS });
  }
  const spent = await committedMinor(tx, facts.reservationId);
  if (operation.maximumMinor > facts.heldMinor - spent) {
    // AW-05: the approved ceiling is the stop; the refusal commits with the wait.
    return await refused('BUDGET_UNAVAILABLE', await stopAtCeiling(tx, facts, spent));
  }
  const callId = await insertHold(tx, facts, operation, route.route);
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
  const choice = eligibleRoutes(
    operation.fields,
    fields,
    broker.routes.filter((route) => route.provider === operation.provider),
  );
  const local = {
    ok: false,
    code: 'LOCAL_MODEL_REQUIRED',
    words: LOCAL_MODEL_REQUIRED_WORDS,
  } as const;
  if (!choice.ok) return local;
  const route = broker.routes.find((candidate) =>
    choice.routes.some((eligible) => eligible.key === candidate.key),
  );
  if (route === undefined) return local;
  const carry = mayCarry(route.credentialKind, {
    unattended: caller.attendedByPersonId === null,
    sessionPersonId: caller.attendedByPersonId,
    workForPersonId: facts.workForPersonId,
    tenantInstallation: broker.installation,
    credentialInstallation: route.installation,
  });
  if (!carry.ok) return { ok: false, code: carry.code };
  return { ok: true, route };
}

/**
 * The durable ceilings. A call is in flight from its hold until it ends, so a
 * hold not yet sent counts. First the business's own ceiling per operation, a
 * durable limit (`hasRoom`); then the route's, which is the installation's,
 * under one lock per route.
 */
export async function atCeiling(
  tx: TenantQuery,
  operation: ModelOperation,
  route: BrokerRoute,
): Promise<boolean> {
  const inFlight = async (q: TenantQuery): Promise<number> => {
    const [flight] = await q.query<{ n: string }>(
      `select count(*)::text as n from public.model_calls
        where business_id = $1 and operation_key = $2 and state in ('reserved', 'dispatched')`,
      [q.businessId, operation.key],
    );
    return Number(flight?.n ?? 0);
  };
  const name = `model_call:${operation.key}`;
  if (!(await hasRoom(tx, [{ name, limit: operation.concurrency, count: inFlight }]))) return true;
  return !(await routeHasRoom(tx, route));
}

/**
 * The fair share: whether this business may hold one more call on the route,
 * given every business's calls in flight there. Only the broker's role may ask
 * (migration 0042, `model_route_room`); the application takes it for this one
 * statement and gives it back, transaction-local as the wrapper sets the
 * business (`set_config(..., true)`: no `set` statement is sent). A failed
 * statement aborts the transaction, which undoes the role with the rest.
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

/** The hold: a `reserved` row at the operation's priced maximum, on the route it will take. */
async function insertHold(
  tx: TenantQuery,
  facts: Facts,
  operation: ModelOperation,
  route: BrokerRoute,
): Promise<string> {
  const callId = randomUUID();
  await tx.query(
    `insert into public.model_calls (${CALL_COLUMNS}, operation_key, state, reserved_minor,
        route_key, route_reach, credential_kind)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', $11, $12, $13, $14)`,
    [
      tx.businessId,
      callId,
      ...callFacts(facts),
      operation.key,
      operation.maximumMinor,
      route.key,
      route.reach,
      route.credentialKind,
    ],
  );
  return callId;
}

/** A call row's leading columns: the business, its id, then `callFacts`' order. */
const CALL_COLUMNS = `business_id, id, run_id, step_id, lease_id, version_id, reservation_id,
       delegation_id, caller_delegation_id`;

/** The call's facts in `CALL_COLUMNS`' order: the lease's delegation, then the caller's (0062). */
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
