// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's plan as a production setting (#2091): only the carried
// deployment, whose custody is the model agent on the M5, takes a
// `chatgpt_plan` route, at most one, cloud and a subscription. With it, its
// broker serves the agent's turn (`model.agent_turn`) and the owner's typed
// message (`model.chatgpt_plan_answer`, #2175's spec) on the plan and nothing
// else, under the plan's own provider key, so the route stays the plan's and
// the owner-started rule (`carriesOnPlan`) still names it. Without one, the turn
// is not catalogued there at all, and no uncarried install takes the route.

import { describe, expect, it } from 'vitest';
import { carriedBroker } from '../../apps/api/model-carriage.ts';
import { carrierSettings, type CarriedSettings } from '../../apps/api/model-carrier.ts';
import { routesOf } from '../../apps/api/model-broker.ts';
import {
  AGENT_TURN_KEY,
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TURN,
} from '../../packages/core-connectors/src/index.ts';
import { PLAN_PROVIDER, type Custody } from '../../packages/core-custody/src/index.ts';

const AGENT = '0c5b9a4e-2f1d-4e6b-8c7a-9d3e1f2a4b5c';
const OWNER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

const ollama = {
  key: 'm5_ollama',
  reach: 'local',
  provider: 'ollama',
  credentialRef: 'carried',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 4,
};
const plan = {
  key: 'chatgpt_plan',
  reach: 'cloud',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialRef: 'carried',
  credentialKind: 'subscription',
  installation: 'here',
  ceiling: 1,
};

const settings = (routes: readonly unknown[]): Record<string, string> => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: AGENT, people: [OWNER] }),
  MODEL_BROKER_ROUTES: JSON.stringify(routes),
  MODEL_BROKER_INSTALLATION: 'here',
});

function carriedOf(routes: readonly unknown[]): CarriedSettings {
  const carried = carrierSettings(settings(routes));
  if (carried.kind !== 'carried') {
    throw new Error(carried.kind === 'invalid' ? carried.problem : 'absent');
  }
  return carried;
}

function refused(routes: readonly unknown[]): string {
  const carried = carrierSettings(settings(routes));
  if (carried.kind !== 'invalid') throw new Error(`not refused: ${carried.kind}`);
  expect(carried.problem).not.toContain(AGENT);
  return carried.problem;
}

describe('the plan route in production settings', () => {
  it('the carried deployment takes one plan route and serves the turn and the typed message on it', () => {
    const carried = carriedOf([ollama, plan]);
    expect(carried.routes).toStrictEqual([ollama, plan]);
    const broker = carriedBroker(carried, {} as Custody);
    expect(broker.operations.get(AGENT_TURN_KEY)?.provider).toBe(PLAN_PROVIDER);
    expect(broker.providers.has(PLAN_PROVIDER)).toBe(true);
    const onPlan = [...broker.operations.values()].filter((op) => op.provider === PLAN_PROVIDER);
    expect(onPlan.map((op) => op.key).toSorted()).toStrictEqual(
      [AGENT_TURN_KEY, CHATGPT_PLAN_CONVERSATION.key].toSorted(),
    );
  });

  it('keeps the plan provider key, so the owner-started rule names the route', () => {
    expect(CHATGPT_PLAN_TURN.provider).toBe(PLAN_PROVIDER);
    expect(CHATGPT_PLAN_TURN.destination).toBe(PLAN_PROVIDER);
  });

  it('serves no turn where no plan route is set', () => {
    const broker = carriedBroker(carriedOf([ollama]), {} as Custody);
    expect(broker.operations.has(AGENT_TURN_KEY)).toBe(false);
  });

  it('refuses a plan route that is local, an API key, or a second one, naming the setting', () => {
    for (const routes of [
      [ollama, { ...plan, reach: 'local' }],
      [ollama, { ...plan, credentialKind: 'api_key' }],
      [ollama, plan, { ...plan, key: 'chatgpt_plan_2' }],
    ]) {
      expect(refused(routes)).toContain('MODEL_BROKER_ROUTES');
    }
  });

  it('refuses two routes sharing a key, carried or not, since a call names its route by key', () => {
    expect(refused([ollama, { ...plan, key: ollama.key }])).toContain('MODEL_BROKER_ROUTES');
    expect(routesOf(JSON.stringify([ollama, { ...ollama, ceiling: 2 }]), 'ollama')).toBeUndefined();
    expect(
      routesOf(JSON.stringify([ollama, { ...ollama, key: 'm5_ollama_2' }]), 'ollama'),
    ).toHaveLength(2);
  });

  it('no uncarried install takes a plan route', () => {
    for (const provider of ['api', 'local-gpt', 'ollama'] as const) {
      expect(routesOf(JSON.stringify([plan]), provider)).toStrictEqual([undefined]);
    }
  });
});
