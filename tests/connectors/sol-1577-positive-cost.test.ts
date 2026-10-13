// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import {
  openrouterCostMinor,
  readOpenRouterAnswer,
} from '../../packages/core-connectors/src/openrouter.ts';

it('Sol proof, criterion 1: a positive reported paid cost cannot become a zero-cent charge', () => {
  const answer = readOpenRouterAnswer({
    model: 'anthropic/claude-haiku-5.5',
    content: 'A paid answer.',
    finish_reason: 'stop',
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 1e-16 },
    error: null,
  });
  expect(answer).toBeDefined();
  if (answer === undefined) throw new Error('the provider cost was refused');
  expect(openrouterCostMinor(answer)).toBeGreaterThanOrEqual(1);
});

it('Sol proof, criterion 1: a reported cost above one AUD cent must round up to two', () => {
  const answer = readOpenRouterAnswer({
    model: 'anthropic/claude-haiku-5.5',
    content: 'A paid answer.',
    finish_reason: 'stop',
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0062500000000001 },
    error: null,
  });
  expect(answer).toBeDefined();
  if (answer === undefined) throw new Error('the provider cost was refused');
  // USD 0.00625 is exactly one AUD cent at the adapter's fixed 1.60 rate.
  expect(openrouterCostMinor(answer)).toBe(2);
});
