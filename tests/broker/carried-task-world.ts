// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's call carried to the model agent (#1703), over the broker world's
// business (`broker-world.ts`): the Realtime shim and hub on its database,
// the model agent with its own login on the hub, holding the owner's plan in
// custody's real process (`plan-route-world.ts`), and the hosted side's
// broker over the carried custody, holding no credential. The calling agent
// is the world's, joining with its own token. Every message the hosted side
// sends or hears is kept, for the search for the plan's token. Made-up names
// and tokens only.

import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  catalogue,
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_PATH,
  CHATGPT_PLAN_PROVIDER,
  chatgptPlanBody,
  REPLAY_COMPOSE,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import {
  carriedCustody,
  parseCarryKeys,
  reserveModelCall,
  sendReservedCall,
  type Broker,
  type BrokerRoute,
  type Carriage,
  type Handoff,
  type ModelCallResult,
} from '../../packages/core-custody/src/index.ts';
import { taskHandoff } from '../../packages/core-commands/src/commands/task-carriage.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/index.ts';
import {
  startModelAgent,
  type AgentCustody,
  type ModelAgent,
} from '../../apps/model-agent/carrier.ts';
import { tokenFor } from '../api/fixture.ts';
import { insertAgentActor, insertAgentMapping, insertLogin } from '../identity/fixture.ts';
import { hubCarriage } from '../support/hub-carriage.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { realtimeHub, type RealtimeHub } from '../support/realtime-hub.ts';
import { openPlanRouteWorld, type PlanRouteWorld } from '../custody/fixtures/plan-route-world.ts';
import type { Schedules, Work } from '../runtime/schedules-harness.ts';
import { CLOUD, broker, caller, requestFor, s, stepOf } from './broker-world.ts';

const SHIM = readFileSync(new URL('../support/realtime-shim.sql', import.meta.url), 'utf8');
const POLICY = readFileSync(
  new URL('../../migrations/20261013010300_carry_join_policy.sql', import.meta.url),
  'utf8',
);

/**
 * A task operation on the owner's plan: the task's instruction as the pinned
 * Responses call. A task's call holds more than nothing until it settles, so
 * it holds one minor unit and settles at none.
 */
export const PLAN_TASK: ModelOperationDeclaration = {
  ...CHATGPT_PLAN_CONVERSATION,
  key: 'model.plan_task',
  fields: REPLAY_COMPOSE.fields,
  maximumMinor: 1,
};

export const PLAN: BrokerRoute = {
  ...CLOUD,
  key: 'chatgpt_plan',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialKind: 'subscription',
};

const planTask = (values: Readonly<Record<string, string>>) => ({
  path: CHATGPT_PLAN_PATH,
  method: 'POST' as const,
  body: chatgptPlanBody({
    model: 'gpt-6.1-luna',
    instructions: 'Draft the change the task asks for.',
    input: [{ role: 'user', content: values['instruction'] ?? '' }],
  }),
});

export interface CarriedTaskWorld {
  readonly hub: RealtimeHub;
  readonly plan: PlanRouteWorld;
  readonly agent: ModelAgent;
  /** The model agent's actor: the carrier. */
  readonly carrierAgent: string;
  /** Every message the hosted side sent or heard, as carried. */
  readonly carried: string[];
  /** The broker the hosted side calls with: carried custody, the plan's task operation and route. */
  readonly broker: Broker;
  /** The calling agent, as the door verified it, with its own session. */
  readonly presented: VerifiedSubject;
  readonly token: string;
  /** What runs while the model agent prepares, before it accepts; a case sets it. */
  duringPrepare: () => Promise<void>;
  /** What runs once the send judgement has passed, its locks held, before the send is written. */
  duringFence: () => Promise<void>;
  /** A code the model agent refuses with once it has reported the write; a case sets it. */
  refusesAfterWrite: string | undefined;
  close(): Promise<void>;
}

/** A carriage that keeps every message its lines send or hear. */
function tapped(carriage: Carriage, carried: string[]): Carriage {
  return {
    join: async (topic, accessToken) => {
      const joined = await carriage.join(topic, accessToken);
      if (!joined.ok) return joined;
      const { line } = joined;
      line.hear((event, message) => carried.push(`${event} ${JSON.stringify(message)}`));
      return {
        ok: true,
        line: {
          ...line,
          send: async (event, message) => {
            carried.push(`${event} ${JSON.stringify(message)}`);
            return await line.send(event, message);
          },
        },
      };
    },
  };
}

/** The world's person, who creates and starts every task here, holding `role` from now on. */
export async function holdsRole(role: 'owner' | 'member', of: Schedules = s): Promise<void> {
  await of.db.admin.execute(
    `update public.memberships set active = false, ended_at = clock_timestamp()
      where business_id = $1 and person_id = $2 and active`,
    [of.business, of.decider.personId],
  );
  await of.db.admin.execute(
    `insert into public.memberships (business_id, id, person_id, role_key, active, joined_at)
     values ($1, $2, $3, $4, true, clock_timestamp())`,
    [of.business, randomUUID(), of.decider.personId, role],
  );
}

function adminUrlOf(name: string): string {
  const server = databaseUrlFromEnvironment();
  if (server === undefined) throw new Error('no database server');
  const url = new URL(server);
  url.pathname = `/${name}`;
  return url.toString();
}

// oxlint-disable-next-line max-lines-per-function -- the hub, the agent and its custody, made once
export async function openCarriedTaskWorld(): Promise<CarriedTaskWorld> {
  await s.db.admin.transaction(async (execute) => {
    await execute(SHIM);
    await execute(POLICY.slice(POLICY.indexOf('do $$')));
  });
  const hub = await realtimeHub(adminUrlOf(s.db.name));
  const key = randomBytes(32).toString('base64url');
  const parsed = parseCarryKeys(key);
  if (!parsed.ok) throw new Error('carry key refused');
  const carrierSub = `model-agent-${randomUUID()}`;
  const carrierAgent = await s.db.app.withBusiness(s.business, async (tx) => {
    const actor = await insertAgentActor(tx);
    await insertAgentMapping(tx, await insertLogin(tx, carrierSub), actor, s.decider.actorId);
    return actor;
  });
  await holdsRole('owner');
  const plan = await openPlanRouteWorld();
  const box = {
    duringPrepare: async (): Promise<void> => {},
    duringFence: async (): Promise<void> => {},
    refusesAfterWrite: undefined as string | undefined,
  };
  const paused = (custody: AgentCustody): AgentCustody => ({
    ...custody,
    dispatch: async (request, gate, onPiece) => {
      const code = box.refusesAfterWrite;
      if (code === undefined) return await custody.dispatch(request, gate, onPiece);
      gate.onWritten();
      return { kind: 'refused', started: false, code };
    },
    prepare: async () => {
      await box.duringPrepare();
      return await (custody.prepare?.() ?? Promise.resolve({ ok: true }));
    },
  });
  const carrierToken = await tokenFor(carrierSub);
  const agent = await startModelAgent({
    carriage: hubCarriage(hub),
    keys: parsed.keys,
    key,
    business: s.business,
    agent: carrierAgent,
    token: async () => await Promise.resolve(carrierToken),
    custody: paused(plan.agentCustody),
  });
  if ('because' in agent) throw new Error(`the model agent did not start: ${agent.because}`);
  const carried: string[] = [];
  const custody = carriedCustody({
    carriage: tapped(hubCarriage(hub), carried),
    keys: parsed.keys,
    key,
  });
  return {
    hub,
    plan,
    agent,
    carrierAgent,
    carried,
    broker: {
      ...broker,
      custody,
      operations: catalogue([PLAN_TASK]),
      providers: new Map([[CHATGPT_PLAN_PROVIDER, { build: planTask, price: () => 0 }]]),
      routes: [PLAN],
      carrier: { agent: carrierAgent, people: [s.decider.personId] },
    },
    presented: { ...s.agent, sessionId: randomUUID() },
    token: await tokenFor(s.agent.subject),
    get duringPrepare() {
      return box.duringPrepare;
    },
    set duringPrepare(next) {
      box.duringPrepare = next;
    },
    get duringFence() {
      return box.duringFence;
    },
    set duringFence(next) {
      box.duringFence = next;
    },
    get refusesAfterWrite() {
      return box.refusesAfterWrite;
    },
    set refusesAfterWrite(next) {
      box.refusesAfterWrite = next;
    },
    close: async () => {
      await agent.stop();
      await plan.close();
      await hub.close();
    },
  };
}

/** The run's call on the plan, carried by the calling agent with its own token. */
export async function carriedCall(
  world: CarriedTaskWorld,
  work: Work,
  on: Broker = world.broker,
): Promise<ModelCallResult> {
  await stepOf(work);
  const request = requestFor(work, {
    operation: PLAN_TASK.key,
    fields: [{ name: 'instruction', from: { recordId: work.taskId, key: 'title' } }],
  });
  const asking = caller(work);
  const reserving = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, asking, request, on),
  );
  if (!reserving.ok) {
    const { refusal: _refusal, ...result } = reserving;
    return result;
  }
  const { reserved } = reserving;
  const handoff =
    on.carrier === undefined
      ? undefined
      : taskHandoff(s.db.app, s.business, world.presented, world.token, {
          caller: asking,
          request,
          carrier: on.carrier,
          broker: on,
          timeoutMs: reserved.operation.timeoutMs,
        });
  const carry =
    handoff === undefined
      ? undefined
      : (callId: string): Handoff => {
          const real = handoff(callId);
          return {
            ...real,
            fence: async (accept) => {
              const fenced = await real.fence(accept);
              if (fenced.ok) await world.duringFence();
              return fenced;
            },
          };
        };
  return await sendReservedCall(s.db.app, s.business, asking, request, reserved, on, carry);
}
