// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- the stand-ins answer as fetch does */
//
// A confirming sign-in the password change will not keep is signed out at GoTrue, and asked
// again until GoTrue itself acknowledges it: a 204 with nothing in its body, or GoTrue's word
// that the session is already gone. A gateway's 200, a refusal or no answer is not that, and
// no count of failures ends the asking while the token can still sign out.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  changePassword,
  type PasswordChangeResult,
} from '../../apps/web/src/session/password-change.ts';
import { signOutAtProvider } from '../../apps/web/src/session/sign-in-again.ts';

const GOTRUE = 'http://identity.invalid';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const gone = (): Response =>
  json(
    {
      code: 403,
      error_code: 'session_not_found',
      msg: 'Session from session_id claim in JWT does not exist',
    },
    403,
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ['a gateway 200 with a body', () => new Response('<html>ok</html>', { status: 200 })],
  ['a 200 with an empty body', () => new Response('', { status: 200 })],
  ['a 503', () => json({}, 503)],
  ['a 401', () => json({ code: 401, error_code: 'bad_jwt' }, 401)],
  ['a 403 for another reason', () => json({ code: 403, error_code: 'not_admin' }, 403)],
])('%s is not an acknowledged sign-out', async (_, answer) => {
  const fetch: typeof globalThis.fetch = async () => answer();
  expect(await signOutAtProvider(GOTRUE, 'confirm-token', fetch)).toBe(false);
});

it.each([
  ['GoTrue’s 204', () => new Response(null, { status: 204 })],
  ['GoTrue’s word that the session is already gone', gone],
])('%s is an acknowledged sign-out', async (_, answer) => {
  const fetch: typeof globalThis.fetch = async () => answer();
  expect(await signOutAtProvider(GOTRUE, 'confirm-token', fetch)).toBe(true);
});

/** A refused new password, with the sign-outs answered by `logout` in turn. */
async function refused(
  logout: (asked: number) => Response,
  expiresIn = 3600,
): Promise<{ readonly result: PasswordChangeResult; readonly asked: number }> {
  let asked = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const at = String(input);
    if (at.endsWith('/token?grant_type=password'))
      return json({ access_token: 'confirm-token', expires_in: expiresIn });
    if (at.endsWith('/user')) return json({ msg: 'Password is known to be weak.' }, 422);
    if (at.endsWith('/logout?scope=local')) return logout(++asked);
    throw new Error(`Unexpected request: ${at}`);
  };
  const changing = changePassword({
    gotrueUrl: GOTRUE,
    email: 'reviewer@example.test',
    businessKey: 'alpha',
    currentPassword: 'synthetic-current-password',
    newPassword: 'synthetic-next-password',
    route: { apiOrigin: '', fetch },
    client: new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      sessionId: 'old-cookie',
      fetch,
    }),
    from: 'old-cookie',
    current: () => true,
    adopt: () => {
      throw new Error('A refusal must not adopt');
    },
  });
  let settled = false;
  void changing.finally(() => {
    settled = true;
  });
  // Ten minutes at most, a second at a time: no real wait.
  for (let tick = 0; tick < 600 && !settled; tick += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(settled, 'the change answered').toBe(true);
  return { result: await changing, asked };
}

it('a confirming sign-out is asked again past three failures until GoTrue acknowledges it', async () => {
  const { result, asked } = await refused((n) =>
    n <= 6 ? json({}, 503) : new Response(null, { status: 204 }),
  );
  expect(result).toEqual({ ok: false, because: 'Password is known to be weak.' });
  expect(asked).toBe(7);
});

it('a gateway 200 is asked again until GoTrue acknowledges it', async () => {
  const { asked } = await refused((n) =>
    n === 1
      ? new Response('<html>ok</html>', { status: 200 })
      : new Response(null, { status: 204 }),
  );
  expect(asked).toBe(2);
});

it('a sign-out whose answer was lost ends on GoTrue’s word that the session is gone', async () => {
  const { asked } = await refused((n) => (n === 1 ? json({}, 504) : gone()));
  expect(asked).toBe(2);
});

it('the asking stops once the confirming token can no longer sign anything out', async () => {
  const { asked } = await refused(() => json({}, 503), 60);
  expect(asked).toBeGreaterThan(3);
  expect(asked).toBeLessThan(20);
});
