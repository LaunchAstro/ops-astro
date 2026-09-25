// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, R1-AUTHORITY-24, over the real schema.
//
// `businesses_key_idx` is unique on (business_id, key) and business_id is the
// row's own id, so until 0027 nothing stopped a second business taking a key
// another holds. 0027 (`businesses_key_global_idx`, Nathan's approval of 24 Sep
// 2026) now refuses that insert, and the first case pins the refusal.
//
// The resolver's refusal stays as the runtime backstop, and it is still proved
// here: this suite's throwaway database drops the index, which is the state of
// an installation below 0027, and lets the second business in. The path key
// then names no single business: both prefixes answer the same bytes as a key
// nobody holds, for the member of the first business too, rather than serving
// whichever row the heap returned first.
//
// Through `composeApi`, the server's own wiring, over a throwaway database.

import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  BUSINESS_KEY,
  authorised,
  createApiFixture,
  createBusinessResolver,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const FABRICATED = 'zulu-not-a-business';
const PREFIXES = [
  ['person', (key: string) => `/api/b/${key}/task/queue`],
  ['agent', (key: string) => `/api/a/b/${key}/task/queue`],
] as const;

async function raw(api: Hono, path: string, token: string) {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorised(token) },
      body: JSON.stringify({ operationId: 'ambiguous-key-probe' }),
    }),
  );
  return { status: response.status, text: await response.text() };
}

describe.skipIf(serverUrl === undefined)('a business key two businesses hold', () => {
  let fixture: ApiFixture;
  let memberToken: string;
  let agentToken: string;
  let before: string | undefined;
  let refused: unknown;

  beforeAll(async () => {
    fixture = await createApiFixture('fas');
    before = await createBusinessResolver(fixture.db.admin)(BUSINESS_KEY);
    refused = await insertBusiness(fixture.db.app, BUSINESS_KEY).then(
      () => 'committed',
      (error: unknown) => error,
    );
    await fixture.db.admin.execute('drop index if exists public.businesses_key_global_idx');
    await insertBusiness(fixture.db.app, BUSINESS_KEY);
    memberToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  it('refuses the second business in storage while the index stands', () => {
    expect(refused).toMatchObject({ code: '23505', constraint_name: 'businesses_key_global_idx' });
  });

  it('resolves while one business holds it, and not once a second takes it', async () => {
    expect(before).toBe(fixture.business);
    expect(await createBusinessResolver(fixture.db.admin)(BUSINESS_KEY)).toBeUndefined();
  });

  for (const [prefix, path] of PREFIXES) {
    for (const [who, token] of [
      ['a member', () => memberToken],
      ['an agent', () => agentToken],
    ] as const) {
      it(`${prefix} prefix, ${who}: the shared key answers the bytes of a key nobody holds`, async () => {
        const api = fixture.compose();
        const shared = await raw(api, path(BUSINESS_KEY), token());
        const missing = await raw(api, path(FABRICATED), token());
        expect(shared).toStrictEqual(missing);
        expect(shared.status).toBeGreaterThanOrEqual(400);
      });
    }
  }
});
