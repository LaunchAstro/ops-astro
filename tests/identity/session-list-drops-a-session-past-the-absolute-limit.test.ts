// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import { listSeenSessions } from '../../packages/core-records/src/identity/sessions.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const live = databaseUrlFromEnvironment() !== undefined;
let db: FreshDatabase;

beforeAll(async () => {
  if (live) db = await createFreshDatabase({ part: 'sessionlistdoor' });
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

async function signedInPerson(name: string) {
  const subject = randomUUID();
  const business = await insertBusiness(db.app, name);
  const person = await db.app.withBusiness(business, async (tx) => {
    const id = await insertPerson(tx, 'Session list reader');
    const actor = await insertActor(tx, id);
    await insertMembership(tx, id);
    await insertMapping(tx, await insertLogin(tx, subject), id, actor);
    return id;
  });
  return { subject, business, person };
}

const presented = (subject: string, sessionId: string, signedInAt: number): VerifiedSubject => ({
  provider: 'supabase',
  subject,
  sessionId,
  assurance: { level: 'aal1', signedInAt, factorAt: null },
});

const now = () => Math.floor(Date.now() / 1000);

/** Moves every served row of the session back by `seconds`, as if served then. */
async function servedEarlier(business: string, sessionId: string, seconds: number) {
  await db.admin.execute(
    `update public.authentication_attempts set at = at - make_interval(secs => $3)
      where business_id = $1 and session_id = $2::uuid`,
    [business, sessionId, seconds],
  );
}

it.skipIf(!live)(
  'a session first served more than the absolute limit ago leaves the list though it was served since',
  async () => {
    const world = await signedInPerson('absolute-limit');
    const old = randomUUID();
    const current = randomUUID();
    await db.app.withBusiness(world.business, async (tx) => {
      await resolveLogin(tx, presented(world.subject, old, now()));
    });
    // First served 12 hours and 2 minutes ago: its sign-in was no later than
    // a minute after that, so the door's absolute limit has passed.
    await servedEarlier(world.business, old, 12 * 60 * 60 + 120);
    const listed = await db.app.withBusiness(world.business, async (tx) => {
      // A row served now as well, from a request the door answered before the limit.
      await db.admin.execute(
        `insert into public.authentication_attempts
           (business_id, id, owner, login_id, person_id, actor_id, outcome, session_id, provider, subject_digest)
         select business_id, gen_random_uuid(), owner, login_id, person_id, actor_id, outcome, session_id,
                provider, subject_digest
           from public.authentication_attempts where session_id = $1::uuid limit 1`,
        [old],
      );
      await resolveLogin(tx, presented(world.subject, current, now()));
      return await listSeenSessions(tx, world.person, current);
    });
    expect(listed.map((session) => session.sessionId)).toEqual([current]);
  },
);
