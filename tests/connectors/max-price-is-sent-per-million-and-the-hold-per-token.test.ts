// SPDX-License-Identifier: AGPL-3.0-only
//
// The request OpenRouter is sent is pinned: exactly the declared keys, the
// model asked for, `max_price` equal to the declared per-million strings, a
// fixed `max_tokens`, usage included, no data collection and no fallback.
// The hold is the most a reply can cost, worked here independently from the
// per-million figures: every input token the body can hold and every output
// token, at the fixed rate, rounded up to a cent.

import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_BODY_LIMIT,
  OPENROUTER_CONVERSATION,
  OPENROUTER_MAX_TOKENS,
  OPENROUTER_MODELS,
  openrouterHoldMinor,
  openrouterRequest,
} from '../../packages/core-connectors/src/index.ts';

const [haiku] = OPENROUTER_MODELS;

// oxlint-disable-next-line max-lines-per-function -- the request, its hold and a refusal
describe('the pinned request and its hold', () => {
  it('sends max_price per million as declared, and nothing to widen the charge', () => {
    if (haiku === undefined) throw new Error('no model');
    const built = openrouterRequest({ message: 'What is due?' }, 'call-1', haiku.id);
    const body = JSON.parse(built.body) as Record<string, unknown>;
    expect(built.path).toBe('/api/v1/chat/completions');
    expect(Object.keys(body).toSorted()).toStrictEqual([
      'max_tokens',
      'messages',
      'model',
      'provider',
      'stream',
      'usage',
    ]);
    expect(body).toMatchObject({
      model: haiku.id,
      stream: true,
      max_tokens: 2_048,
      usage: { include: true },
      provider: {
        max_price: { prompt: '0.1', completion: '0.5' },
        data_collection: 'deny',
        allow_fallbacks: false,
      },
    });
    expect(Object.keys(body['provider'] as object).toSorted()).toStrictEqual([
      'allow_fallbacks',
      'data_collection',
      'max_price',
    ]);
  });

  it('holds the most from the per-million figures, rounded up', () => {
    if (haiku === undefined) throw new Error('no model');
    const input = OPENROUTER_BODY_LIMIT + 256;
    const output = OPENROUTER_MAX_TOKENS;
    const usd =
      (input * Number(haiku.promptPerMillion)) / 1e6 +
      (output * Number(haiku.completionPerMillion)) / 1e6;
    const expected = Math.ceil(usd * 1.6 * 100 - 1e-9);
    expect(openrouterHoldMinor(haiku)).toBe(expected);
    expect(OPENROUTER_CONVERSATION.maximumMinor).toBe(expected);
    // At an illustrative US$1 and US$5 a million, the design's ten cents.
    expect(
      openrouterHoldMinor({ ...haiku, promptPerMillion: '1', completionPerMillion: '5' }),
    ).toBe(10);
  });

  it('refuses a model it does not register', () => {
    expect(() => openrouterRequest({ message: 'x' }, 'call-1', 'openai/gpt-6.1')).toThrow();
  });
});
