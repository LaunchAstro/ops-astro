// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { askPlanOnce, planAnswer } from '../../packages/core-custody/src/plan-answer.ts';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import {
  ACCESS,
  REFRESH,
  SECRETS,
  answered,
  completed,
  stream,
} from './fixtures/plan-answer-world.ts';
import { HOUR, T0, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

it('a held opaque three-part token is judged whole, so an echo of its first part is withheld', async () => {
  const w = tempDir();
  try {
    // These random-looking opaque parts are not encoded JSON or a JWT.
    const parts = [ACCESS.slice(0, 12), ACCESS.slice(12, 24), ACCESS.slice(24)];
    const refreshToken = parts.join('.');
    await seed(w.file, {
      state: 'ready',
      tokens: { ...tokens('fresh', T0 + HOUR), accessToken: REFRESH, refreshToken },
    });
    const holder = tokenHolder({
      file: w.file,
      tokenUrl: new URL('http://127.0.0.1:9/oauth/token'),
      now: () => T0,
    });
    expect(await holder.prepare()).toEqual({ ok: true });
    expect(holder.secrets()).toContain(refreshToken);
    const fragment = parts[0] ?? '';
    expect(fragment.length).toBeGreaterThanOrEqual(6);
    const result = planAnswer(
      answered(stream(completed([`upstream echoed ${fragment}`]))),
      holder.secrets(),
    );
    // A plain accidental truncation, with no encoding applied to the echo.
    expect(JSON.stringify(result)).not.toContain(fragment);
    expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' });
  } finally {
    w.done();
  }
});

it('a completed response whose output is not a list is malformed and withheld', () => {
  const response = { ...completed(['fine']), output: 42 };
  expect(planAnswer(answered(stream(response)), SECRETS)).toMatchObject({
    ok: false,
    code: 'SUBSCRIPTION_ANSWER_WITHHELD',
  });
  expect(planAnswer(answered(stream(completed(['fine']))), SECRETS)).toMatchObject({ ok: true });
});

it('a throwing send is called once and withheld without its error text', async () => {
  let calls = 0;
  const result = await askPlanOnce(
    () => {
      calls += 1;
      return Promise.reject(new Error(ACCESS));
    },
    () => SECRETS,
  );
  expect(calls).toBe(1);
  expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' });
  expect(JSON.stringify(result)).not.toContain(ACCESS);
});

it('a fragment of an ordinary opaque token is withheld', () => {
  expect(planAnswer(answered(stream(completed([ACCESS.slice(0, 12)]))), SECRETS)).toMatchObject({
    ok: false,
    code: 'SUBSCRIPTION_ANSWER_WITHHELD',
  });
});

it('a completed response is withheld when any field a reader indexes has the wrong shape', () => {
  const base = completed(['fine']);
  const message = (content: unknown): Record<string, unknown> => ({
    ...base,
    output: [{ type: 'message', role: 'assistant', content }],
  });
  const misshapen: readonly Record<string, unknown>[] = [
    { ...base, id: 7 },
    { ...base, model: null },
    { ...base, output: [42] },
    { ...base, output: [{ role: 'assistant' }] },
    message('fine'),
    message([42]),
    message([{ type: 'output_text', text: 42 }]),
    { ...base, output: [{ type: 'function_call', call_id: 'c', name: 'note', arguments: {} }] },
    { ...base, output: [{ type: 'function_call', call_id: 'c', name: 1, arguments: '{}' }] },
    { ...base, usage: 'many' },
    { ...base, usage: { input_tokens: 1.5, output_tokens: 2, total_tokens: 3 } },
    { ...base, usage: { input_tokens: -1, output_tokens: 2, total_tokens: 1 } },
  ];
  for (const response of misshapen) {
    const kinds: string[] = [];
    const result = planAnswer(answered(stream(response)), SECRETS, (kind) => kinds.push(kind));
    expect(result).toMatchObject({ ok: false, code: 'SUBSCRIPTION_ANSWER_WITHHELD' });
    expect(kinds).toEqual(['plan answer withheld: malformed']);
  }
  const call = { type: 'function_call', call_id: 'c', name: 'note', arguments: '{}' };
  const { usage: _, ...unmetered } = base;
  for (const response of [base, unmetered, { ...base, output: [...(base['output'] as []), call] }])
    expect(planAnswer(answered(stream(response)), SECRETS)).toMatchObject({ ok: true });
});

const part = (text: string): string => Buffer.from(text).toString('base64url');

it('a three-part token is judged on its signature only when its header and claims are JSON with an algorithm', () => {
  const tail = ACCESS.slice(0, 20);
  const shapes = [
    [part('{"typ":"JWT"}'), part('{"sub":"u"}')],
    [part('{"alg":"RS256"}'), part('not json')],
    [part('["alg"]'), part('{"sub":"u"}')],
  ];
  for (const [header = '', claims = ''] of shapes) {
    const held = [header, claims, tail].join('.');
    const echo = `x ${header.slice(0, 8)} y`;
    expect(planAnswer(answered(stream(completed([echo]))), [held])).toMatchObject({
      ok: false,
      code: 'SUBSCRIPTION_ANSWER_WITHHELD',
    });
  }
});
