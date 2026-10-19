// SPDX-License-Identifier: AGPL-3.0-only
//
// One key, one route (#2091, Sol's proof S2116-2, copied): a call names its
// route by key alone, and the carried send looks the route up by that key
// after the model agent's prepare (`lockCarriedTask`). Were the Ollama route
// and the owner's plan route under one key, that judgement would read the
// local route while the turn still went to the plan, so a task made outside
// during the prepare would reach the cloud. The carried deployment refuses
// such a setting at start, and with distinct keys the same change sends
// nothing and answers `LOCAL_MODEL_REQUIRED`. The send's recheck also reads
// the route by key and the operation's provider, so even a broker holding two
// routes under one key judges the plan route it sends on.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carrierSettings } from '../../apps/api/model-carrier.ts';
import { carriedBroker } from '../../apps/api/model-carriage.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { openCarriedTaskWorld, type CarriedTaskWorld } from './carried-task-world.ts';
import { carriedTurn } from './carried-turn-world.ts';

useBrokerWorld('routekeys');
let world: CarriedTaskWorld;
beforeAll(async () => {
  if (!noDatabase) world = await openCarriedTaskWorld();
}, 180_000);
afterAll(async () => {
  await world?.close();
});

const route = (key: string, local: boolean) => ({
  key,
  reach: local ? 'local' : 'cloud',
  provider: local ? 'ollama' : 'chatgpt_plan',
  credentialRef: 'carried',
  credentialKind: local ? 'api_key' : 'subscription',
  installation: 'here',
  ceiling: local ? 4 : 1,
});

const settings = (localKey: string, planKey: string) => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: world.carrierAgent, people: [s.decider.personId] }),
  MODEL_BROKER_INSTALLATION: 'here',
  MODEL_BROKER_ROUTES: JSON.stringify([route(localKey, true), route(planKey, false)]),
});

/** The turn on the plan under these keys, with an agent write making the task outside in the prepare. */
async function madeOutsideInThePrepare(localKey: string, planKey: string, rekeyed?: string) {
  const carried = carrierSettings(settings(localKey, planKey));
  if (carried.kind !== 'carried') return { refusedAtStart: true, sent: 0 };
  const routes = carried.routes.map((one) => ({ ...one, key: rekeyed ?? one.key }));
  const broker = {
    ...world.broker,
    ...carriedBroker({ ...carried, routes }, world.broker.custody),
  };
  const work = await liveWork(s, `Task ${randomUUID()}`, 2_000);
  let changed = false;
  world.duringPrepare = async () => {
    if (changed) return;
    changed = true;
    await s.db.admin.execute(
      `insert into public.operations (business_id, id, operation_id, actor_id, command, record_id, outcome, payload_digest, result)
       values ($1, gen_random_uuid(), $2, $3, 'task.update', $4, 'applied', repeat('0', 64), '{}')`,
      [s.business, randomUUID(), s.agentActorId, work.taskId],
    );
  };
  const start = world.plan.sent.length;
  try {
    const answer = await carriedTurn(world, work, broker);
    return { refusedAtStart: false, sent: world.plan.sent.length - start, changed, answer };
  } finally {
    world.duringPrepare = async () => {};
  }
}

describe.skipIf(noDatabase)('a route is named by its key alone', () => {
  it('with distinct keys, a task made outside during the prepare sends nothing', async () => {
    expect(await madeOutsideInThePrepare('m5_ollama', 'chatgpt_plan')).toMatchObject({
      refusedAtStart: false,
      changed: true,
      sent: 0,
      answer: { ok: false, reason: 'LOCAL_MODEL_REQUIRED' },
    });
  }, 60_000);

  it('a broker holding both routes under one key judges the plan route and sends nothing', async () => {
    expect(await madeOutsideInThePrepare('m5_ollama', 'chatgpt_plan', 'shared')).toMatchObject({
      refusedAtStart: false,
      changed: true,
      sent: 0,
      answer: { ok: false, reason: 'LOCAL_MODEL_REQUIRED' },
    });
  }, 60_000);

  it('a plan route under the local route key is refused at start and sends nothing', async () => {
    expect(await madeOutsideInThePrepare('shared', 'shared')).toStrictEqual({
      refusedAtStart: true,
      sent: 0,
    });
  }, 60_000);
});
