// SPDX-License-Identifier: AGPL-3.0-only
//
// A provider session is one sign-in wherever its login reaches, so its
// absolute limit runs from its first serving in any business. A session first
// served in one business longer ago than the limit and the clock minute is
// past the door's limit, so the list in another business, where it was first
// served later, does not name it.

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
  if (live) db = await createFreshDatabase({ part: 'sessionlistwide' });
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

/** The one login's person in a business of its own. */
async function memberIn(name: string, subject: string) {
  const business = await insertBusiness(db.app, name);
  const person = await db.app.withBusiness(business, async (tx) => {
    const id = await insertPerson(tx, 'Session list reader');
    const actor = await insertActor(tx, id);
    await insertMembership(tx, id);
    await insertMapping(tx, await insertLogin(tx, subject), id, actor);
    return id;
  });
  return { business, person };
}

const presented = (subject: string, sessionId: string, signedInAt: number): VerifiedSubject => ({
  provider: 'supabase',
  subject,
  sessionId,
  assurance: { level: 'aal1', signedInAt, factorAt: null },
});

const now = () => Math.floor(Date.now() / 1000);
const LIMIT_AND_MORE = 12 * 60 * 60 + 120;

/** Moves every served row of the session in one business back by `seconds`. */
async function servedEarlier(business: string, sessionId: string, seconds: number) {
  await db.admin.execute(
    `update public.authentication_attempts set at = at - make_interval(secs => $3)
      where business_id = $1 and session_id = $2::uuid`,
    [business, sessionId, seconds],
  );
}

it.skipIf(!live)(
  'a session first served in another business past the absolute limit leaves this business list',
  async () => {
    const subject = randomUUID();
    const first = await memberIn('absolute-first', subject);
    const here = await memberIn('absolute-here', subject);
    const old = randomUUID();
    const current = randomUUID();
    const signedInAt = now() - LIMIT_AND_MORE;
    // Served first in the other business 12 hours and 2 minutes ago, ...
    await db.app.withBusiness(first.business, async (tx) => {
      await resolveLogin(tx, presented(subject, old, signedInAt));
    });
    await servedEarlier(first.business, old, LIMIT_AND_MORE);
    // ... then here an hour ago, while the door still served it.
    await db.app.withBusiness(here.business, async (tx) => {
      await resolveLogin(tx, presented(subject, old, signedInAt));
    });
    await servedEarlier(here.business, old, 60 * 60);
    const listed = await db.app.withBusiness(here.business, async (tx) => {
      await resolveLogin(tx, presented(subject, current, now()));
      return await listSeenSessions(tx, here.person, current);
    });
    expect(listed.map((session) => session.sessionId)).toEqual([current]);
  },
);
