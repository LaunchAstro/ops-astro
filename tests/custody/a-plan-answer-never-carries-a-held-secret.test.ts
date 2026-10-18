// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P3: a plan answer never carries a held secret. The Responses stream
// is folded to its completed response and judged against the holder's
// secrets: a secret split across delta events is caught where the completed
// response joins it, and a secret cut into short pieces and scattered in
// another order (output parts, a tool call's arguments, a key, a number,
// percent-escaped or base64) withholds the whole answer. Nothing of either
// secret reaches the returned structure, the log or a thrown error.

import { expect, it } from 'vitest';
import {
  FRAGMENT_RUN,
  planAnswer,
  type PlanAnswerLog,
} from '../../packages/core-custody/src/plan-answer.ts';
import {
  ACCESS,
  REFRESH,
  SECRETS,
  answered,
  completed,
  runsIn,
  scrambled,
  stream,
} from './fixtures/plan-answer-world.ts';

/** The answer's result and its log, each written out, with nothing of a secret in either. */
function judged(body: string): {
  readonly result: ReturnType<typeof planAnswer>;
  readonly log: readonly PlanAnswerLog[];
} {
  const log: PlanAnswerLog[] = [];
  const result = planAnswer(answered(body), SECRETS, (kind) => log.push(kind));
  expect(runsIn(JSON.stringify(result))).toEqual([]);
  expect(runsIn(JSON.stringify(log))).toEqual([]);
  return { result, log };
}

const withheld = { ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' };

it('passes a clean completed answer through whole, so the rule is no blanket refusal', () => {
  const { result, log } = judged(
    stream(completed(['The sky is blue ', 'over Townsville today.']), ['The sky', ' is blue ']),
  );
  expect(result.ok).toBe(true);
  expect(JSON.stringify(result)).toContain('over Townsville today.');
  expect(log).toEqual(['plan answer completed']);
});

it('redacts a secret the completed response joins from two delta events', () => {
  const half = ACCESS.length / 2;
  const { result } = judged(
    stream(completed([`token ${ACCESS} echoed`]), [
      `token ${ACCESS.slice(0, half)}`,
      `${ACCESS.slice(half)} echoed`,
    ]),
  );
  expect(result).toMatchObject({ ok: true });
  expect(JSON.stringify(result)).toContain('token [redacted] echoed');
});

it('withholds a secret split between output parts in order, however short the pieces', () => {
  for (const size of [1, 3, FRAGMENT_RUN - 1]) {
    const pieces = Array.from({ length: Math.ceil(ACCESS.length / size) }, (_, at) =>
      ACCESS.slice(at * size, at * size + size),
    );
    const { result, log } = judged(stream(completed(pieces)));
    expect(result).toMatchObject(withheld);
    expect(log).toEqual(['plan answer withheld: secret fragment']);
  }
});

it(`withholds pieces of ${FRAGMENT_RUN} characters scattered out of order`, () => {
  const pieces = scrambled(REFRESH, FRAGMENT_RUN);
  const spread = completed(pieces.map((piece, at) => (at % 2 === 0 ? `${piece} ` : ` ${piece}`)));
  expect(judged(stream(spread)).result).toMatchObject(withheld);
});

it('withholds one such piece wherever it sits and however it is spelled', () => {
  const piece = REFRESH.slice(7, 7 + FRAGMENT_RUN);
  const escaped = [...Buffer.from(piece)].map((byte) => `%${byte.toString(16)}`).join('');
  const places: readonly Record<string, unknown>[] = [
    completed(['one', `two ${piece} three`]),
    completed(['plain'], [{ type: 'function_call', name: 'note', arguments: `{"x":"${piece}"}` }]),
    { ...completed(['plain']), [piece]: true },
    completed([`see ${escaped}`]),
    completed([Buffer.from(piece).toString('base64')]),
    completed([Buffer.from(piece).toString('base64url')]),
  ];
  for (const response of places) {
    const { result, log } = judged(stream(response));
    expect(result).toMatchObject(withheld);
    expect(log).toEqual(['plan answer withheld: secret fragment']);
  }
});

it('judges a number by its text: a whole secret is redacted, a piece withholds', () => {
  const digits = '9081726354';
  const whole = planAnswer(
    answered(stream({ ...completed(['ok']), usage: { total_tokens: Number(digits) } })),
    [digits],
  );
  expect(whole.ok).toBe(true);
  expect(JSON.stringify(whole)).not.toContain(digits);
  const piece = planAnswer(
    answered(stream({ ...completed(['ok']), usage: { total_tokens: 817_263 } })),
    [digits],
  );
  expect(piece).toMatchObject(withheld);
});

it('withholds every answer when it is given no secret to judge against', () => {
  const log: PlanAnswerLog[] = [];
  expect(
    planAnswer(answered(stream(completed(['hello']))), [], (kind) => log.push(kind)),
  ).toMatchObject(withheld);
  expect(log).toEqual(['plan answer withheld: no secret to judge']);
});
