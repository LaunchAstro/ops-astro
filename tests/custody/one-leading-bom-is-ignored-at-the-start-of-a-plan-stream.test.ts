// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { planAnswer } from '../../packages/core-custody/src/plan-answer.ts';
import { SECRETS, answered, completed } from './fixtures/plan-answer-world.ts';

it('a valid data-only stream still completes after one leading BOM', () => {
  const response = completed(['The answer is ready.']);
  const body = `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
  expect(planAnswer(answered(body), SECRETS)).toEqual({ ok: true, response });
  // U+FEFF is the decoded UTF-8 BOM, which an SSE reader ignores at stream start.
  expect(planAnswer(answered(`\uFEFF${body}`), SECRETS)).toEqual({ ok: true, response });
});

it('a leading BOM cannot hide a failed event name from the completed-data check', () => {
  const response = completed(['This must be withheld.']);
  const body = `event: response.failed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
  const withheld = { ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' };
  expect(planAnswer(answered(body), SECRETS)).toMatchObject(withheld);
  expect(planAnswer(answered(`\uFEFF${body}`), SECRETS)).toMatchObject(withheld);
});

it('only one leading BOM is ignored: a second hides the first field, and the stream is withheld', () => {
  const response = completed(['The answer is ready.']);
  const body = `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
  expect(planAnswer(answered(`\uFEFF\uFEFF${body}`), SECRETS)).toMatchObject({
    ok: false,
    code: 'SUBSCRIPTION_ANSWER_WITHHELD',
  });
});
