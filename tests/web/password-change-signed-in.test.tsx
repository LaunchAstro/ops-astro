// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Changing your own password while signed in. The current password is confirmed by the
// password grant; the new one is set at the sign-in service with that token, or, for a login
// with an authenticator app, with the token its code answers on this tab's own sign-in; the
// tab moves to the sign-in that set it, the person's other sessions end, and the old cookie
// is cleared. A wrong current password, a refused new one or a missing code changes nothing.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { changePassword } from '../../apps/web/src/session/password-change.ts';
import { settle } from '../surfaces/mount.tsx';
import { json, open } from './mp-2-1-support.tsx';

const GOTRUE = 'http://identity.invalid';
const OLD = 'old-password-one';
const NEW = 'new-password-two';

/** The sign-in service and the API; `factor` says whether the login has an authenticator app. */
function world(factor: boolean) {
  const sent: string[] = [];
  const bodies: string[] = [];
  const answer = (at: string, init?: RequestInit): Response | undefined => {
    const headers = new Headers(init?.headers);
    const bearer = headers.get('authorization') ?? '-';
    const named = headers.get('x-ops-astro-session') ?? '-';
    const body = String(init?.body ?? '');
    bodies.push(body);
    sent.push(`${init?.method ?? 'GET'} ${at} ${bearer} ${named}`);
    if (at === `${GOTRUE}/token?grant_type=password`) {
      const { password } = JSON.parse(body) as { password: string };
      if (password === OLD) return json({ access_token: 'confirm-token' });
      return json({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
    }
    if (at === `${GOTRUE}/user`) {
      if (factor && bearer !== 'Bearer aal2-token') {
        return json({ error_code: 'insufficient_aal', msg: 'AAL2 session is required' }, 401);
      }
      const { password } = JSON.parse(body) as { password: string };
      if (password === OLD) {
        return json({ error_code: 'same_password', msg: 'New password should be different.' }, 422);
      }
      return json({ email: 'mia@alpha.local' });
    }
    if (at.startsWith(`${GOTRUE}/logout`)) return new Response(null, { status: 204 });
    if (at === '/api/session') return json({ ok: true, session: 'new-cookie' });
    if (at.endsWith('/account/factor/verify')) {
      const { code } = JSON.parse(body) as { code: string };
      if (code === '123456') return json({ accessToken: 'aal2-token' });
      return json({ refused: true, code: 'SECOND_FACTOR_INVALID', names: [], fixes: [] }, 422);
    }
    if (at.endsWith('/account/sessions/end-others')) {
      return json({ ended: 2, signedOutAtProvider: true });
    }
    if (at === '/api/session/end') return json({ ok: true });
    return undefined;
  };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const answered = answer(String(url), init);
    return answered === undefined ? new Promise<Response>(() => {}) : Promise.resolve(answered);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent, bodies };
}

/** One change from a tab signed in as `old-cookie`. */
async function change(factor: boolean, asked: { current: string; next: string; code?: string }) {
  const { fetch, sent, bodies } = world(factor);
  const adopted: string[] = [];
  const route = { apiOrigin: '', fetch };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    sessionId: 'old-cookie',
  });
  const result = await changePassword({
    gotrueUrl: GOTRUE,
    email: 'mia@alpha.local',
    businessKey: 'alpha',
    route,
    client,
    from: 'old-cookie',
    current: () => true,
    adopt: (sessionId) => adopted.push(sessionId),
    currentPassword: asked.current,
    newPassword: asked.next,
    ...(asked.code === undefined ? {} : { code: asked.code }),
  });
  return { result, sent, bodies, adopted };
}

const puts = (sent: readonly string[]) => sent.filter((line) => line.startsWith('PUT '));
const trades = (sent: readonly string[]) => sent.filter((line) => line.includes(' /api/session '));

it('refuses a wrong current password and sets nothing', async () => {
  const { result, sent, adopted } = await change(false, { current: 'not-it-at-all', next: NEW });
  expect(result).toEqual({ ok: false, because: 'Invalid login credentials' });
  expect(puts(sent)).toEqual([]);
  expect(trades(sent)).toEqual([]);
  expect(adopted).toEqual([]);
});

it('sets it with the confirmed sign-in, moves the tab there and ends the other sessions', async () => {
  const { result, sent, adopted } = await change(false, { current: OLD, next: NEW });
  expect(result).toEqual({ ok: true, othersEnded: true });
  expect(puts(sent)).toEqual([`PUT ${GOTRUE}/user Bearer confirm-token -`]);
  expect(trades(sent)).toEqual(['POST /api/session Bearer confirm-token -']);
  expect(adopted).toEqual(['new-cookie']);
  const endOthers = sent.find((line) => line.includes('/account/sessions/end-others'));
  expect(endOthers).toMatch(/ new-cookie$/u);
  expect(sent.at(-1)).toBe('POST /api/session/end - old-cookie');
  // The other sessions end after the tab holds the new sign-in, never before.
  expect(sent.indexOf(endOthers ?? '')).toBeGreaterThan(sent.indexOf(trades(sent)[0] ?? ''));
});

it('a login with an authenticator app is asked for its code and nothing changes until it is given', async () => {
  const { result, sent, adopted } = await change(true, { current: OLD, next: NEW });
  expect(result).toMatchObject({ ok: false, needsCode: true });
  expect(trades(sent)).toEqual([]);
  expect(adopted).toEqual([]);
  // The confirming sign-in is not left open at the sign-in service.
  expect(sent).toContain(`POST ${GOTRUE}/logout?scope=local Bearer confirm-token -`);
});

it('a wrong code sets nothing; a good one, checked on this tab’s sign-in, sets it', async () => {
  const wrong = await change(true, { current: OLD, next: NEW, code: '000000' });
  expect(wrong.result.ok).toBe(false);
  expect(puts(wrong.sent)).toEqual([]);
  expect(wrong.adopted).toEqual([]);

  const good = await change(true, { current: OLD, next: NEW, code: '123456' });
  expect(good.result).toEqual({ ok: true, othersEnded: true });
  const verify = good.sent.find((line) => line.includes('/account/factor/verify'));
  expect(verify).toMatch(/ old-cookie$/u);
  expect(puts(good.sent)).toEqual([`PUT ${GOTRUE}/user Bearer aal2-token -`]);
  expect(trades(good.sent)).toEqual(['POST /api/session Bearer aal2-token -']);
  expect(good.adopted).toEqual(['new-cookie']);
  expect(good.sent.some((line) => line.includes('/account/sessions/end-others'))).toBe(true);
});

it('a new password the sign-in service refuses keeps the old sign-in, ends nothing and leaves no sign-in open', async () => {
  const { result, sent, adopted } = await change(false, { current: OLD, next: OLD });
  expect(result).toEqual({ ok: false, because: 'New password should be different.' });
  expect(trades(sent)).toEqual([]);
  expect(adopted).toEqual([]);
  expect(sent.some((line) => line.includes('end-others'))).toBe(false);
  // The confirming sign-in is not left open at the sign-in service.
  expect(sent).toContain(`POST ${GOTRUE}/logout?scope=local Bearer confirm-token -`);
});

it('never puts a password in what it answers', async () => {
  for (const asked of [
    { current: 'not-it-at-all', next: NEW },
    { current: OLD, next: OLD },
    { current: OLD, next: NEW },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const { result } = await change(false, asked);
    const said = JSON.stringify(result);
    expect(said).not.toContain(asked.current);
    expect(said).not.toContain(asked.next);
  }
});

it('the change-password page is linked from Settings', async () => {
  const { view } = await open('/settings');
  await settle();
  expect(view.find('a[href="/settings/password/"]')).not.toBeNull();
  await view.unmount();
});

it('the page changes the password and says the other sessions are signed out', async () => {
  const { fetch, sent } = world(false);
  const { view } = await open('/settings/password/', { fetch });
  await view.type('#password-current', OLD);
  await view.type('#password-new', NEW);
  await view.type('#password-repeat', NEW);
  await view.click('[data-password="form"] button[type="submit"]');
  await settle();
  expect(puts(sent)).toHaveLength(1);
  expect(view.find('[data-password="outcome"]')?.textContent).toContain('Your password is changed');
  await view.unmount();
});

it('the page asks for the code when the login has an authenticator app', async () => {
  const { fetch, sent } = world(true);
  const { view } = await open('/settings/password/', { fetch });
  await view.type('#password-current', OLD);
  await view.type('#password-new', NEW);
  await view.type('#password-repeat', NEW);
  await view.click('[data-password="form"] button[type="submit"]');
  await settle();
  expect(view.find('input[autocomplete="one-time-code"]')).not.toBeNull();
  await view.type('input[autocomplete="one-time-code"]', '123456');
  await view.click('[data-password="form"] button[type="submit"]');
  await settle();
  expect(puts(sent).at(-1)).toBe(`PUT ${GOTRUE}/user Bearer aal2-token -`);
  expect(view.find('[data-password="outcome"]')?.textContent).toContain('Your password is changed');
  await view.unmount();
});

it('the page sends nothing when the new password is too short or the two do not match', async () => {
  const { fetch, sent } = world(false);
  const { view } = await open('/settings/password/', { fetch });
  await view.type('#password-current', OLD);
  await view.type('#password-new', 'short');
  await view.type('#password-repeat', 'short');
  await view.click('[data-password="form"] button[type="submit"]');
  await settle();
  await view.type('#password-new', NEW);
  await view.type('#password-repeat', `${NEW}x`);
  await view.click('[data-password="form"] button[type="submit"]');
  await settle();
  expect(sent.filter((line) => line.includes(GOTRUE))).toEqual([]);
  expect(view.find('[role="alert"]')).not.toBeNull();
  await view.unmount();
});
