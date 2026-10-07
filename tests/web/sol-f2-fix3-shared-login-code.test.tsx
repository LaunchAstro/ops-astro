// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import type { Session } from '../../apps/web/src/session/token.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  act,
  api,
  closeRoutes,
  fresh,
  GOOD,
  json,
  now,
  openRoutes,
  tokenFor,
  world,
  type Reply,
} from '../api/c59-factor-routes-world.ts';
import { mount, settle } from '../surfaces/mount.tsx';

const replies: Record<string, Reply> = { ...GOOD };
beforeAll(async () => {
  await openRoutes('solf2fix3shared', { replies: () => replies, saw: () => {} });
}, 60_000);
afterAll(closeRoutes);

it('Sol proof, criterion correctness: a shared login completes its authenticator code in another business', async () => {
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    const person = await insertPerson(tx, 'Mia in Bravo');
    const actor = await insertActor(tx, person);
    await insertMapping(tx, await insertLogin(tx, world.mia.subject), person, actor);
    await insertMembership(tx, person);
  });
  const passwordToken = await fresh(world.mia);
  const upgraded = await tokenFor(world.mia.subject, {
    aal: 'aal2',
    password: now() - 60,
    totp: now(),
  });
  replies['POST /factors/factor-one/verify'] = json(200, {
    access_token: upgraded,
    refresh_token: 'test-refresh',
    expires_in: 3600,
  });
  expect((await act('enrol', passwordToken)).status).toBe(200);
  expect((await act('verify', passwordToken, { code: '123456' })).status).toBe(200);

  // The same verified provider identity is a member of Bravo too. The valid
  // aal2 credential proves that Bravo's membership is usable independently.
  const control = await api.request('/api/b/bravo/session/person', {
    method: 'POST',
    headers: { authorization: `Bearer ${upgraded}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(control.status).toBe(200);

  const cookies = new Map<string, string>();
  const refusals: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('http://identity.invalid/token'))
      return Response.json({ access_token: passwordToken });
    const headers = new Headers(init?.headers);
    if (url.startsWith('/api/b/'))
      headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await api.request(url, { ...init, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const [key = '', ...value] = (cookie.split(';')[0] ?? '').split('=');
      cookies.set(key, value.join('='));
    }
    if (!response.ok) {
      const body = (await response.clone().json()) as { code: string };
      refusals.push(body.code);
    }
    return response;
  };
  const opened: Session[] = [];
  const page = await mount(
    <SignIn
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      ended={null}
      build={null}
      onSignedIn={(session) => opened.push(session)}
    />,
  );
  try {
    await page.type('#signin-email', 'mia@alpha.local');
    await page.type('#signin-password', 'test-password');
    await page.choose('#signin-business', 'bravo');
    await page.click('button[type="submit"]');
    await vi.waitFor(() => expect(page.find('input[autocomplete="one-time-code"]')).not.toBeNull());
    expect(refusals).toContain('AUTH_SECOND_FACTOR_REQUIRED');
    await page.type('input[autocomplete="one-time-code"]', '123456');
    await page.click('button[type="submit"]');
    await vi.waitFor(() =>
      expect(page.find('button[type="submit"]')?.textContent).toBe('Continue'),
    );
    await settle();
    expect(opened, `Valid shared login code was refused: ${refusals.join(', ')}`).toHaveLength(1);
    expect(opened[0]?.businessKey).toBe('bravo');
  } finally {
    await page.unmount();
    await settle();
  }
}, 30_000);
