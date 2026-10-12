// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- the stand-ins answer as fetch does */
//
// With an authenticator code, the confirming sign-in is asked out at GoTrue and the code is
// checked on the tab's own sign-in (`password-change.ts`). The asking may go on for the
// confirming token's whole life; the code lives one 30-second step. So the code is not held
// behind that asking: a GoTrue sign-out that fails for a minute must not turn the person's
// good code into a stale one, refused and counted against them (C59). And a person who has
// left by the time the code would be checked has no code checked for them.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  changePassword,
  type PasswordChangeResult,
} from '../../apps/web/src/session/password-change.ts';

const GOTRUE = 'http://identity.invalid';
const TOTP_STEP_MS = 30_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

interface CodeSeen {
  asked: number;
  left: boolean;
  codeCheckedAfterMs?: number;
  codeCheckedAfterLeaving: boolean;
}

/** GoTrue and the API stood in: the sign-outs answered by `logout` in turn, the code noted. */
function standIn(
  seen: CodeSeen,
  logout: (asked: number) => Response,
  leavesAtAsk: number | undefined,
): typeof globalThis.fetch {
  const started = Date.now();
  return async (input) => {
    const at = String(input);
    if (at.endsWith('/token?grant_type=password'))
      return json({ access_token: 'confirm-token', expires_in: 3600 });
    if (at.endsWith('/logout?scope=local')) {
      seen.asked += 1;
      if (seen.asked === leavesAtAsk) seen.left = true;
      return logout(seen.asked);
    }
    if (at.endsWith('/account/factor/verify')) {
      seen.codeCheckedAfterMs = Date.now() - started;
      seen.codeCheckedAfterLeaving = seen.left;
      return json({ accessToken: 'aal2-token' });
    }
    if (at.endsWith('/user')) return json({ msg: 'Password is known to be weak.' }, 422);
    throw new Error(`Unexpected request: ${at}`);
  };
}

/** A change with a code, ten minutes at most; the person leaves at the `leavesAtAsk`-th ask. */
async function withCode(
  logout: (asked: number) => Response,
  leavesAtAsk?: number,
): Promise<CodeSeen & { readonly result: PasswordChangeResult }> {
  const seen: CodeSeen = { asked: 0, left: false, codeCheckedAfterLeaving: false };
  const fetch = standIn(seen, logout, leavesAtAsk);
  const changing = changePassword({
    gotrueUrl: GOTRUE,
    email: 'reviewer@example.test',
    businessKey: 'alpha',
    currentPassword: 'synthetic-current-password',
    newPassword: 'synthetic-next-password',
    code: '123456',
    route: { apiOrigin: '', fetch },
    client: new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      sessionId: 'old-cookie',
      fetch,
    }),
    from: 'old-cookie',
    current: () => !seen.left,
    adopt: () => {
      throw new Error('A refusal must not adopt');
    },
  });
  const answered = { settled: false };
  void changing.finally(() => {
    answered.settled = true;
  });
  for (let tick = 0; tick < 600 && !answered.settled; tick += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(answered.settled, 'the change answered').toBe(true);
  return { result: await changing, ...seen };
}

it('a minute of failed confirming sign-outs does not hold the code past its 30-second step', async () => {
  // Eight refusals, then GoTrue's 204: 61.75 s of waits between the asks.
  const { codeCheckedAfterMs } = await withCode((n) =>
    n <= 8 ? json({}, 503) : new Response(null, { status: 204 }),
  );
  expect(codeCheckedAfterMs, 'the code was checked').toBeDefined();
  expect(codeCheckedAfterMs, 'ms from the change to its code check').toBeLessThan(TOTP_STEP_MS);
});

it('a person who leaves while the confirming sign-in is asked out has no code checked for them', async () => {
  const { result, codeCheckedAfterLeaving } = await withCode(
    (n) => (n <= 2 ? json({}, 503) : new Response(null, { status: 204 })),
    1,
  );
  expect(codeCheckedAfterLeaving, 'the code was checked after the person left').toBe(false);
  expect(result).toMatchObject({ ok: false });
});
