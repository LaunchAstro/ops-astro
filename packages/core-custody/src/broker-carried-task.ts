// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's call carried to the model agent on the owner's machine (#1703,
// #1620 P5): what its offer and send judgements read of the call and its
// task, in the command layer's transaction (`task-carriage.ts`).
//
// The locks, in one order: the call with its carriers row (still dispatched;
// at the offer not yet offered, at the send recorded for this runner), then
// the six facts in the contract's order (task, run, lease, delegation,
// reservation, `lockFacts`), then the carrier's agent. A client link, a
// lease handed back or expired, a delegation revoked or settled, a staff
// approval, or the agent's deactivation takes one of those locks, so it
// commits before the judgement, which sees it, or waits.
//
// The judgement is made at an instant the caller reads after every lock and
// every other wait (`judgeCarriedTask`): the lease and each delegation live
// at that instant, the subscription still one the call may carry (the
// tenant's installation, no client, the run the owner's), its fields still
// ones the route may take, and the run's starter one the carrier carries for.

import { eligibleRoutes, type ModelOperation } from '../../core-connectors/src/index.ts';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { lockFacts, type Facts } from './broker-facts.ts';
import { fieldsOf } from './broker-turn.ts';
import type {
  Broker,
  BrokerRoute,
  Carrier,
  ModelCaller,
  ModelCallRequest,
} from './broker-types.ts';
import type { Judged } from './carriage.ts';
import { carriesLocally, carriesOnPlan, mayCarry } from './carry-rule.ts';

export interface CarriedTask {
  readonly callId: string;
  readonly caller: ModelCaller;
  readonly request: ModelCallRequest;
  readonly carrier: Carrier;
  readonly broker: Pick<Broker, 'operations' | 'routes' | 'installation' | 'localOwnerTesting'>;
}

/** What the locks held: the facts, and the call's route and operation as the broker has them now. */
export interface HeldTask {
  readonly facts: Facts;
  readonly route: BrokerRoute;
  readonly operation: ModelOperation;
}

const STALE = { ok: false, code: 'DECISION_STALE' } as const;
const LOST = { ok: false, code: 'AUTHORITY_LOST' } as const;

/** Every lock the call's authority rests on, in order; the facts held, or why not. */
export async function lockCarriedTask(
  tx: TenantQuery,
  task: CarriedTask,
  mode: 'offer' | { readonly runner: string },
): Promise<HeldTask | Exclude<Judged, { ok: true }>> {
  const [call] = await tx.query<{
    readonly state: string;
    readonly lease: string | null;
    readonly route: string | null;
    readonly agent: string;
    readonly offered: boolean;
    readonly runner: string | null;
  }>(
    `select c.state, c.lease_id::text as lease, c.route_key as route,
            k.agent_actor_id::text as agent, k.offered_at is not null as offered,
            k.runner::text as runner
       from public.model_calls c
       join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      where c.business_id = $1 and c.id = $2 and c.conversation_id is null
      for share of c`,
    [tx.businessId, task.callId],
  );
  const due = mode === 'offer' ? !call?.offered : call?.runner === mode.runner;
  if (call?.state !== 'dispatched' || !due || call.lease !== task.request.leaseId) return STALE;
  const checked = await lockFacts(tx, task.caller, task.request);
  if (!checked.ok) return checked;
  const agent = await tx.query(
    `select 1 from public.actors
      where business_id = $1 and id = $2 and kind = 'agent' and active for share`,
    [tx.businessId, call.agent],
  );
  const route = task.broker.routes.find((candidate) => candidate.key === call.route);
  const operation = task.broker.operations.get(task.request.operation);
  if (agent.length === 0 || call.agent !== task.carrier.agent) return LOST;
  if (route === undefined || operation === undefined) return LOST;
  return { facts: checked.facts, route, operation };
}

/** The judgement at `at`, read after every lock and wait: nothing earlier is reused. */
export async function judgeCarriedTask(
  tx: TenantQuery,
  task: CarriedTask,
  held: HeldTask,
  at: string,
): Promise<Judged> {
  const { facts, route, operation } = held;
  const delegations = [facts.delegationId, facts.callerDelegationId].filter(
    (id): id is string => id !== null,
  );
  const [live] = await tx.query<{ readonly lease: boolean; readonly delegations: boolean }>(
    `select l.state = 'live' and l.expires_at > $3::timestamptz as lease,
            not exists (select 1 from public.delegations d
                         where d.business_id = l.business_id and d.id = any($4::uuid[])
                           and not (d.revoked_at is null and d.settled_at is null
                                    and d.expires_at > $3::timestamptz)) as delegations
       from public.leases l where l.business_id = $1 and l.id = $2`,
    [tx.businessId, facts.leaseId, at, delegations],
  );
  if (live?.lease !== true || !live.delegations) return LOST;
  const carry = mayCarry(route.credentialKind, {
    unattended: true,
    sessionPersonId: null,
    workForPersonId: facts.workForPersonId,
    tenantInstallation: task.broker.installation,
    credentialInstallation: route.installation,
    localOwnerTesting: carriesLocally(task.broker, route),
    clientWork: facts.clientId !== null,
    planRoute: carriesOnPlan(route),
    ownerStarted: facts.ownerStarted,
  });
  if (!carry.ok) return carry;
  if (facts.clientId !== null) return { ok: false, code: 'CLIENT_MODEL_USE_OFF' };
  // A turn is bound again here, as at the start, so a task written in the M5's wait sends nothing (#2091).
  const resolved = await fieldsOf(tx, task.request, operation, {
    leaseId: facts.leaseId,
    source: facts.source,
  });
  if (!resolved.ok) return resolved;
  const still = eligibleRoutes(operation.fields, resolved.fields, [route]);
  if (!still.ok || still.routes.length === 0) return { ok: false, code: 'LOCAL_MODEL_REQUIRED' };
  const starter = facts.starterPersonId;
  return starter !== null && task.carrier.people.includes(starter) ? { ok: true } : LOST;
}
