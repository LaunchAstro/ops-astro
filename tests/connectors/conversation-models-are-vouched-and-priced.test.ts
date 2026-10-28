// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.30's code catalogue of conversation models: only models the server can
// vouch for, each priced by its conversation operation's ceiling (an
// OpenRouter paid model by its own hold, #1508; Hermes Agent, #2270, at
// nothing) and holding
// 0098's id shape; the install's provider follows the composition root's rule;
// and each adapter asks the provider for the exact model it is handed, the
// provider's default when none is.

import { describe, expect, it } from 'vitest';
import {
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_MODELS,
  CONVERSATION_ANSWER,
  CONVERSATION_MODELS,
  conversationModelsOf,
  conversationProviderOf,
  HERMES_CONVERSATION,
  HERMES_MODEL,
  HERMES_PROVIDER,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_DEFAULT_MODEL,
  LOCAL_GPT_PROVIDER,
  localGptAdapter,
  OLLAMA_CONVERSATION,
  OLLAMA_MODELS,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  OPENROUTER_MODELS,
  OPENROUTER_PROVIDER,
  openrouterHoldMinor,
  REPLAY_MODEL_WINDOW,
  replayAdapter,
} from '../../packages/core-connectors/src/index.ts';
import { readModelId } from '../../packages/core-connectors/src/operation.ts';

const modelIn = (body: string): unknown => (JSON.parse(body) as Record<string, unknown>)['model'];

// oxlint-disable-next-line max-lines-per-function -- the catalogue, the provider rule and the adapters
describe('CS-7.30 the conversation model catalogue', () => {
  it('lists only the replay model, the laptop runner’s default, the M5’s Ollama models, OpenRouter’s paid ones, the plan’s two and Hermes Agent, each priced', () => {
    expect(CONVERSATION_MODELS.map((model) => model.id)).toStrictEqual([
      REPLAY_MODEL_WINDOW.model,
      LOCAL_GPT_DEFAULT_MODEL,
      ...OLLAMA_MODELS,
      ...OPENROUTER_MODELS.map((model) => model.id),
      ...CHATGPT_PLAN_MODELS,
      HERMES_MODEL,
    ]);
    const operations = new Map([
      [CONVERSATION_ANSWER.provider, CONVERSATION_ANSWER],
      [LOCAL_GPT_CONVERSATION.provider, LOCAL_GPT_CONVERSATION],
      [OLLAMA_PROVIDER, OLLAMA_CONVERSATION],
      [CHATGPT_PLAN_CONVERSATION.provider, CHATGPT_PLAN_CONVERSATION],
      [HERMES_PROVIDER, HERMES_CONVERSATION],
    ]);
    // #1508: every free provider's model is unpriced; the stand-in's is priced, and refused;
    // OpenRouter's are priced at their own hold, and never offered to a client's conversation.
    const free = CONVERSATION_MODELS.filter(
      (model) =>
        model.provider !== CONVERSATION_ANSWER.provider && model.provider !== OPENROUTER_PROVIDER,
    );
    expect(free.map((model) => model.ceilingMinor)).toStrictEqual(free.map(() => 0));
    for (const model of CONVERSATION_MODELS) {
      expect(readModelId(model.id)).toBe(model.id);
      if (model.provider === OPENROUTER_PROVIDER) continue;
      expect(model.ceilingMinor).toBe(operations.get(model.provider)?.maximumMinor);
    }
    for (const paid of OPENROUTER_MODELS) {
      const listed = conversationModelsOf(OPENROUTER_PROVIDER).find((one) => one.id === paid.id);
      expect(listed).toMatchObject({ ceilingMinor: openrouterHoldMinor(paid), egressName: null });
    }
    expect(conversationModelsOf(LOCAL_GPT_PROVIDER).map((model) => model.reach)).toStrictEqual([
      'cloud',
    ]);
  });

  it('takes the install’s provider by the composition root’s rule', () => {
    expect(conversationProviderOf({})).toBe('replay');
    expect(conversationProviderOf({ OPS_AGENT_PROVIDER: 'local-gpt' })).toBe('replay');
    expect(
      conversationProviderOf({ OPS_AGENT_PROVIDER: 'local-gpt', OPS_ENVIRONMENT: 'local' }),
    ).toBe(LOCAL_GPT_PROVIDER);
  });

  it('each adapter asks for the model it is handed, and its default without one', () => {
    const values = { message: 'hello' };
    expect(modelIn(replayAdapter(values, 'op-1', 'replay-chosen').body)).toBe('replay-chosen');
    expect(modelIn(replayAdapter(values, 'op-1').body)).toBe(REPLAY_MODEL_WINDOW.model);
    expect(modelIn(localGptAdapter(values, 'op-1', 'gpt-chosen').body)).toBe('gpt-chosen');
    expect(modelIn(localGptAdapter(values).body)).toBe(LOCAL_GPT_DEFAULT_MODEL);
    expect(modelIn(ollamaAdapter(values, 'op-1', 'gemma4:31b-mlx').body)).toBe('gemma4:31b-mlx');
    expect(modelIn(ollamaAdapter(values).body)).toBe(OLLAMA_MODELS[0]);
  });
});
