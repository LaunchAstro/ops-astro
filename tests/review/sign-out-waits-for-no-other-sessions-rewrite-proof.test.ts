// SPDX-License-Identifier: AGPL-3.0-only
// A transport hold around the real API and database, without replacing admission or revocation.
// Sol's #1525 round 1 proof, steps and assertions as written; only the file name, the title and
// the lint comments are changed.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openSignIn, signOut } from '../../apps/web/src/session/sign-in.ts';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { createApiFixture, type ApiFixture } from '../api/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { signBearer, TEST_ISSUER } from '../support/sign-in.ts';

function gate() {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- replaced by the promise's own
  let release: () => void = () => {};
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  return { waiting, release: () => release() };
}

let fixture: ApiFixture;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() !== undefined) fixture = await createApiFixture('sol1525');
});
afterAll(async () => {
  await fixture?.drop();
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'sign-out with an earlier rewrite held',
  // eslint-disable-next-line max-lines-per-function -- Sol's proof, kept as one case
  () => {
    // eslint-disable-next-line max-lines-per-function -- Sol's proof, kept as one case
    it('a stalled earlier rewrite cannot keep a later signed-out session authorised', async () => {
      const api = fixture.compose();
      const token = async () =>
        await signBearer({
          sub: fixture.member.presented.subject,
          session_id: randomUUID(),
          aud: 'authenticated',
          iss: TEST_ISSUER,
          exp: Math.floor(Date.now() / 1000) + 600,
        });
      const earlierToken = await token();
      const laterToken = await token();
      const oldEnd = gate();
      const rewrite = gate();
      const rewriteStarted = gate();
      const cookies = new Map<string, string>();
      const sent: string[] = [];
      let earlierTrades = 0;
      const fetcher: typeof globalThis.fetch = async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        sent.push(`${url} ${headers.get(SESSION_HEADER) ?? '-'}`);
        if (url.startsWith('http://identity.invalid/token')) {
          const credentials = JSON.parse(String(init?.body)) as { email: string };
          return Response.json({
            access_token: credentials.email === 'earlier@example.test' ? earlierToken : laterToken,
          });
        }
        if (url === '/api/session/end' && headers.get(SESSION_HEADER) === 'f'.repeat(32))
          await oldEnd.waiting;
        if (url === '/api/session' && headers.get('authorization') === `Bearer ${earlierToken}`) {
          earlierTrades += 1;
          if (earlierTrades === 2) {
            rewriteStarted.release();
            await rewrite.waiting;
          }
        }
        if (url.startsWith('/api/b/'))
          headers.set('cookie', [...cookies].map(([key, value]) => `${key}=${value}`).join('; '));
        const response = await api.fetch(
          new Request(`http://api.test${url}`, { ...init, headers }),
        );
        for (const cookie of response.headers.getSetCookie()) {
          const [key = '', ...parts] = (cookie.split(';')[0] ?? '').split('=');
          const value = parts.join('=');
          if (value === '') cookies.delete(key);
          else cookies.set(key, value);
        }
        return response;
      };
      const route = { apiOrigin: '', fetch: fetcher };
      const request = (email: string) => ({
        ...route,
        gotrueUrl: 'http://identity.invalid',
        businessKey: 'alpha',
        email,
        password: 'synthetic-password',
      });
      const oldLeaving = signOut({ ...route, sessionId: 'f'.repeat(32) });
      let laterLeaving: Promise<void> | undefined;
      try {
        expect((await openSignIn(request('earlier@example.test'))).ok).toBe(true);
        oldEnd.release();
        await oldLeaving;
        await rewriteStarted.waiting;
        const later = await openSignIn(request('later@example.test'));
        expect(later.ok).toBe(true);
        if (!later.ok || later.sessionId === undefined)
          throw new Error('The API did not issue the later session');
        laterLeaving = signOut({ ...route, businessKey: 'alpha', sessionId: later.sessionId });
        // The earlier cookie has a different id. Its stalled write must not delay
        // this session's server-side revocation. Read using the real signed bearer.
        await vi.waitFor(
          async () => {
            const answer = await api.fetch(
              new Request('http://api.test/api/b/alpha/session/person', {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${laterToken}`,
                  'content-type': 'application/json',
                },
                body: '{}',
              }),
            );
            expect(
              answer.status,
              `The later signed-out session is still admitted; calls sent: ${sent.filter((call) => call.includes('sign-out')).join(', ')}`,
            ).toBe(401);
          },
          { timeout: 1000, interval: 50 },
        );
      } finally {
        oldEnd.release();
        rewrite.release();
        await oldLeaving;
        await laterLeaving;
      }
    });
  },
);
