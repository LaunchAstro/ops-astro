// SPDX-License-Identifier: AGPL-3.0-only
//
// What #1904 P12 shares: a [definition, task] turn reserved through the
// broker's own reserve on a pinned run that read its entry, so the case can
// stand between the reserve's commit and the start, or between the dispatch
// and custody's admission. Every run here is built the same way, so a case
// run and its control differ only in what the case deletes.

import { auditAs } from '../../packages/core-commands/src/commands/model-call.ts';
import {
  reserveModelCall,
  type Broker,
  type ModelCaller,
  type ModelCallRequest,
  type ReservedCall,
} from '../../packages/core-custody/src/index.ts';
import { rows } from '../runtime/schedules-harness.ts';
import { delegationOf, leaseOf, s, signedIn } from './run-stop-door-world.ts';
import { definitionPart, ENTRY, pinnedWork, readOk, type Pinned } from './definition-world.ts';
import { taskPart, TURN, turnBroker } from './turn-world.ts';

/** The turn broker with the agent's audit, its cloud route as given. */
export const rebindBroker = (credentialKind: 'api_key' | 'subscription'): Broker => {
  const broker = turnBroker(3)();
  const routes: (typeof broker.routes)[number][] = [];
  for (const route of broker.routes) {
    if (credentialKind === 'api_key') routes.push(route);
    else if (route.reach === 'cloud') routes.push({ ...route, credentialKind });
  }
  return { ...broker, routes, audit: auditAs(s.agentActorId) } as Broker;
};

export interface Reserved {
  readonly on: Pinned;
  readonly caller: ModelCaller;
  readonly request: ModelCallRequest;
  readonly reserved: ReservedCall;
}

/** A run that read its entry, its [definition, task] turn 0 reserved and committed. */
export async function reservedTurn(
  title: string,
  broker: Broker,
  attendedByPersonId: string | null,
): Promise<Reserved> {
  const on = await pinnedWork(title);
  await readOk(on, await signedIn());
  const request: ModelCallRequest = {
    leaseId: leaseOf(on.work),
    fence: Number(on.work.picked['fence']),
    stepId: on.stepId,
    operation: TURN,
    fields: [],
    turn: {
      turnOrdinal: 0,
      tools: ['task.read'],
      parts: [definitionPart(ENTRY), await taskPart(on.work)],
    },
  };
  const caller: ModelCaller = {
    actorId: s.agentActorId,
    delegationId: delegationOf(on.work),
    attendedByPersonId,
  };
  const reservation = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller, request, broker),
  );
  if (!reservation.ok) throw new Error(`setup: the reserve was refused ${reservation.code}`);
  return { on, caller, request, reserved: reservation.reserved };
}

export interface Standing {
  readonly leaseLive: boolean;
  readonly fence: string;
  readonly delegationLive: boolean;
  readonly call: string;
  readonly client: string | null;
  readonly calls: number;
}

/** Every earlier guard, read unlocked on the owner connection, a connection of its own. */
export async function standingOf({ on, reserved }: Reserved): Promise<Standing | undefined> {
  const [row] = await rows<Standing>(
    s,
    `select l.state = 'live' and l.expires_at > clock_timestamp() as "leaseLive",
            l.fence::text as fence,
            (d.revoked_at is null and d.settled_at is null
              and d.expires_at > clock_timestamp()) as "delegationLive",
            c.state as call, t.data->>'client' as client,
            (select count(*)::int from public.model_calls k
              where k.business_id = l.business_id and k.lease_id = l.id) as calls
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
       join public.model_calls c on c.business_id = l.business_id and c.id = $3
       join public.records t on t.business_id = l.business_id and t.id = $4
      where l.business_id = $1 and l.id = $2`,
    [s.business, leaseOf(on.work), reserved.callId, on.work.taskId],
  );
  return row;
}

/** The run's ledger row removed by the owner connection, which no application role can do. */
export async function deleteTheLedgerRow({ on }: Reserved): Promise<void> {
  await s.db.admin.execute(
    'delete from public.bootstrap_reads where business_id = $1 and run_id = $2',
    [s.business, on.runId],
  );
}
