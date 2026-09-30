// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-6 no edge caching (ticket S0-6, the new line of the Vercel re-plan): the
// API is served behind Vercel's edge network, so every `/api` answer tells
// every cache on the way that it may not be kept. Asked of the real
// composition root, for each kind of answer it gives: a success, a read, a
// refusal before and after sign-in, a body it will not read, an address
// under `/api` that is no route, and a fault answered by `onError`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { testSignIn } from '../support/sign-in.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  ISSUER,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const NO_STORE = 'private, no-store';

async function answer(api: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await api.fetch(new Request(`http://api.test${path}`, init));
  await response.arrayBuffer();
  return response;
}

const posted = (body: string, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

/** The suite's fixture, its composed app and a member's bearer, once built. */
interface World {
  readonly fixture: ApiFixture;
  readonly api: Hono;
  readonly token: string;
}

let world: World | undefined;

const built = (): World => world as World;

describe.skipIf(databaseUrlFromEnvironment() === undefined)('S0-6 no edge caching', () => {
  beforeAll(async () => {
    const fixture = await createApiFixture('s06cache');
    world = {
      fixture,
      api: fixture.compose(),
      token: await tokenFor(fixture.member.presented.subject),
    };
  }, 60_000);

  afterAll(async () => await world?.fixture.drop());

  answersCase();
  faultCase();
});

function answersCase() {
  it('every /api answer is sent Cache-Control: private, no-store', async () => {
    const { api, token } = built();
    const person = `${PREFIX.person}${BUSINESS_KEY}`;
    const cases: readonly (readonly [string, Promise<Response>])[] = [
      ['health', answer(api, '/api/health')],
      ['a read', answer(api, `${person}/task/board`, posted('{}', authorised(token)))],
      ['no sign-in', answer(api, `${person}/task/board`, posted('{}'))],
      [
        'a body it will not read',
        answer(api, `${person}/task/create`, posted('[', authorised(token))),
      ],
      [
        'an unknown business',
        answer(api, `${PREFIX.person}nobody/task/board`, posted('{}', authorised(token))),
      ],
      ['no route under /api', answer(api, '/api/no-such-route')],
      ['the live channel refused', answer(api, `${person}/live/task/not-a-task`)],
    ];
    for (const [what, pending] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- each answer named on its own line
      const response = await pending;
      expect(response.headers.get('cache-control'), `${what} (${String(response.status)})`).toBe(
        NO_STORE,
      );
    }
  });
}

function faultCase() {
  it('a fault, answered by onError, is sent private and no-store too', async () => {
    const { fixture, token } = built();
    const faulty = composeApi({
      keys: runtimeKeys({ ...fixture.environment }),
      database: fixture.db.app,
      admin: fixture.db.admin,
      signIn: testSignIn(ISSUER),
      executeRead: async () => await Promise.reject(new Error('a read that faults')),
    }).app;
    const response = await answer(
      faulty,
      `${PREFIX.person}${BUSINESS_KEY}/task/board`,
      posted('{}', authorised(token)),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe(NO_STORE);
  });
}
