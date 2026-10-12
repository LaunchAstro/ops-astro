// SPDX-License-Identifier: AGPL-3.0-only
//
// CS-7.30's code catalogue of conversation models: only models the server can
// vouch for, each priced by its conversation operation's ceiling and holding
// 0098's id shape; the install's provider follows the composition root's rule;
// and each adapter asks the provider for the exact model it is handed, the
// provider's default when none is.

import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_ANSWER,
  CONVERSATION_MODELS,
  conversationModelsOf,
  conversationProviderOf,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_DEFAULT_MODEL,
  LOCAL_GPT_PROVIDER,
  localGptAdapter,
  OLLAMA_CONVERSATION,
  OLLAMA_MODELS,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  REPLAY_MODEL_WINDOW,
  replayAdapter,
} from '../../packages/core-connectors/src/index.ts';
import { readModelId } from '../../packages/core-connectors/src/operation.ts';

const modelIn = (body: string): unknown => (JSON.parse(body) as Record<string, unknown>)['model'];

describe('CS-7.30 the conversation model catalogue', () => {
  it('lists only the replay model, the laptop runner’s default and the M5’s Ollama models, each priced', () => {
    expect(CONVERSATION_MODELS.map((model) => model.id)).toStrictEqual([
      REPLAY_MODEL_WINDOW.model,
      LOCAL_GPT_DEFAULT_MODEL,
      ...OLLAMA_MODELS,
    ]);
    const operations = new Map([
      [CONVERSATION_ANSWER.provider, CONVERSATION_ANSWER],
      [LOCAL_GPT_CONVERSATION.provider, LOCAL_GPT_CONVERSATION],
      [OLLAMA_PROVIDER, OLLAMA_CONVERSATION],
    ]);
    // #1508, option B: every conversation model is unpriced.
    expect(CONVERSATION_MODELS.map((model) => model.ceilingMinor)).toStrictEqual(
      CONVERSATION_MODELS.map(() => 0),
    );
    for (const model of CONVERSATION_MODELS) {
      expect(readModelId(model.id)).toBe(model.id);
      expect(model.ceilingMinor).toBe(operations.get(model.provider)?.maximumMinor);
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
