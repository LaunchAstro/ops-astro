// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's model call (AW-01): the only way a priced model call is made.
//
// Three transactions and one send, in this order. The first can be the
// caller's own (`reserveModelCall`): the `model.call` command commits the
// hold with its register row, so one operation id holds once.
//
// 1. Reserve. Under the lease, delegation and reservation row locks (the
//    contract's order), verify the six facts against rows: the business (the
//    tenant transaction), the run and its step, the caller's live lease and
//    fence, the approved version the reservation holds for, the catalogued
//    operation, and the grant (the run's live delegation). None comes from
//    the caller, and the caller never names a destination. Then the data
//    classes choose the eligible routes before any route is chosen, the
//    credential rule checks the route's kind, and the operation's priced
//    maximum is held out of the reservation's room: a row in `model_calls`,
//    state `reserved`, with the outbound prompt's copy registered beside it.
//    A refusal after the facts hold is recorded as a step (state `refused`);
//    a refusal of the facts themselves writes nothing.
// 2. Start. The six facts are read again under their locks, and a call whose
//    authority went since the hold is released unsent. The call is marked
//    `dispatched` with its route and credential kind before custody is
//    asked, so a crash after this point leaves a call the sweep holds as
//    unknown liability and never releases.
// 3. Send, through custody, with a request the adapter built from registered
//    fields. The broker's process opens no connection.
// 4. Settle, under the same locks, with the audit event in the same
//    transaction: priced within the hold settles and releases the rest;
//    positive proof that nothing happened releases it all; above the hold, or
//    no answer, holds the maximum as `liability_unknown` until a person
//    records an outcome. An expired lease still settles the cost; the work is
//    refused.

import { randomUUID } from 'node:crypto';
import {
  isUuid,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import {
  eligibleRoutes,
  LOCAL_MODEL_REQUIRED_WORDS,
  SETTLE_LEVELS,
  type AdapterRequest,
  type FieldSource,
  type ModelAnswer,
  type ModelOperation,
  type RouteReach,
} from '../../core-connectors/src/index.ts';
import { mayCarry, type CarryRefusal, type CredentialKind } from './credentials.ts';
import type { Custody } from './custody.ts';

/** How a provider's adapter builds a request and prices an answer. It runs here, never in custody. */
export interface ProviderAdapter {
  readonly build: (values: Readonly<Record<string, string>>) => AdapterRequest;
  readonly price: (answer: ModelAnswer) => number;
}

/** A configured route: where a call may go, and which credential custody carries it with. */
export interface BrokerRoute {
  readonly key: string;
  readonly reach: RouteReach;
  readonly provider: string;
  readonly credentialRef: string;
  readonly credentialKind: CredentialKind;
  /** The installation whose credential this is. */
  readonly installation: string;
}

/**
 * One audit event, written by the command layer in the settling transaction.
 * An applied event carries only the digest of its detail; a refusal carries
 * the detail itself (the observed amount, for one above the hold).
 */
export interface AuditNote {
  readonly action:
    'model.call_dispatched' | 'model.call_released' | 'model.call_refused' | 'model.call_held';
  readonly outcome: 'applied' | 'refused';
  /** Set on a refusal, from the refusal register. */
  readonly refusalCode: BrokerRefusal | 'LIABILITY_UNKNOWN' | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface Broker {
  readonly custody: Custody;
  readonly operations: ReadonlyMap<string, ModelOperation>;
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
  readonly routes: readonly BrokerRoute[];
  readonly installation: string;
  /** Written by the command layer inside the settling transaction. */
  readonly audit: (tx: TenantQuery, note: AuditNote) => Promise<void>;
}

export interface ModelCallField {
  readonly name: string;
  readonly source: FieldSource;
  readonly value: string;
}

export interface ModelCallRequest {
  readonly leaseId: string;
  readonly fence: number;
  readonly stepId: string;
  readonly operation: string;
  readonly fields: readonly ModelCallField[];
}

/** Who is calling, from the authenticated envelope, never the body. */
export interface ModelCaller {
  readonly actorId: string;
  /** The delegation the envelope resolved for this call, or none for a person's own lease. */
  readonly delegationId: string | null;
  /** The person present in their own session for this call, or none for unattended work. */
  readonly attendedByPersonId: string | null;
}

export type BrokerRefusal =
  | 'LEASE_NOT_OWNED'
  | 'LEASE_EXPIRED'
  | 'DECISION_STALE'
  | 'AUTHORITY_LOST'
  | 'OPERATION_NOT_CATALOGUED'
  | 'EFFECT_NOT_RECONCILABLE'
  | 'LOCAL_MODEL_REQUIRED'
  | 'BUDGET_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'COPY_NOT_REGISTERED'
  | CarryRefusal;

export type ModelCallResult =
  | {
      readonly ok: true;
      readonly callId: string;
      readonly text: string;
      readonly reservedMinor: number;
      readonly actualMinor: number;
      readonly releasedMinor: number;
    }
  | {
      readonly ok: false;
      readonly code: BrokerRefusal;
      /** The recorded step, when the refusal was recorded as one. */
      readonly callId: string | null;
      readonly words?: string;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly ok: false;
      readonly code: 'LIABILITY_UNKNOWN';
      readonly callId: string;
      readonly heldMinor: number;
      readonly observedMinor: number | null;
      readonly drop: 'dropped_worker_lost' | 'dropped_no_answer' | null;
    }
  | {
      readonly ok: false;
      readonly code: 'CALL_RELEASED';
      readonly callId: string;
      readonly reason: string;
    };

interface Facts {
  readonly leaseId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly delegationId: string | null;
  readonly workForPersonId: string | null;
  readonly heldMinor: number;
  readonly leaseLive: boolean;
}

const WAIT_SECONDS = 5;

type Checked =
  | { readonly ok: true; readonly facts: Facts }
  | { readonly ok: false; readonly code: BrokerRefusal };

/**
 * The six facts, read under the contract's lock order (lease, delegation,
 * reservation). `forSettlement` accepts an expired lease: the cost settles
 * whatever the lease's state, and the work is refused by the caller.
 */
async function lockFacts(
  tx: TenantQuery,
  caller: ModelCaller,
  request: Pick<ModelCallRequest, 'leaseId' | 'fence' | 'stepId'>,
  forSettlement: boolean,
): Promise<Checked> {
  // A malformed identity or fence is refused like a made-up one, before any row is read.
  if (!isUuid(request.leaseId) || !isUuid(request.stepId) || !Number.isSafeInteger(request.fence)) {
    return { ok: false, code: 'LEASE_NOT_OWNED' };
  }
  const [lease] = await tx.query<{
    run_id: string;
    reservation_id: string;
    delegation_id: string | null;
    holder_actor_id: string;
    fence: string;
    live: boolean;
  }>(
    `select run_id, reservation_id, delegation_id, holder_actor_id, fence::text as fence,
            (state = 'live' and expires_at > clock_timestamp()) as live
       from public.leases where business_id = $1 and id = $2 for update`,
    [tx.businessId, request.leaseId],
  );
  // Another business's lease, a made-up one, someone else's and one of our
  // own under another delegation all read alike.
  if (
    lease === undefined ||
    lease.holder_actor_id !== caller.actorId ||
    lease.delegation_id !== caller.delegationId ||
    lease.fence !== String(request.fence)
  ) {
    return { ok: false, code: 'LEASE_NOT_OWNED' };
  }
  if (!lease.live && !forSettlement) return { ok: false, code: 'LEASE_EXPIRED' };
  let workForPersonId: string | null = null;
  if (lease.delegation_id !== null) {
    const [delegation] = await tx.query<{ delegate_person_id: string; live: boolean }>(
      `select delegate_person_id,
              (revoked_at is null and settled_at is null and expires_at > clock_timestamp()) as live
         from public.delegations where business_id = $1 and id = $2 for update`,
      [tx.businessId, lease.delegation_id],
    );
    if (delegation === undefined) return { ok: false, code: 'AUTHORITY_LOST' };
    if (!delegation.live && !forSettlement) return { ok: false, code: 'AUTHORITY_LOST' };
    workForPersonId = delegation.delegate_person_id;
  }
  const [held] = await tx.query<{ version_id: string; held_minor: string; state: string }>(
    `select r.version_id, r.held_minor::text as held_minor, r.state
       from public.reservations r
       join public.planned_runs run
         on run.business_id = r.business_id and run.id = r.run_id and run.version_id = r.version_id
      where r.business_id = $1 and r.id = $2 and r.run_id = $3
      for update of r`,
    [tx.businessId, lease.reservation_id, lease.run_id],
  );
  if (held === undefined || (held.state !== 'held' && !forSettlement)) {
    return { ok: false, code: 'DECISION_STALE' };
  }
  const [step] = await tx.query<{ id: string }>(
    `select id from public.planned_steps where business_id = $1 and id = $2 and run_id = $3`,
    [tx.businessId, request.stepId, lease.run_id],
  );
  if (step === undefined) return { ok: false, code: 'LEASE_NOT_OWNED' };
  return {
    ok: true,
    facts: {
      leaseId: request.leaseId,
      runId: lease.run_id,
      stepId: step.id,
      versionId: held.version_id,
      reservationId: lease.reservation_id,
      delegationId: lease.delegation_id,
      workForPersonId,
      heldMinor: Number(held.held_minor),
      leaseLive: lease.live,
    },
  };
}

/** What the run's calls already hold or spent out of its reservation. */
async function committedMinor(tx: TenantQuery, reservationId: string): Promise<number> {
  const [row] = await tx.query<{ committed: string }>(
    `select coalesce(sum(case when state = 'settled' then actual_minor
                              when state in ('reserved', 'dispatched', 'liability_unknown') then reserved_minor
                              else 0 end), 0)::text as committed
       from public.model_calls where business_id = $1 and reservation_id = $2`,
    [tx.businessId, reservationId],
  );
  return Number(row?.committed ?? 0);
}

async function recordRefusal(
  tx: TenantQuery,
  facts: Facts,
  operationKey: string,
  code: BrokerRefusal,
  broker: Broker,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, delegation_id,
        operation_key, state, reserved_minor, refusal_code, ended_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'refused', 0, $10, clock_timestamp())`,
    [
      tx.businessId,
      id,
      facts.runId,
      facts.stepId,
      facts.leaseId,
      facts.versionId,
      facts.reservationId,
      facts.delegationId,
      operationKey,
      code,
    ],
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

export type Reservation =
  | { readonly ok: true; readonly reserved: ReservedCall }
  | Extract<ModelCallResult, { code: BrokerRefusal }>;

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
  const checked = await lockFacts(tx, caller, request, false);
  if (!checked.ok) return { ok: false, code: checked.code, callId: null };
  const { facts } = checked;
  const operation = broker.operations.get(request.operation);
  const refused = async (
    code: BrokerRefusal,
    words?: string,
  ): Promise<Extract<ModelCallResult, { code: BrokerRefusal }>> => ({
    ok: false,
    code,
    callId: await recordRefusal(tx, facts, request.operation, code, broker),
    ...(words === undefined ? {} : { words }),
  });
  if (operation === undefined) return await refused('OPERATION_NOT_CATALOGUED');
  if (operation.nothingHappened === 'not_reconcilable')
    return await refused('EFFECT_NOT_RECONCILABLE');
  const choice = eligibleRoutes(
    operation.fields,
    request.fields,
    broker.routes.filter((route) => route.provider === operation.provider),
  );
  if (!choice.ok) return await refused('LOCAL_MODEL_REQUIRED', LOCAL_MODEL_REQUIRED_WORDS);
  const route = broker.routes.find((candidate) =>
    choice.routes.some((eligible) => eligible.key === candidate.key),
  );
  if (route === undefined) return await refused('LOCAL_MODEL_REQUIRED', LOCAL_MODEL_REQUIRED_WORDS);
  const carry = mayCarry(route.credentialKind, {
    unattended: caller.attendedByPersonId === null,
    sessionPersonId: caller.attendedByPersonId,
    workForPersonId: facts.workForPersonId,
    tenantInstallation: broker.installation,
    credentialInstallation: route.installation,
  });
  if (!carry.ok) return await refused(carry.code);
  // The durable ceiling: in-flight calls are rows, counted under one lock per operation.
  await tx.query(`select pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    `model_call:${tx.businessId}`,
    operation.key,
  ]);
  const [flight] = await tx.query<{ n: string }>(
    `select count(*)::text as n from public.model_calls
      where business_id = $1 and operation_key = $2 and state = 'dispatched'`,
    [tx.businessId, operation.key],
  );
  if (Number(flight?.n ?? 0) >= operation.concurrency) {
    return { ok: false, code: 'RATE_LIMITED', callId: null, retryAfterSeconds: WAIT_SECONDS };
  }
  const room = facts.heldMinor - (await committedMinor(tx, facts.reservationId));
  if (operation.maximumMinor > room) return await refused('BUDGET_UNAVAILABLE');
  const callId = randomUUID();
  await tx.query(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, delegation_id,
        operation_key, state, reserved_minor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved', $10)`,
    [
      tx.businessId,
      callId,
      facts.runId,
      facts.stepId,
      facts.leaseId,
      facts.versionId,
      facts.reservationId,
      facts.delegationId,
      operation.key,
      operation.maximumMinor,
    ],
  );
  await registerPromptCopy(tx, callId);
  return {
    ok: true,
    reserved: { callId, operation, route, reservedMinor: operation.maximumMinor },
  };
}

/**
 * Step 2, as the effect applies: the six facts again under their locks, so a
 * lease, delegation or reservation lost since the hold sends nothing. The
 * hold is then released, never started, with the route it would have taken
 * and no start time. Only then is the call marked `dispatched`.
 */
async function markStarted(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  broker: Broker,
): Promise<'started' | BrokerRefusal> {
  return await database.withBusiness(businessId, async (tx) => {
    const route = [reserved.route.key, reserved.route.reach, reserved.route.credentialKind];
    const checked = await lockFacts(tx, caller, request, false);
    if (!checked.ok) {
      await tx.query(
        `update public.model_calls
            set state = 'released', ended_at = clock_timestamp(),
                route_key = $3, route_reach = $4, credential_kind = $5
          where business_id = $1 and id = $2 and state = 'reserved'`,
        [tx.businessId, reserved.callId, ...route],
      );
      await broker.audit(tx, {
        action: 'model.call_released',
        outcome: 'refused',
        refusalCode: checked.code,
        detail: { callId: reserved.callId, code: checked.code },
      });
      return checked.code;
    }
    if (!(await promptCopyRegistered(tx, reserved.callId))) return 'COPY_NOT_REGISTERED';
    await tx.query(
      `update public.model_calls
          set state = 'dispatched', started_at = clock_timestamp(),
              route_key = $3, route_reach = $4, credential_kind = $5
        where business_id = $1 and id = $2 and state = 'reserved'`,
      [tx.businessId, reserved.callId, ...route],
    );
    return 'started';
  });
}

const reaches = (operation: ModelOperation, level: (typeof SETTLE_LEVELS)[number]): boolean =>
  SETTLE_LEVELS.indexOf(level) <= SETTLE_LEVELS.indexOf(operation.settlesAt);

type Settlement =
  | {
      readonly kind: 'priced';
      readonly answer: ModelAnswer;
      readonly costMinor: number;
      readonly account: string | null;
      readonly credentialKind: CredentialKind;
    }
  | { readonly kind: 'nothing'; readonly reason: string }
  | {
      readonly kind: 'unknown';
      readonly drop: 'dropped_worker_lost' | 'dropped_no_answer' | null;
      readonly fault: 'ours' | 'provider';
    };

async function settle(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  settlement: Settlement,
  broker: Broker,
): Promise<ModelCallResult> {
  return await database.withBusiness(businessId, async (tx) => {
    const checked = await lockFacts(tx, caller, request, true);
    if (!checked.ok)
      throw new Error(`model call ${reserved.callId}: its lease left the caller mid-call`);
    const { callId, operation, reservedMinor } = reserved;
    const hold = async (
      observed: number | null,
      drop: (Settlement & { kind: 'unknown' }) | null,
    ): Promise<ModelCallResult> => {
      await tx.query(
        `update public.model_calls
            set state = 'liability_unknown', observed_minor = $3, fault = $4, drop_state = $5
          where business_id = $1 and id = $2`,
        [tx.businessId, callId, observed, drop?.fault ?? 'provider', drop?.drop ?? null],
      );
      await broker.audit(tx, {
        action: 'model.call_held',
        outcome: 'refused',
        refusalCode: 'LIABILITY_UNKNOWN',
        detail: {
          callId,
          operation: operation.key,
          heldMinor: reservedMinor,
          observedMinor: observed,
          drop: drop?.drop ?? null,
        },
      });
      return {
        ok: false,
        code: 'LIABILITY_UNKNOWN',
        callId,
        heldMinor: reservedMinor,
        observedMinor: observed,
        drop: drop?.drop ?? null,
      };
    };
    if (settlement.kind === 'unknown') return await hold(null, settlement);
    if (settlement.kind === 'nothing') {
      await tx.query(
        `update public.model_calls set state = 'released', ended_at = clock_timestamp()
          where business_id = $1 and id = $2`,
        [tx.businessId, callId],
      );
      await broker.audit(tx, {
        action: 'model.call_released',
        outcome: 'applied',
        refusalCode: null,
        detail: {
          callId,
          operation: operation.key,
          releasedMinor: reservedMinor,
          reason: settlement.reason,
        },
      });
      return { ok: false, code: 'CALL_RELEASED', callId, reason: settlement.reason };
    }
    const { costMinor } = settlement;
    if (!Number.isSafeInteger(costMinor) || costMinor < 0 || costMinor > reservedMinor) {
      return await hold(Number.isSafeInteger(costMinor) ? costMinor : null, null);
    }
    await tx.query(
      `update public.model_calls
          set state = 'settled', observed_minor = $3, actual_minor = $3, account = $4,
              credential_kind = $5,
              completed_at = case when $6 then clock_timestamp() end,
              landed_at = case when $7 then clock_timestamp() end,
              ended_at = clock_timestamp()
        where business_id = $1 and id = $2`,
      [
        tx.businessId,
        callId,
        costMinor,
        settlement.credentialKind === 'replay' ? null : settlement.account,
        settlement.credentialKind,
        reaches(operation, 'completed'),
        reaches(operation, 'landed'),
      ],
    );
    await broker.audit(tx, {
      action: 'model.call_dispatched',
      outcome: 'applied',
      refusalCode: null,
      detail: {
        callId,
        operation: operation.key,
        route: reserved.route.key,
        credentialKind: settlement.credentialKind,
        reservedMinor,
        actualMinor: costMinor,
        releasedMinor: reservedMinor - costMinor,
      },
    });
    if (!checked.facts.leaseLive) return { ok: false, code: 'LEASE_EXPIRED', callId };
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

/** One priced model call, through the broker only. */
export async function callModel(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  broker: Broker,
): Promise<ModelCallResult> {
  const reserving = await database.withBusiness(
    businessId,
    async (tx) => await reserveModelCall(tx, caller, request, broker),
  );
  if (!reserving.ok) return reserving;
  return await sendReservedCall(database, businessId, caller, request, reserving.reserved, broker);
}

/** Steps 2 to 4, after the hold has committed: start, send through custody, settle. */
export async function sendReservedCall(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ModelCallRequest,
  reserved: ReservedCall,
  broker: Broker,
): Promise<ModelCallResult> {
  const started = await markStarted(database, businessId, caller, request, reserved, broker);
  if (started !== 'started') return { ok: false, code: started, callId: reserved.callId };
  const adapter = broker.providers.get(reserved.operation.provider);
  if (adapter === undefined) throw new Error(`no adapter for ${reserved.operation.provider}`);
  const values = Object.fromEntries(request.fields.map((field) => [field.name, field.value]));
  const built = adapter.build(values);
  const outcome = await broker.custody.dispatch(reserved.route.credentialRef, {
    destination: reserved.operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: reserved.operation.timeoutMs,
    maxResponseBytes: reserved.operation.maxResponseBytes,
  });
  const settlement = ((): Settlement => {
    if (outcome.kind === 'worker_lost')
      return { kind: 'unknown', drop: 'dropped_worker_lost', fault: 'ours' };
    if (outcome.kind === 'refused') return { kind: 'nothing', reason: outcome.code };
    if (!outcome.outbound.ok)
      return { kind: 'unknown', drop: 'dropped_no_answer', fault: 'provider' };
    let body: unknown;
    try {
      body = JSON.parse(outcome.outbound.body);
    } catch {
      return { kind: 'unknown', drop: 'dropped_no_answer', fault: 'provider' };
    }
    const answer = reserved.operation.answer(body);
    if (answer === undefined)
      return { kind: 'unknown', drop: 'dropped_no_answer', fault: 'provider' };
    const proof = reserved.operation.nothingHappened;
    if (
      answer.providerCode !== null &&
      proof !== 'not_reconcilable' &&
      proof.includes(answer.providerCode)
    ) {
      return { kind: 'nothing', reason: answer.providerCode };
    }
    return {
      kind: 'priced',
      answer,
      costMinor: adapter.price(answer),
      account: outcome.account,
      credentialKind: outcome.credentialKind,
    };
  })();
  return await settle(database, businessId, caller, request, reserved, settlement, broker);
}

/** The lease-expiry sweep's half: a started call with no answer is held, never released; one never started is released. */
export async function sweepModelCalls(
  tx: TenantQuery,
): Promise<{ readonly held: number; readonly released: number }> {
  const held = await tx.query(
    `update public.model_calls c
        set state = 'liability_unknown', fault = 'ours', drop_state = 'dropped_no_answer'
       from public.leases l
      where c.business_id = $1 and l.business_id = c.business_id and l.id = c.lease_id
        and c.state = 'dispatched' and (l.state <> 'live' or l.expires_at <= clock_timestamp())
      returning c.id`,
    [tx.businessId],
  );
  const released = await tx.query(
    `update public.model_calls c
        set state = 'released', ended_at = clock_timestamp()
       from public.leases l
      where c.business_id = $1 and l.business_id = c.business_id and l.id = c.lease_id
        and c.state = 'reserved' and (l.state <> 'live' or l.expires_at <= clock_timestamp())
      returning c.id`,
    [tx.businessId],
  );
  return { held: held.length, released: released.length };
}
