// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 7 (F6): the lock wait and the refresh share one deadline,
// PREPARE_BOUND_MS (30 s) from the start of prepare, judged by the holder's
// clock. A prepared pair is presentable 38 s after its offer (35 s plan accept
// plus 3 s W). The clock is faked; the issuer advances it.

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { PREPARE_BOUND_MS, tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import { T0, fileBytes, seed, tempDir, tokens, sleep } from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  issuer.onRequest(() => {});
  for (const w of worlds.splice(0)) w.done();
});
const rotated = {
  access_token: 'synthetic-access-new',
  refresh_token: 'synthetic-refresh-new',
  expires_in: 3_600,
};
async function start(): Promise<{ file: string; clock: { at: number } }> {
  const w = tempDir();
  worlds.push(w);
  await seed(w.file, { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) });
  issuer.set({ kind: 'json', status: 200, body: rotated });
  return { file: w.file, clock: { at: T0 } };
}

it.each([4_000, 20_000])(
  'a %i ms refresh completes within the bound and presents at +38 s',
  async (ms) => {
    const { file, clock } = await start();
    issuer.onRequest(() => {
      clock.at += ms;
    });
    const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => clock.at });
    expect(await holder.prepare()).toEqual({ ok: true });
    clock.at = T0 + 38_000;
    expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-new' });
  },
);

it('a lock held by a sign-in for 10 s, then a 15 s refresh, completes', async () => {
  const { file, clock } = await start();
  let release: (() => void) | undefined;
  const signIn = withTokenLock(
    file,
    { deadlineAt: Date.now() + 5_000 },
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await sleep(20);
  issuer.onRequest(() => {
    clock.at += 15_000;
  });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => clock.at });
  const prepared = holder.prepare();
  await sleep(120);
  clock.at += 10_000;
  release?.();
  await signIn;
  expect(await prepared).toEqual({ ok: true });
  expect(clock.at - T0).toBeLessThan(PREPARE_BOUND_MS);
});

it('a 31 s refresh is aborted after carrying and leaves pending', async () => {
  const { file, clock } = await start();
  issuer.set({ kind: 'stall' });
  issuer.onRequest(() => {
    clock.at += 31_000;
  });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => clock.at });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(fileBytes(file).toString('latin1')).toMatch(/^\{"state":"pending"/u);
});

it('a fresh pair with expires_in 300 is kept but refused', async () => {
  const { file, clock } = await start();
  issuer.set({ kind: 'json', status: 200, body: { ...rotated, expires_in: 300 } });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => clock.at });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
  expect(fileBytes(file).toString('latin1')).toMatch(/^\{"state":"ready".*synthetic-refresh-new/u);
  expect(holder.present()).toEqual({ ok: false, code: 'SUBSCRIPTION_REFRESH_FAILED' });
});
