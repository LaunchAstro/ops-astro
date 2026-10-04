// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #771: a session past its absolute limit is not listed as one the
// person is signed in on now.
//
// The limit is 12 hours from the provider's first sign-in, which a refresh
// carries unchanged (`SESSION_ABSOLUTE_SECONDS`); the door refuses such a
// token as expired whatever its recent activity. The list must agree with the
// door: a session signed in 13 hours ago and last served 2 hours ago is over,
// even though one of its attempts is inside the window. The attempts are
// written by the real writer, then moved back in time by the owner, because
// the application role cannot amend the trail.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAuthenticationAttempt } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import { listSeenSessions } from '../../packages/core-records/src/identity/sessions.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/transaction.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertActor, insertBusiness, insertLogin, insertPerson } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('session list absolute limit: DATABASE_URL is unset, so nothing was proved.');
}

const HOUR = 60 * 60;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface World {
  readonly db: FreshDatabase;
  readonly business: string;
  readonly person: string;
  readonly login: string;
  readonly actor: string;
}

let world: World | undefined;

function the(): World {
  if (world === undefined) throw new Error('the world was not set up');
  return world;
}

/** One resolved attempt on `sessionId`, signed in at `signedInAt` (epoch seconds). */
async function served(tx: TenantQuery, sessionId: string, signedInAt: number): Promise<void> {
  const { login, actor, person } = the();
  await recordAuthenticationAttempt(tx, {
    owner: 'person_login',
    outcome: 'resolved',
    presented: {
      provider: 'supabase',
      subject: 'sub-noor',
      sessionId,
      assurance: { level: 'aal1', signedInAt, factorAt: null },
    },
    loginId: login,
    actorId: actor,
    personId: person,
  });
}

/** The sessions listed to the person, asking from `current`. */
async function listedFrom(current: string): Promise<readonly string[]> {
  const { db, business, person } = the();
  const listed = await db.app.withBusiness(business, (tx) => listSeenSessions(tx, person, current));
  return listed.map((row) => row.sessionId);
}

async function setUp(): Promise<World> {
  const db = await createFreshDatabase({ part: 'b' });
  const business = await insertBusiness(db.app, 'session-limit');
  return await db.app.withBusiness(business, async (tx) => {
    const person = await insertPerson(tx, 'Noor');
    const actor = await insertActor(tx, person);
    const login = await insertLogin(tx, 'sub-noor');
    return { db, business, person, login, actor };
  });
}

/** Signed in 13 hours ago, first served then, last served 2 hours ago. */
async function servedLongAgoAndLately(): Promise<readonly [string, string]> {
  const { db, business } = the();
  const [old, current] = [randomUUID(), randomUUID()];
  const signedInOld = nowSeconds() - 13 * HOUR;
  await db.app.withBusiness(business, async (tx) => {
    await served(tx, old, signedInOld);
    await served(tx, old, signedInOld);
    await served(tx, current, nowSeconds() - 60);
  });
  await db.admin.execute(
    `update public.authentication_attempts a
        set at = now() - case when ranked.n = 1 then interval '13 hours' else interval '2 hours' end
       from (select id, row_number() over (order by id) as n
               from public.authentication_attempts where session_id = $1) ranked
      where a.id = ranked.id`,
    [old],
  );
  return [old, current];
}

describe.skipIf(serverUrl === undefined)('the live-session list and the absolute limit', () => {
  beforeAll(async () => {
    world = await setUp();
  }, 60_000);

  afterAll(async () => {
    await world?.db.drop();
  });

  it('leaves out a session signed in 13 hours ago and served 2 hours ago, and keeps the current one', async () => {
    const [old, current] = await servedLongAgoAndLately();
    const ids = await listedFrom(current);
    expect(ids).not.toContain(old);
    expect(ids).toContain(current);
  });

  it('leaves out a session signed in 13 hours ago that this business first served a moment ago', async () => {
    // The login's first call here can come long after its sign-in (another
    // business served it first), so the earliest attempt cannot stand in for
    // the sign-in: only the recorded first sign-in time decides. The person's
    // earlier sessions are still live, so the list is not compared whole.
    const [elsewhere, current] = [randomUUID(), randomUUID()];
    await the().db.app.withBusiness(the().business, async (tx) => {
      await served(tx, elsewhere, nowSeconds() - 13 * HOUR);
      await served(tx, current, nowSeconds() - 60);
    });
    const ids = await listedFrom(current);
    expect(ids).not.toContain(elsewhere);
    expect(ids).toContain(current);
  });
});
