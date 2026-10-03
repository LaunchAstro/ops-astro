// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { open } from './mp-2-1-support.tsx';
import {
  api,
  closeRoutes,
  factorOf,
  fresh,
  GOOD,
  json,
  now,
  openRoutes,
  tokenFor,
  type Reply,
  world,
} from '../api/c59-factor-routes-world.ts';

const replies: Record<string, Reply> = { ...GOOD };

beforeAll(async () => {
  await openRoutes('sol345signin', { replies: () => replies, saw: () => {} });
}, 60_000);
afterAll(async () => {
  await closeRoutes();
});

it('Sol proof, criterion correctness: a newly enrolled person can enter their authenticator code on the next web sign-in', async () => {
  const original = await fresh(world.mia);
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
  const passwordToken = await fresh(world.mia);
  const originalId = sessionIdOf(original);
  const cookies = new Map([[cookieNameFor(originalId), original]]);
  const refusals: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'http://identity.invalid/token?grant_type=password') {
      return new Response(JSON.stringify({ access_token: passwordToken }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const headers = new Headers(init?.headers);
    if (url.startsWith('/api/b/'))
      headers.set(
        'cookie',
        [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    const response = await api.request(url, { ...init, headers });
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(';')[0] ?? '';
      const split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    if (!response.ok) {
      const body: unknown = await response.clone().json();
      if (
        typeof body === 'object' &&
        body !== null &&
        'code' in body &&
        typeof body.code === 'string'
      )
        refusals.push(body.code);
    }
    return response;
  };
  const setup = await open('/settings', {
    fetch: fetcher,
    seed: {
      'ops-astro.session': JSON.stringify({
        businessKey: 'alpha',
        email: 'mia@alpha.local',
        sessionId: originalId,
      }),
    },
  });
  try {
    await setup.view.click('[data-factor="enrol"] button');
    await vi.waitFor(() => expect(setup.view.find('[data-factor="secret"]')).not.toBeNull());
    await setup.view.type('[data-step-up="code"]', '123456');
    await setup.view.click('[data-factor="confirm"] button');
    await vi.waitFor(() => expect(setup.view.find('[data-factor="done"]')).not.toBeNull());
    expect((await factorOf(world.mia.personId))?.status).toBe('verified');
  } finally {
    await setup.view.unmount();
  }
  const opened = await open('/sign-in', { businessKey: null, fetch: fetcher });
  try {
    await opened.view.type('#signin-email', 'mia@alpha.local');
    await opened.view.type('#signin-password', 'test-password');
    await opened.view.click('[data-screen="sign-in"] button[type="submit"]');
    // The password credential is real and the API correctly requires aal2.
    // The web app must offer the next factor rather than strand the person
    // on a refused board with no way to complete sign-in.
    await vi.waitFor(() =>
      expect(
        opened.view.find('input[autocomplete="one-time-code"]'),
        `refusals=${refusals.join(',')}; panel=${opened.view.text()}`,
      ).not.toBeNull(),
    );
  } finally {
    await opened.view.unmount();
  }
}, 30_000);
