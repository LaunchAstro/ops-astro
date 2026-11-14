// SPDX-License-Identifier: AGPL-3.0-only
//
// One set of sessions, each judged twice: by the API's door (the verifier on a
// signed token, then login resolution's `standingOf`) and by the carriage
// join on the same claims. Each must answer alike: fresh, signed out, ended
// with the login's other sessions, inside and after a reset, password-only
// with and without a verified factor, the second factor given, refreshed
// past its 12 hours, and either side of the minute of clock skew.

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { standingOf } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import {
  endOtherSeenSessions,
  endProviderSession,
  openResetWindow,
  settleResetWindow,
} from '../../packages/core-records/src/identity/sessions.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createRealtimeDatabase } from '../support/realtime-database.ts';
import { signBearer, TEST_ISSUER, testSignIn } from '../support/sign-in.ts';
import { callTopic, carriageBusiness, mayJoin, type CarriageBusiness } from './carriage-fixture.ts';

type Database = Awaited<ReturnType<typeof createRealtimeDatabase>>;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Claims as GoTrue signs them, for `sub`'s session first signed in at `signedInAt`. */
function claimsOf(
  sub: string,
  sessionId: string,
  signedInAt: number,
  secondFactorAt?: number,
): Record<string, unknown> {
  const now = nowSeconds();
  const amr = [{ method: 'password', timestamp: signedInAt }];
  return {
    sub,
    aud: 'authenticated',
    iss: TEST_ISSUER,
    role: 'authenticated',
    session_id: sessionId,
    iat: now,
    exp: now + 600,
    aal: secondFactorAt === undefined ? 'aal1' : 'aal2',
    amr:
      secondFactorAt === undefined ? amr : [...amr, { method: 'totp', timestamp: secondFactorAt }],
  };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'the door and the join judge a session alike',
  // oxlint-disable-next-line max-lines-per-function -- one database, one business per kind of ending
  () => {
    let db: Database;
    const verify = createSupabaseVerifier(testSignIn(TEST_ISSUER));
    const door = new Hono();
    door.get('/', async (c) => c.json({ verdict: await verify(c.req) }));

    beforeAll(async () => {
      db = await createRealtimeDatabase('door_join_parity');
    }, 180_000);
    afterAll(async () => await db?.drop());

    /** The door's answer and the join's on the same claims, for `world`'s owner on its call. */
    async function both(
      world: CarriageBusiness,
      claims: Record<string, unknown>,
    ): Promise<{ readonly door: boolean; readonly join: boolean }> {
      const token = await signBearer(claims);
      const response = await door.request('/', { headers: { authorization: `Bearer ${token}` } });
      const { verdict } = (await response.json()) as { verdict: VerifiedSubject | string };
      const admitted =
        typeof verdict !== 'string' &&
        'actorId' in
          (await db.app.withBusiness(world.id, (tx) => standingOf(tx, verdict, 'required')));
      return {
        door: admitted,
        join: await mayJoin(db.admin, callTopic(world.id, world.callId), claims),
      };
    }

    const alike = async (
      world: CarriageBusiness,
      claims: Record<string, unknown>,
      admitted: boolean,
    ): Promise<void> => {
      expect(await both(world, claims)).toEqual({ door: admitted, join: admitted });
    };

    it('fresh, the 12 hours, and the minute of clock skew', async () => {
      const world = await carriageBusiness(db.app, 'paritylimit');
      const now = nowSeconds();
      const owner = world.owner.sub;
      await alike(world, claimsOf(owner, randomUUID(), now), true);
      await alike(world, claimsOf(owner, randomUUID(), now - 43_200 + 10), true);
      await alike(world, claimsOf(owner, randomUUID(), now - 43_200 - 10), false);
      await alike(world, claimsOf(owner, randomUUID(), now + 50), true);
      await alike(world, claimsOf(owner, randomUUID(), now + 70), false);
    });

    it('signed out, and the login’s other sessions ended', async () => {
      const world = await carriageBusiness(db.app, 'parityended');
      const owner = world.owner.sub;
      const before = nowSeconds() - 300;
      const [out, kept, other] = [randomUUID(), randomUUID(), randomUUID()];
      await alike(world, claimsOf(owner, out, before), true);
      await db.app.withBusiness(world.id, async (tx) => await endProviderSession(tx, out));
      await alike(world, claimsOf(owner, out, before), false);
      await db.app.withBusiness(world.id, async (tx) => {
        await endOtherSeenSessions(tx, world.owner.person, kept, 'end_others', owner);
      });
      await alike(world, claimsOf(owner, other, before), false);
      await alike(world, claimsOf(owner, kept, before), true);
    });

    it('inside a reset, and signed in after it settled', async () => {
      const world = await carriageBusiness(db.app, 'parityreset');
      const owner = world.owner.sub;
      const before = nowSeconds() - 300;
      const window = await db.app.withBusiness(world.id, (tx) => openResetWindow(tx, owner));
      await alike(world, claimsOf(owner, randomUUID(), before), false);
      await db.app.withBusiness(world.id, (tx) => settleResetWindow(tx, window));
      await alike(world, claimsOf(owner, randomUUID(), before), false);
      await alike(world, claimsOf(owner, randomUUID(), nowSeconds() + 5), true);
    });

    it('password-only with and without a verified factor, and the factor given', async () => {
      const world = await carriageBusiness(db.app, 'parityfactor');
      const owner = world.owner.sub;
      const now = nowSeconds();
      await alike(world, claimsOf(owner, randomUUID(), now), true);
      await db.app.withBusiness(world.id, async (tx) => {
        const factor = await recordFactorEnrolled(tx, {
          personId: world.owner.person,
          subject: owner,
          provider: 'supabase',
          providerFactorId: randomUUID(),
        });
        await recordFactorVerified(tx, {
          personId: world.owner.person,
          factorId: factor.id,
          subject: owner,
        });
      });
      await alike(world, claimsOf(owner, randomUUID(), now), false);
      await alike(world, claimsOf(owner, randomUUID(), now, now), true);
    });
  },
);
