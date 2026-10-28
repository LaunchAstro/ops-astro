// SPDX-License-Identifier: AGPL-3.0-only
//
// #2270: custody decodes Hermes Agent's stream as it does OpenRouter's and
// folds it into one body. A finished answer reads as the reply, priced at
// nothing; an error, any finish but `stop`, a stream custody could not decode
// and no text each read as no answer, so the call is held.

import { describe, expect, it } from 'vitest';
import { hermesCostMinor, readHermesAnswer } from '../../packages/core-connectors/src/index.ts';

const folded = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  model: 'hermes-agent',
  content: 'The second venue is booked for Friday.',
  finish_reason: 'stop',
  usage: { prompt_tokens: 220, completion_tokens: 14, cost: null, ...usage },
  error: null,
  ...over,
});

describe('a folded Hermes answer', () => {
  it('reads to the text, the units and the model, at no price', () => {
    const answer = readHermesAnswer(folded());
    expect(answer).toStrictEqual({
      text: 'The second venue is booked for Friday.',
      model: 'hermes-agent',
      usage: { inputUnits: 220, outputUnits: 14 },
      providerCode: null,
    });
    expect(answer === undefined ? Number.NaN : hermesCostMinor(answer)).toBe(0);
  });

  it('reads with no units where the stream reported none', () => {
    const answer = readHermesAnswer(folded({}, { prompt_tokens: null, completion_tokens: null }));
    expect(answer?.usage).toStrictEqual({ inputUnits: 0, outputUnits: 0 });
  });

  it.each([
    ['an error', folded({ error: { message: 'upstream' } })],
    ['an error finish', folded({ finish_reason: 'error' })],
    ['a cancelled run', folded({ finish_reason: 'cancelled' })],
    ['a run out of its iteration budget', folded({ finish_reason: 'length' })],
    ['no finish', folded({ finish_reason: null })],
    ['a stream custody could not decode', folded({ error: 'stream_malformed' })],
    ['no content', folded({ content: null })],
    ['empty content', folded({ content: '' })],
    ['a model out of shape', folded({ model: 'two words' })],
    ['negative units', folded({}, { prompt_tokens: -1 })],
    ['not a body', 'text'],
  ])('%s reads as no answer', (_name, body) => {
    expect(readHermesAnswer(body)).toBeUndefined();
  });
});
