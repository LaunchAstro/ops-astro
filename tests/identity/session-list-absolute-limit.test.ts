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

describe.skipIf(serverUrl === undefined)('the live-session list and the absolute limit', () => {
  let db: FreshDatabase;
  let business: string;
  let person: string;
  let login: string;
  let actor: string;

  /** One resolved attempt on `sessionId`, signed in at `signedInAt` (epoch seconds). */
  const served = async (tx: TenantQuery, sessionId: string, signedInAt: number): Promise<void> =>
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

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'b' });
    business = await insertBusiness(db.app, 'session-limit');
    await db.app.withBusiness(business, async (tx) => {
      person = await insertPerson(tx, 'Noor');
      actor = await insertActor(tx, person);
      login = await insertLogin(tx, 'sub-noor');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('leaves out a session signed in 13 hours ago and served 2 hours ago, and keeps the current one', async () => {
    const [old, current] = [randomUUID(), randomUUID()];
    const signedInOld = nowSeconds() - 13 * HOUR;
    await db.app.withBusiness(business, async (tx) => {
      await served(tx, old, signedInOld);
      await served(tx, old, signedInOld);
      await served(tx, current, nowSeconds() - 60);
    });
    // The old session's first call when it signed in, its last one 2 hours ago.
    await db.admin.execute(
      `update public.authentication_attempts a
          set at = now() - case when ranked.n = 1 then interval '13 hours' else interval '2 hours' end
         from (select id, row_number() over (order by id) as n
                 from public.authentication_attempts where session_id = $1) ranked
        where a.id = ranked.id`,
      [old],
    );

    const listed = await db.app.withBusiness(business, (tx) =>
      listSeenSessions(tx, person, current),
    );
    expect(listed.map((row) => row.sessionId)).toEqual([current]);
  });

  it('leaves out a session signed in 13 hours ago that this business first served a moment ago', async () => {
    // The login's first call here can come long after its sign-in (another
    // business served it first), so the earliest attempt cannot stand in for
    // the sign-in: only the recorded first sign-in time decides.
    const [elsewhere, current] = [randomUUID(), randomUUID()];
    await db.app.withBusiness(business, async (tx) => {
      await served(tx, elsewhere, nowSeconds() - 13 * HOUR);
      await served(tx, current, nowSeconds() - 60);
    });
    const listed = await db.app.withBusiness(business, (tx) =>
      listSeenSessions(tx, person, current),
    );
    expect(listed.map((row) => row.sessionId)).toEqual([current]);
  });
});
