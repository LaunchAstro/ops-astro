// SPDX-License-Identifier: AGPL-3.0-only
//
// The call-topic join judges a session by the API's own rules: a login with a
// verified second factor joins only with it, and a refreshed token joins only
// inside the 12 hours from its first sign-in.

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { standingOf } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { createRealtimeDatabase } from '../support/realtime-database.ts';
import { signBearer, TEST_ISSUER, testSignIn } from '../support/sign-in.ts';
import { carriageBusiness, callTopic, mayJoin } from './carriage-fixture.ts';

// oxlint-disable-next-line max-lines-per-function -- one database, one login and its factor
it('a login awaiting its second factor cannot join a call topic', async () => {
  const db = await createRealtimeDatabase('join_second_factor');
  try {
    const world = await carriageBusiness(db.app, 'joinmfa');
    const now = Math.floor(Date.now() / 1000);
    const sessionId = randomUUID();
    const presented = {
      provider: 'supabase',
      subject: world.owner.sub,
      sessionId,
      assurance: { level: 'aal1' as const, signedInAt: now, factorAt: null },
    };
    const claims = {
      sub: world.owner.sub,
      role: 'authenticated',
      session_id: sessionId,
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: now }],
    };
    const topic = callTopic(world.id, world.callId);
    expect(await mayJoin(db.admin, topic, claims)).toBe(true);
    await db.app.withBusiness(world.id, async (tx) => {
      const factor = await recordFactorEnrolled(tx, {
        personId: world.owner.person,
        provider: 'supabase',
        providerFactorId: randomUUID(),
      });
      await recordFactorVerified(tx, {
        personId: world.owner.person,
        factorId: factor.id,
        subject: world.owner.sub,
      });
    });
    expect(
      await db.app.withBusiness(world.id, (tx) => standingOf(tx, presented, 'required')),
    ).toMatchObject({ code: 'AUTH_SECOND_FACTOR_REQUIRED' });
    const strongClaims = {
      ...claims,
      aal: 'aal2',
      amr: [...claims.amr, { method: 'totp', timestamp: now }],
    };
    expect(await mayJoin(db.admin, topic, strongClaims)).toBe(true);
    const joins = await db.admin.transaction(async (execute) => {
      await execute('set local role authenticated');
      await execute("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const [row] = await execute<{ ok: boolean }>('select public.ops_carry_may_join($1) as ok', [
        topic,
      ]);
      return row?.ok;
    });
    expect(
      joins,
      'The API requires the authenticator code but the call-topic policy admits the password-only token',
    ).toBe(false);
  } finally {
    await db.drop();
  }
}, 180_000);

it('a refreshed token beyond the 12-hour session limit cannot join a call topic', async () => {
  const db = await createRealtimeDatabase('join_absolute_limit');
  try {
    const world = await carriageBusiness(db.app, 'joinlimit');
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      sub: world.owner.sub,
      aud: 'authenticated',
      iss: TEST_ISSUER,
      role: 'authenticated',
      session_id: randomUUID(),
      iat: now,
      exp: now + 600,
      amr: [{ method: 'password', timestamp: now - 13 * 60 * 60 }],
    };
    const verify = createSupabaseVerifier(testSignIn(TEST_ISSUER));
    const app = new Hono();
    app.get('/', async (c) => c.json({ verdict: await verify(c.req) }));
    const oldToken = await signBearer(claims);
    const response = await app.request('/', { headers: { authorization: `Bearer ${oldToken}` } });
    expect(await response.json()).toEqual({ verdict: 'expired' });
    const topic = callTopic(world.id, world.callId);
    const freshClaims = { ...claims, amr: [{ method: 'password', timestamp: now }] };
    expect(await mayJoin(db.admin, topic, freshClaims)).toBe(true);
    expect(
      await mayJoin(db.admin, topic, claims),
      'A valid refreshed JWT does not extend the product session past 12 hours',
    ).toBe(false);
  } finally {
    await db.drop();
  }
}, 180_000);
