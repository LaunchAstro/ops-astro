// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- the stand-ins answer as fetch does */
//
// A confirming sign-in's sign-out whose answer never comes is a lost answer too. The asking
// ends when the confirming token's life does (`password-change.ts`), so an ask GoTrue never
// answers must not hold the password change's own answer past that life. Real timers: the
// token here lives one second, and the change answers within three.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { changePassword } from '../../apps/web/src/session/password-change.ts';

const GOTRUE = 'http://identity.invalid';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An answer that never comes, unless the asker gives up on it. */
const hung = (init: RequestInit | undefined): Promise<Response> =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The ask was given up.', 'AbortError'));
    });
  });

it('a sign-out GoTrue never answers does not hold the change past the token’s life', async () => {
  let asked = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const at = String(input);
    if (at.endsWith('/token?grant_type=password'))
      return json({ access_token: 'confirm-token', expires_in: 1 });
    if (at.endsWith('/user')) return json({ msg: 'Password is known to be weak.' }, 422);
    if (at.endsWith('/logout?scope=local')) {
      asked += 1;
      return await hung(init);
    }
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'still asking'>((resolve) => {
    timer = setTimeout(() => {
      resolve('still asking');
    }, 3000);
  });
  const answered = await Promise.race([changing, late]);
  clearTimeout(timer);
  expect(asked, 'the confirming sign-in was asked out').toBeGreaterThan(0);
  expect(answered, 'the change answered once the token’s one-second life was over').toEqual({
    ok: false,
    because: 'Password is known to be weak.',
  });
}, 10_000);
