// SPDX-License-Identifier: AGPL-3.0-only
//
// The body custody folds from OpenRouter's stream reads as one answer: its
// text, its units, the model OpenRouter names and the cost it reports. An
// error, an error finish, a cost missing, negative or not a number, and a
// stream custody could not decode each read as no answer, so the call is held.

import { describe, expect, it } from 'vitest';
import { readOpenRouterAnswer } from '../../packages/core-connectors/src/index.ts';

const folded = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  model: 'anthropic/claude-haiku-5.5',
  content: 'Two tasks are due today.',
  finish_reason: 'stop',
  usage: { prompt_tokens: 120, completion_tokens: 12, cost: 0.000_3, ...usage },
  error: null,
  ...over,
});

describe('the folded body', () => {
  it('reads to the text, the units, the model and the reported cost', () => {
    expect(readOpenRouterAnswer(folded())).toStrictEqual({
      text: 'Two tasks are due today.',
      model: 'anthropic/claude-haiku-5.5',
      usage: { inputUnits: 120, outputUnits: 12 },
      providerCode: null,
      reportedCost: { currency: 'USD', amount: 0.000_3 },
    });
  });

  it.each([
    ['an error', folded({ error: { code: 500, message: 'upstream' } })],
    ['an error finish', folded({ finish_reason: 'error' })],
    ['no cost', folded({}, { cost: null })],
    ['a negative cost', folded({}, { cost: -0.01 })],
    ['a cost that is not a number', folded({}, { cost: '0.01' })],
    ['an infinite cost', folded({}, { cost: Number.POSITIVE_INFINITY })],
    ['a stream custody could not decode', folded({ error: 'stream_malformed' })],
    ['no content', folded({ content: null })],
  ])('%s reads as no answer', (_name, body) => {
    expect(readOpenRouterAnswer(body)).toBeUndefined();
  });
});
