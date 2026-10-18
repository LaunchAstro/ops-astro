// SPDX-License-Identifier: AGPL-3.0-only
//
// #1620 P2: a sign-in racing a refresh, and an old holder after a new
// sign-in, leave one valid pair. Every holder and sign-in here is its own
// process; the issuer is the loopback stand-in with its request count.

import { afterEach, describe, expect, it } from 'vitest';
import { tokenHolder } from '../../packages/core-custody/src/plan-token.ts';
import { startIssuer, type Issuer } from './fixtures/plan-issuer.ts';
import {
  HOUR,
  T0,
  committedHex,
  fileBytes,
  holderInChild,
  runChild,
  seed,
  sleep,
  tempDir,
} from './fixtures/plan-token-world.ts';
import { HOST_ID, ISSUED, seedHost, signInTokens, storeInChild } from './fixtures/sign-in-world.ts';

const LATER = { hostId: HOST_ID, clientId: ISSUED };
let opened: Issuer | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await opened?.close();
  opened = undefined;
  cleanup?.();
  cleanup = undefined;
});
async function world() {
  const made = tempDir();
  cleanup = made.done;
  opened = await startIssuer();
  await seedHost(made.file, { extAgentHostId: HOST_ID, clientId: ISSUED });
  return { ...made, issuer: opened };
}

describe('a sign-in and a refresh', () => {
  it('a sign-in that reaches the lock mid-refresh waits it out, and its pair is the one held', async () => {
    const { file, issuer } = await world();
    await seed(file, { state: 'ready', tokens: signInTokens('old', T0 + 3 * 60_000) });
    let release: (() => void) | undefined;
    const carried = new Promise<void>((resolve) => {
      issuer.onRequest(
        () =>
          new Promise<void>((done) => {
            release = done;
            resolve();
          }),
      );
    });
    issuer.set({
      kind: 'json',
      status: 200,
      body: {
        access_token: 'synthetic-access-rotated',
        refresh_token: 'synthetic-refresh-rotated',
        expires_in: 3600,
      },
    });
    const refreshing = runChild({ op: 'prepare', file, tokenUrl: issuer.url.href, at: T0 });
    await carried;
    let signedIn: string | undefined;
    const signing = storeInChild(file, LATER, signInTokens('signin', T0 + 2 * HOUR)).then((x) => {
      signedIn = x.answer;
      return x;
    });
    await sleep(750);
    // Still waiting on the refresh's hold.
    expect(signedIn).toBeUndefined();
    release?.();
    expect(await refreshing.next()).toMatchObject({
      prepare: 'ok',
      present: 'ok:synthetic-access-rotated',
    });
    expect((await refreshing.exited()).output).toBe('');
    expect(await signing).toEqual({ answer: 'ok', output: '' });
    // One valid pair: the sign-in's, committed and presented by a fresh holder with no request.
    expect(fileBytes(file).toString()).toContain('synthetic-refresh-signin');
    expect(committedHex(file)).toBeDefined();
    const fresh = await holderInChild(file, issuer.url, T0);
    expect(fresh).toMatchObject({
      prepare: 'ok',
      present: 'ok:synthetic-access-signin',
      output: '',
    });
    expect(issuer.count()).toBe(1);
  });

  it('an old holder after a new sign-in never sends its old refresh token', async () => {
    const { file, issuer } = await world();
    await seed(file, { state: 'ready', tokens: signInTokens('old', T0 + HOUR) });
    let at = T0;
    const old = tokenHolder({ file, tokenUrl: issuer.url, now: () => at });
    expect(await old.prepare()).toEqual({ ok: true });
    expect(old.present()).toEqual({ ok: true, accessToken: 'synthetic-access-old' });
    expect((await storeInChild(file, LATER, signInTokens('signin', T0 + 2 * HOUR))).answer).toBe(
      'ok',
    );
    // The next prepare reads the sign-in's pair under the lock and holds it.
    expect(await old.prepare()).toEqual({ ok: true });
    expect(old.present()).toEqual({ ok: true, accessToken: 'synthetic-access-signin' });
    expect(issuer.count()).toBe(0);
    // Due: the one refresh carries the sign-in's refresh token, never the old one.
    const sent: string[] = [];
    issuer.onRequest((form) => {
      sent.push(form.get('refresh_token') ?? '');
    });
    issuer.set({
      kind: 'json',
      status: 200,
      body: {
        access_token: 'synthetic-access-next',
        refresh_token: 'synthetic-refresh-next',
        expires_in: 3600,
      },
    });
    at = T0 + 2 * HOUR - 5 * 60_000;
    expect(await old.prepare()).toEqual({ ok: true });
    expect(sent).toEqual(['synthetic-refresh-signin']);
    expect(old.secrets()).not.toContain('synthetic-refresh-old');
  });

  it('a sign-in that lands while a holder process is due leaves that holder refreshing the new pair', async () => {
    const { file, issuer } = await world();
    await seed(file, { state: 'spent', subject: 'synthetic-subject-a' });
    expect((await holderInChild(file, issuer.url, T0)).prepare).toBe('SUBSCRIPTION_SIGN_IN_NEEDED');
    expect((await storeInChild(file, LATER, signInTokens('signin', T0 + 3 * 60_000))).answer).toBe(
      'ok',
    );
    const sent: string[] = [];
    issuer.onRequest((form) => {
      sent.push(form.get('refresh_token') ?? '');
    });
    issuer.set({
      kind: 'json',
      status: 200,
      body: { access_token: 'synthetic-access-next', expires_in: 3600 },
    });
    expect(await holderInChild(file, issuer.url, T0)).toMatchObject({
      prepare: 'ok',
      present: 'ok:synthetic-access-next',
    });
    expect(sent).toEqual(['synthetic-refresh-signin']);
  });
});
