// SPDX-License-Identifier: AGPL-3.0-only
//
// The side chat's plan models (#2175): read from the route's own admit list
// (`CHATGPT_PLAN_MODELS`, the list the M5 checks a plan call against), never
// a list of guesses; cloud, unpriced and named by no client's setting, so no
// client's conversation is ever offered one. They answer on the plan's
// conversation operation, catalogued beside the agent's turn only where the
// carried deployment has the plan's route, under the one adapter the plan's
// provider key holds, which builds a typed message as the pinned call for the
// model chosen, and the M5's request check admits it unchanged.

import { describe, expect, it } from 'vitest';
import {
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_MODELS,
  CHATGPT_PLAN_PROVIDER,
  CONVERSATION_MODELS,
  conversationOperationOf,
  planRouteSet,
} from '../../packages/core-connectors/src/index.ts';
import { AGENT_TURN_KEY } from '../../packages/core-connectors/src/replay-adapter.ts';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';
import { chatOf } from '../../apps/model-agent/request-check.ts';

const PLAN_ROUTE = {
  key: 'chatgpt_plan',
  reach: 'cloud',
  provider: CHATGPT_PLAN_PROVIDER,
  credentialRef: 'carried',
  credentialKind: 'subscription',
  installation: 'here',
  ceiling: 1,
};
const OLLAMA_ROUTE = { ...PLAN_ROUTE, key: 'm5_ollama', reach: 'local', provider: 'ollama' };

const carried = (routes: readonly object[]): Record<string, string> => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: '{"agent":"x","people":["y"]}',
  MODEL_BROKER_ROUTES: JSON.stringify(routes),
});

// oxlint-disable-next-line max-lines-per-function -- the list, the route, the catalogue and the M5's check
describe('the plan models in the side chat', () => {
  it('lists exactly the route’s admit list, cloud, unpriced and for internal work only', () => {
    const plan = CONVERSATION_MODELS.filter((model) => model.provider === CHATGPT_PLAN_PROVIDER);
    expect(plan.map((model) => model.id)).toStrictEqual([...CHATGPT_PLAN_MODELS]);
    for (const model of plan) {
      expect(model).toMatchObject({ reach: 'cloud', ceilingMinor: 0, egressName: null });
    }
    expect(conversationOperationOf(CHATGPT_PLAN_PROVIDER)).toBe(CHATGPT_PLAN_CONVERSATION.key);
  });

  it('knows the plan route only where the carried deployment names one', () => {
    expect(planRouteSet(carried([OLLAMA_ROUTE, PLAN_ROUTE]))).toBe(true);
    expect(planRouteSet(carried([OLLAMA_ROUTE]))).toBe(false);
    expect(planRouteSet({ ...carried([OLLAMA_ROUTE, PLAN_ROUTE]), MODEL_BROKER_CARRIER: '' })).toBe(
      false,
    );
    expect(planRouteSet({ ...carried([PLAN_ROUTE]), OPS_AGENT_PROVIDER: 'api' })).toBe(false);
    expect(planRouteSet({ ...carried([]), MODEL_BROKER_ROUTES: 'not json' })).toBe(false);
  });

  it('catalogues the conversation beside the turn, one adapter picking by field, only with the plan', () => {
    const without = catalogueOf('ollama', false, false);
    expect(without.operations.has(CHATGPT_PLAN_CONVERSATION.key)).toBe(false);
    const { operations, providers } = catalogueOf('ollama', false, true);
    expect(operations.get(CHATGPT_PLAN_CONVERSATION.key)?.provider).toBe(CHATGPT_PLAN_PROVIDER);
    expect(operations.get(AGENT_TURN_KEY)?.provider).toBe(CHATGPT_PLAN_PROVIDER);
    const adapter = providers.get(CHATGPT_PLAN_PROVIDER);
    if (adapter === undefined) throw new Error('no plan adapter');
    for (const model of CHATGPT_PLAN_MODELS) {
      const built = adapter.build({ message: 'What is due today?' }, 'call-1', model, false);
      const body = JSON.parse(built.body) as Record<string, unknown>;
      expect(body['model']).toBe(model);
      expect(body['tools']).toBeUndefined();
      expect(body['input']).toEqual([{ role: 'user', content: 'What is due today?' }]);
      const request = {
        destination: CHATGPT_PLAN_PROVIDER,
        path: built.path,
        method: built.method,
        body: built.body,
        timeoutMs: CHATGPT_PLAN_CONVERSATION.timeoutMs,
        maxResponseBytes: CHATGPT_PLAN_CONVERSATION.maxResponseBytes,
      };
      expect(chatOf(request)).toBe(request);
    }
    const turn = JSON.stringify([{ role: 'user', text: 'Read the task.' }]);
    const asTurn = JSON.parse(adapter.build({ turn, tools: '[]' }, 'call-2').body) as {
      instructions: string;
    };
    expect(asTurn.instructions).toContain('working one task');
  });

  it('sends no input for a model outside the admit list, which the M5 refuses', () => {
    const adapter = catalogueOf('ollama', false, true).providers.get(CHATGPT_PLAN_PROVIDER);
    const built = adapter?.build({ message: 'Hi' }, 'call-3', 'gpt-made-up', false);
    const request = {
      destination: CHATGPT_PLAN_PROVIDER,
      path: built?.path,
      method: built?.method,
      body: built?.body,
      timeoutMs: CHATGPT_PLAN_CONVERSATION.timeoutMs,
      maxResponseBytes: CHATGPT_PLAN_CONVERSATION.maxResponseBytes,
    };
    expect(chatOf(request)).toBeUndefined();
  });
});
