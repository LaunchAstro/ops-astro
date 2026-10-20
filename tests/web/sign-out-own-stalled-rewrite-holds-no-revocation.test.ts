// SPDX-License-Identifier: AGPL-3.0-only
// Race review of f3d38c88c: a session's own rewrite, sent and never answered, must not hold back
// that session's server-side revocation. Only the cookie clearing has to follow the rewrite; a
// revoked bearer restored to a cookie admits nothing. A transport hold around the real API and
// database, as in Sol's #1525 round 1 proof.
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
  if (databaseUrlFromEnvironment() !== undefined) fixture = await createApiFixture('race1525own');
});
afterAll(async () => {
  await fixture?.drop();
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'sign-out with its own rewrite held',
  // eslint-disable-next-line max-lines-per-function -- one interleaving, kept as one case
  () => {
    // eslint-disable-next-line max-lines-per-function -- one interleaving, kept as one case
    it('a stalled rewrite of the session signing out does not keep its bearer admitted', async () => {
      const api = fixture.compose();
      const ownToken = await signBearer({
        sub: fixture.member.presented.subject,
        session_id: randomUUID(),
        aud: 'authenticated',
        iss: TEST_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const oldEnd = gate();
      const rewrite = gate();
      const rewriteStarted = gate();
      const cookies = new Map<string, string>();
      const sent: string[] = [];
      let trades = 0;
      const fetcher: typeof globalThis.fetch = async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        sent.push(`${url} ${headers.get(SESSION_HEADER) ?? '-'}`);
        if (url.startsWith('http://identity.invalid/token'))
          return Response.json({ access_token: ownToken });
        if (url === '/api/session/end' && headers.get(SESSION_HEADER) === 'f'.repeat(32))
          await oldEnd.waiting;
        if (url === '/api/session' && headers.get('authorization') === `Bearer ${ownToken}`) {
          trades += 1;
          if (trades === 2) {
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
      const oldLeaving = signOut({ ...route, sessionId: 'f'.repeat(32) });
      let leaving: Promise<void> | undefined;
      try {
        const own = await openSignIn({
          ...route,
          gotrueUrl: 'http://identity.invalid',
          businessKey: 'alpha',
          email: 'own@example.test',
          password: 'synthetic-password',
        });
        expect(own.ok).toBe(true);
        if (!own.ok || own.sessionId === undefined)
          throw new Error('The API did not issue the session');
        oldEnd.release();
        await oldLeaving;
        // The session's own rewrite is now sent and never answered (a dropped connection).
        await rewriteStarted.waiting;
        leaving = signOut({ ...route, businessKey: 'alpha', sessionId: own.sessionId });
        await vi.waitFor(
          async () => {
            const answer = await api.fetch(
              new Request('http://api.test/api/b/alpha/session/person', {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${ownToken}`,
                  'content-type': 'application/json',
                },
                body: '{}',
              }),
            );
            expect(
              answer.status,
              `The signed-out session is still admitted; calls sent: ${sent.filter((call) => call.includes('sign-out')).join(', ')}`,
            ).toBe(401);
          },
          { timeout: 1000, interval: 50 },
        );
      } finally {
        oldEnd.release();
        rewrite.release();
        await oldLeaving;
        await leaving;
      }
    });
  },
);
