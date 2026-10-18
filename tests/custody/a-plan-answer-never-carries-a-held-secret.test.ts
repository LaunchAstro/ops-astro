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

/** Whole usage counts with this total. */
const usage = (total: number): Record<string, number> => ({
  input_tokens: 1,
  output_tokens: 2,
  total_tokens: total,
});

it('judges a number by its text: a whole secret is redacted, a count that spells one or a piece withholds', () => {
  const digits = '9081726354';
  const whole = planAnswer(answered(stream({ ...completed(['ok']), seen: Number(digits) })), [
    digits,
  ]);
  expect(whole.ok).toBe(true);
  expect(JSON.stringify(whole)).not.toContain(digits);
  const counted = planAnswer(
    answered(stream({ ...completed(['ok']), usage: usage(Number(digits)) })),
    [digits],
  );
  expect(counted).toMatchObject(withheld);
  expect(JSON.stringify(counted)).not.toContain(digits);
  const piece = planAnswer(answered(stream({ ...completed(['ok']), usage: usage(817_263) })), [
    digits,
  ]);
  expect(piece).toMatchObject(withheld);
});

it('withholds every answer when it is given no secret to judge against', () => {
  const log: PlanAnswerLog[] = [];
  expect(
    planAnswer(answered(stream(completed(['hello']))), [], (kind) => log.push(kind)),
  ).toMatchObject(withheld);
  expect(log).toEqual(['plan answer withheld: no secret to judge']);
});

it('withholds a secret split in order across differently named fields', () => {
  const split = { ...completed(['plain']), a: ACCESS.slice(0, 4), b: ACCESS.slice(4, 9) };
  expect(judged(stream(split)).result).toMatchObject(withheld);
});

const part = (text: string): string => Buffer.from(text).toString('base64url');

it("judges a signed token by its signature, so another token's public header passes", () => {
  // Built here, part by part, so no token-shaped text sits in the source.
  const header = part('{"alg":"RS256","typ":"JWT"}');
  const signature = part('FOPwlLsrmsGWy5dVqzhbtbMZN8VAKxdmNpRt');
  const signed = [header, part('{"https://api.openai.com/auth":{"user_id":"u"}}'), signature].join(
    '.',
  );
  const another = [header, part('{"sub":"1234567890"}'), part('signature')].join('.');
  const example = `${another} and ${Buffer.from('https://example.com/callback').toString('base64')}`;
  expect(planAnswer(answered(stream(completed([example]))), [signed])).toMatchObject({ ok: true });
  const piece = signature.slice(10, 10 + FRAGMENT_RUN);
  expect(planAnswer(answered(stream(completed([`x ${piece} y`]))), [signed])).toMatchObject(
    withheld,
  );
  const whole = planAnswer(answered(stream(completed([`echo ${signed}`]))), [signed]);
  expect(JSON.stringify(whole)).not.toContain(signature.slice(0, FRAGMENT_RUN));
});

it('withholds three-character pieces scattered through one string, and two-character pieces encoded one by one', () => {
  const pieces = scrambled(REFRESH, 3);
  expect(judged(stream(completed([`notes: ${pieces.join(', ')}.`]))).result).toMatchObject(
    withheld,
  );
  const encoded = Array.from({ length: REFRESH.length / 2 }, (_, at) =>
    Buffer.from(REFRESH.slice(at * 2, at * 2 + 2)).toString('base64'),
  );
  expect(judged(stream(completed(encoded))).result).toMatchObject(withheld);
  const scattered = pieces.map((piece) => Buffer.from(piece).toString('base64'));
  expect(judged(stream(completed(scattered))).result).toMatchObject(withheld);
});

it('passes a long ordinary answer whatever chance pieces of a secret it holds', () => {
  const prose = Array.from(
    { length: 400 },
    (_, at) =>
      `Step ${at}: run pnpm test, read the log at line ${at * 7}, then fix it (id ${(at * 7919).toString(36)}).`,
  );
  const code = Array.from({ length: 200 }, (_, at) => `const v${at} = f${at % 9}(x, ${at});`);
  expect(planAnswer(answered(stream(completed([...prose, ...code]))), SECRETS)).toMatchObject({
    ok: true,
  });
});
