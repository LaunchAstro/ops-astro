// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- the stand-ins answer as fetch does */
//
// The confirming sign-in is asked out until GoTrue acknowledges it or the token's life is over
// (`password-change.ts`). That life is GoTrue's `expires_in`, a span of time, so the browser's
// wall clock being set forward or back mid-change (a sync, a person, a wake) moves neither end
// of it: set forward, the asking still goes on while the token can sign out; set back, the
// change still answers once the span is over.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  changePassword,
  type PasswordChangeResult,
} from '../../apps/web/src/session/password-change.ts';

const GOTRUE = 'http://identity.invalid';
const HOUR_MS = 3_600_000;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date', 'performance'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A refused new password, the sign-outs answered by `logout` in turn, ten minutes at most. */
async function refused(
  logout: (asked: number) => Response,
  expiresIn: number,
): Promise<{
  readonly settled: boolean;
  readonly result: PasswordChangeResult | undefined;
  readonly asked: number;
}> {
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
  const answered = { settled: false };
  void changing.finally(() => {
    answered.settled = true;
  });
  for (let tick = 0; tick < 600 && !answered.settled; tick += 1) {
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(1000);
  }
  const result = answered.settled ? await changing : undefined;
  return { settled: answered.settled, result, asked };
}

it('a wall clock set forward mid-change does not end the asking while the token can sign out', async () => {
  const { settled, asked } = await refused((n) => {
    // The clock jumps two hours while the first ask is out; the token has 3600 s still.
    if (n === 1) vi.setSystemTime(Date.now() + 2 * HOUR_MS);
    return n <= 3 ? json({}, 503) : new Response(null, { status: 204 });
  }, 3600);
  expect(settled, 'the change answered').toBe(true);
  expect(asked, 'asked until GoTrue acknowledged the fourth').toBe(4);
});

it('a wall clock set back mid-change does not hold the change past the token’s life', async () => {
  const { settled, result } = await refused((n) => {
    // The clock jumps back a day while the first ask is out; the token lives sixty seconds.
    if (n === 1) vi.setSystemTime(Date.now() - 24 * HOUR_MS);
    return json({}, 503);
  }, 60);
  expect(settled, 'the change answered within ten minutes of a sixty-second token').toBe(true);
  expect(result).toEqual({ ok: false, because: 'Password is known to be weak.' });
});
