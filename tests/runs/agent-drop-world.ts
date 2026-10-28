// SPDX-License-Identifier: AGPL-3.0-only
//
// What #1738's database proofs of AW-10 on the shipped agent runner share, on
// the stop world (`run-stop-world.ts`). The door's broker is the API's own
// replay catalogue (`catalogueOf('api')`: the agent's turn and the provider's
// lookup), the worker is the shipped one computing the owner's accepted plan
// with `agentRunner`, and the pass is the one the API runs, its provider phase
// included. Rows are read through the admin connection, and the drops as the
// task's people read them (`readCallDrops`).

import { randomUUID } from 'node:crypto';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import { passDeployment, registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import type { WorkerOutcome } from '../../apps/worker/worker.ts';
import { callerAudit } from '../../packages/core-commands/src/index.ts';
import type { ModelBroker } from '../../packages/core-commands/src/commands/model-call.ts';
import { AGENT_TURN_KEY } from '../../packages/core-connectors/src/index.ts';
import { reconcileProviderCalls } from '../../packages/core-custody/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { readCallDrops, type CallDrop } from '../../packages/core-runtime/src/index.ts';
import { rows } from '../runtime/schedules-harness.ts';
import { agentBroker } from './agent-draft-world.ts';
import { acceptedPlan, type Seam } from './compute-seam-world.ts';
import { s, world } from './run-stop-world.ts';

type Row = Record<string, unknown>;

/** The door's broker as the API composes it for the replay install, over the world's custody. */
export const shippedBroker = (): ModelBroker => ({
  ...agentBroker(),
  ...catalogueOf('api', false),
});

/** The broker whose custody takes the call and never answers: the worker is lost mid-turn. */
const silentBroker = (): ModelBroker => {
  const broker = shippedBroker();
  return {
    ...broker,
    custody: { ...broker.custody, dispatch: async () => await new Promise(() => {}) },
  };
};

/** The owner's plan on a fresh task, accepted, and the shipped worker with the agent's runner to compute it. */
export const shippedPlan = async (
  title: string,
  broker: ModelBroker = shippedBroker(),
): Promise<Seam> =>
  await acceptedPlan(
    `${title} ${randomUUID().slice(0, 8)}`,
    agentRunner({ operation: AGENT_TURN_KEY }),
    broker,
  );

/** The plan's turn meets the provider in `mode`; the worker's pass answers what it ended with. */
export async function droppedTurn(
  mode: 'unavailable' | 'cut',
  title: string,
): Promise<{ readonly seam: Seam; readonly outcome: WorkerOutcome }> {
  const seam = await shippedPlan(title);
  world.provider.mode(mode);
  try {
    return { seam, outcome: await seam.worker.applyOnce(seam.taskId) };
  } finally {
    world.provider.mode('answer');
  }
}

/** The plan's turn taken by custody and never answered, and the worker's lease run out. */
export async function lostTurn(title: string): Promise<Seam> {
  const seam = await shippedPlan(title, silentBroker());
  void seam.worker.applyOnce(seam.taskId);
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling one call into custody
    const [call] = await rows<Row>(
      s,
      `select c.lease_id from public.model_calls c
         join public.planned_runs run on run.business_id = c.business_id and run.id = c.run_id
        where c.business_id = $1 and run.task_id = $2 and c.state = 'dispatched'`,
      [s.business, seam.taskId],
    );
    if (call !== undefined) {
      // eslint-disable-next-line no-await-in-loop -- once, then the loop ends
      await s.db.admin.execute(
        `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
        [call['lease_id']],
      );
      return seam;
    }
    // eslint-disable-next-line no-await-in-loop -- polling one call into custody
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error('setup: the turn never reached custody');
}

/** The API's recovery pass over the world's business, the provider phase after the sweep. */
export async function pass(): ReturnType<typeof passDeployment> {
  const broker = { ...shippedBroker(), audit: callerAudit };
  return await passDeployment(
    s.db.app,
    async (key) => await Promise.resolve(key === 'home' ? s.business : undefined),
    ['home'],
    registerEffectLookup,
    async (database, businessId, unanswered) =>
      await reconcileProviderCalls(database, businessId as BusinessId, broker, unanswered),
  );
}

/** The drops the task's calls carry, read as the task's people read them. */
export const dropsOf = async (taskId: string): Promise<readonly CallDrop[]> =>
  await s.db.app.withBusiness(s.business, async (tx) => await readCallDrops(tx, taskId));

/** The task's model calls, oldest first. */
export const callsOf = async (taskId: string): Promise<readonly Row[]> =>
  await rows<Row>(
    s,
    `select c.id, c.state, c.operation_key, c.drop_cause, c.fault, c.outcome, c.outcome_person_id,
            c.reserved_minor::text as reserved, c.actual_minor::text as actual
       from public.model_calls c
       join public.planned_runs run on run.business_id = c.business_id and run.id = c.run_id
      where c.business_id = $1 and run.task_id = $2 order by c.accepted_at, c.id`,
    [s.business, taskId],
  );

/** The task's attempts, oldest first, with their holds and recorded outcomes. */
export const attemptsOf = async (taskId: string): Promise<readonly Row[]> =>
  await rows<Row>(
    s,
    `select att.id, att.state, att.drop_cause, res.state as held,
            o.outcome as run_outcome, o.end_code
       from public.attempts att
       join public.reservations res on res.business_id = att.business_id and res.id = att.reservation_id
       join public.planned_runs run on run.business_id = att.business_id and run.id = att.run_id
       left join public.run_outcomes o on o.business_id = att.business_id and o.attempt_id = att.id
      where att.business_id = $1 and run.task_id = $2 order by att.created_at, att.id`,
    [s.business, taskId],
  );

/** The outage reports that list the task's runs, and the run's dropped progress events. */
export const toldOf = async (taskId: string): Promise<readonly Row[]> =>
  await rows<Row>(
    s,
    `select r.cause, o.reactivated,
            (select count(*)::int from public.run_events e
              where e.business_id = r.business_id and e.task_id = o.task_id and e.kind = 'dropped'
                and e.detail->>'cause' = r.cause) as progress
       from public.outage_reports r
       join public.outage_runs o on o.business_id = r.business_id and o.outage_id = r.id
      where r.business_id = $1 and o.task_id = $2 order by r.opened_at`,
    [s.business, taskId],
  );
