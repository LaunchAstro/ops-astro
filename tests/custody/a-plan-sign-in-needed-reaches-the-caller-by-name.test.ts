// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P3: when the holder cannot present a token, the caller gets a named
// result with words a task can show. A spent or absent
// token file is `SUBSCRIPTION_SIGN_IN_NEEDED`, read from a real holder; each
// other holder refusal has its own words.

import { afterEach, expect, it } from 'vitest';
import { PLAN_WORDS, planRefused } from '../../packages/core-custody/src/plan-words.ts';
import { tokenHolder, type PlanRefusal } from '../../packages/core-custody/src/plan-token.ts';
import { seed, tempDir } from './fixtures/plan-token-world.ts';

const worlds: { done(): void }[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.done();
});
const world = () => {
  const w = tempDir();
  worlds.push(w);
  return w;
};

/** A holder on its own file; its issuer address is never reached. */
const holderOn = (file: string) =>
  tokenHolder({ file, tokenUrl: new URL('http://127.0.0.1:9/oauth/token') });

it('names a spent token file to the caller, with words', async () => {
  const w = world();
  await seed(w.file, { state: 'spent', subject: 'synthetic-subject-a' });
  const prepared = await holderOn(w.file).prepare();
  expect(prepared).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  const result = prepared.ok ? undefined : planRefused(prepared.code);
  expect(result).toEqual({
    ok: false,
    code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
    words: PLAN_WORDS.SUBSCRIPTION_SIGN_IN_NEEDED,
  });
  expect(PLAN_WORDS.SUBSCRIPTION_SIGN_IN_NEEDED).toMatch(/sign in again/iu);
});

it('names an absent token file the same way', async () => {
  const prepared = await holderOn(world().file).prepare();
  expect(prepared.ok === false && planRefused(prepared.code)).toMatchObject({
    code: 'SUBSCRIPTION_SIGN_IN_NEEDED',
  });
});

it('gives every holder refusal its own words', () => {
  const refusals: readonly PlanRefusal[] = [
    'SUBSCRIPTION_SIGN_IN_NEEDED',
    'SUBSCRIPTION_REFRESH_FAILED',
    'SUBSCRIPTION_STORE_FAILED',
    'SUBSCRIPTION_TOKEN_FILE_OPEN',
  ];
  const words = refusals.map((code) => planRefused(code));
  for (const [at, code] of refusals.entries()) {
    expect(words[at]).toEqual({ ok: false, code, words: PLAN_WORDS[code] });
  }
  expect(new Set(words.map((result) => (result.ok ? '' : result.words))).size).toBe(
    refusals.length,
  );
});
