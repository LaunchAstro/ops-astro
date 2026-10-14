// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P1 proof 6: the issuer's answer is read up to 1 MiB, so a large but
// whole rotation is kept, and an answer past the bound leaves `pending` with
// nothing more sent.

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import { readTokenFileLocked } from '../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../packages/core-custody/src/token-lock.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import { T0, fileBytes, seed, tempDir, tokens } from './fixtures/plan-token-world.ts';

let issuer: Issuer;
beforeAll(async () => {
  issuer = await startIssuer();
});
afterAll(() => issuer.close());
const worlds: { done(): void }[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.done();
});
async function start(): Promise<string> {
  const w = tempDir();
  worlds.push(w);
  await seed(w.file, { state: 'ready', tokens: tokens('old', T0 + 4 * 60_000) });
  return w.file;
}
const answer = (padding: number, extra: Record<string, unknown> = {}) => ({
  access_token: 'synthetic-access-new',
  refresh_token: 'synthetic-refresh-new',
  expires_in: 3_600,
  id_token: 'p'.repeat(padding),
  ...extra,
});
const stored = (file: string) =>
  withTokenLock(file, { deadlineAt: Date.now() + 2_000 }, (held) =>
    Promise.resolve(readTokenFileLocked(held, file)),
  );

const ANSWERS = [
  ['ported sol-1634-rotated-refresh-size: a 96 KiB answer', 96 * 1024],
  ['ported sol-1634-rotated-refresh-size: a 300 KiB answer', 300 * 1024],
  ['ported sol-1634-oversized-successful-rotation: a 1 MiB less 200 bytes answer', 1_048_576 - 200],
] as const;
it.each(ANSWERS)('%s keeps the rotation and presents it', async (_name, size) => {
  const file = await start();
  issuer.set({ kind: 'json', status: 200, body: answer(size) });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(await holder.prepare()).toEqual({ ok: true });
  expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-new' });
  const out = await stored(file);
  expect(out.held && out.value.state === 'ready' && out.value.tokens.refreshToken).toBe(
    'synthetic-refresh-new',
  );
});

it('a 1.5 MiB 200 leaves pending, and nothing more is sent', async () => {
  const file = await start();
  const before = issuer.count();
  issuer.set({ kind: 'json', status: 200, body: answer(1_572_864) });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(fileBytes(file).toString('latin1')).toMatch(/^\{"state":"pending"/u);
  expect(await holder.prepare()).toEqual({ ok: false, code: 'SUBSCRIPTION_SIGN_IN_NEEDED' });
  expect(issuer.count() - before).toBe(1);
});

it('healthy: a normal 200, and a 200 without refresh_token keeps the held refresh token', async () => {
  const file = await start();
  issuer.set({
    kind: 'json',
    status: 200,
    body: { access_token: 'synthetic-access-new', expires_in: 3_600 },
  });
  const holder = tokenHolder({ file, tokenUrl: issuer.url, now: () => T0 });
  expect(await holder.prepare()).toEqual({ ok: true });
  const out = await stored(file);
  expect(out.held && out.value.state === 'ready' && out.value.tokens.refreshToken).toBe(
    'synthetic-refresh-old',
  );
  expect(holder.present()).toEqual({ ok: true, accessToken: 'synthetic-access-new' });
});
