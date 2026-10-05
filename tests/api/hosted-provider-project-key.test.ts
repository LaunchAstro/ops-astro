// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { composeApi } from '../../apps/api/server.ts';
import { sessionIdOf } from '../../apps/api/auth/session.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { withProviderKey } from '../../apps/web/src/session/provider-key.ts';
import { signOut } from '../../apps/web/src/session/sign-in.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { asBrowser, signBearer, testSignIn } from '../support/sign-in.ts';
import { serverUrl } from '../acceptance/world.ts';
import { createApiFixture, ISSUER, type ApiFixture } from './fixture.ts';

const key = 'sb_publishable_ow073_test_only';
const needsDatabase = it.skipIf(serverUrl === undefined);
let fixture: ApiFixture | undefined;
beforeAll(async () => {
  if (serverUrl !== undefined) fixture = await createApiFixture('sol_ow073_hosted_signout');
});
afterAll(async () => {
  await fixture?.drop();
});

// The hosted gateway's project-key check, before the Auth service sees the
// user's bearer. No request leaves the test process.
function hostedGateway() {
  const calls: { readonly path: string; readonly key: string | null }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const address = new URL(input instanceof Request ? input.url : String(input));
    expect(address.origin).toBe(new URL(ISSUER).origin);
    expect(address.pathname).toBe(`${new URL(ISSUER).pathname}/logout`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toMatch(/^Bearer .+/u);
    calls.push({ path: address.pathname + address.search, key: headers.get('apikey') });
    return Promise.resolve(
      headers.get('apikey') === key
        ? new Response(null, { status: 204 })
        : new Response('{"message":"No API key found in request"}', { status: 401 }),
    );
  };
  return { calls, fetcher };
}

it('control: the hosted gateway accepts provider sign-out when the configured project key is sent', async () => {
  const gateway = hostedGateway();
  const factors = createGoTrueFactors({
    baseUrl: ISSUER,
    fetch: withProviderKey(gateway.fetcher, ISSUER, key),
  });
  expect(await factors.signOut('test-only-access-token', 'local')).toEqual({
    ok: true,
    value: undefined,
  });
  expect(gateway.calls).toHaveLength(1);
});

needsDatabase(
  'hosted browser sign-out sends the configured project key and revokes the provider session',
  // eslint-disable-next-line max-lines-per-function -- one sign-out through the composed API, read as one case
  async () => {
    const world = fixture;
    if (world === undefined) throw new Error('the proof needs its disposable database');
    const gateway = hostedGateway();
    vi.stubGlobal('fetch', gateway.fetcher);
    try {
      const app = composeApi({
        database: world.db.app,
        admin: world.db.admin,
        signIn: testSignIn(ISSUER),
        providerKey: key,
        keys: runtimeKeys({ ...world.environment }),
      }).app;
      const published = await app.request('/api/sign-in');
      expect(await published.json()).toEqual({ issuer: ISSUER, key });
      const token = await signBearer({
        sub: world.member.presented.subject,
        aud: 'authenticated',
        iss: ISSUER,
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 600,
        session_id: randomUUID(),
      });
      let providerEnded: unknown;
      const browser = asBrowser(token, async (url, init) => {
        const response = await app.fetch(new Request(url, init));
        if (url.endsWith('/account/sessions/sign-out')) {
          expect(response.status).toBe(200);
          const body: { signedOutAtProvider: unknown; ended: unknown } = await response
            .clone()
            .json();
          expect(body.ended).toBe(1);
          providerEnded = body.signedOutAtProvider;
        }
        return response;
      });
      await signOut({
        apiOrigin: 'http://api.test',
        fetch: browser,
        businessKey: 'alpha',
        sessionId: sessionIdOf(token),
      });
      expect(gateway.calls).toHaveLength(1);
      expect({ providerEnded, projectKey: gateway.calls[0]?.key }).toEqual({
        providerEnded: true,
        projectKey: key,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it('factor enrolment, check and removal send the configured project key, and none without one', async () => {
  const sent: { readonly step: string; readonly apikey: string | null }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const { pathname } = new URL(input instanceof Request ? input.url : String(input));
    const last = pathname.split('/').at(-1);
    sent.push({
      step: init?.method === 'DELETE' ? 'DELETE' : `${init?.method} ${last}`,
      apikey: new Headers(init?.headers).get('apikey'),
    });
    // The challenge answers with an id, so the check goes on to its verification request.
    return Promise.resolve(
      Response.json(pathname.endsWith('/challenge') ? { id: 'test-only-challenge' } : {}),
    );
  };
  for (const projectKey of [key, undefined]) {
    const factors = createGoTrueFactors({
      baseUrl: ISSUER,
      fetch: fetcher,
      ...(projectKey === undefined ? {} : { projectKey }),
    });
    // eslint-disable-next-line no-await-in-loop -- one adapter after the other
    await factors.enrol('test-only-access-token');
    // eslint-disable-next-line no-await-in-loop -- one call after another
    await factors.verify('test-only-access-token', randomUUID(), '123456');
    // eslint-disable-next-line no-await-in-loop -- one call after another
    await factors.remove('test-only-access-token', randomUUID());
  }
  const steps = ['POST factors', 'POST challenge', 'POST verify', 'DELETE'];
  expect(sent.map(({ step }) => step)).toEqual([...steps, ...steps]);
  expect(sent.slice(0, 4).map(({ apikey }) => apikey)).toEqual([key, key, key, key]);
  expect(sent.slice(4).map(({ apikey }) => apikey)).toEqual([null, null, null, null]);
});
