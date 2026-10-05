// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  endOtherSeenSessions,
  listSeenSessions,
} from '../../packages/core-records/src/identity/sessions.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';

async function sharedLogin(db: FreshDatabase) {
  const subject = randomUUID();
  const alpha = await insertBusiness(db.app, 'alpha');
  const bravo = await insertBusiness(db.app, 'bravo');
  const person = async (business: string) =>
    await db.app.withBusiness(business, async (tx) => {
      const id = await insertPerson(tx, 'Shared provider login');
      const actor = await insertActor(tx, id);
      await insertMembership(tx, id);
      await insertMapping(tx, await insertLogin(tx, subject), id, actor);
      return id;
    });
  return {
    subject,
    alpha,
    bravo,
    alphaPerson: await person(alpha),
    bravoPerson: await person(bravo),
  };
}

const presented = (subject: string, sessionId: string, signedInAt: number): VerifiedSubject => ({
  provider: 'supabase',
  subject,
  sessionId,
  assurance: { level: 'aal1', signedInAt, factorAt: null },
});

it('a session ended from another business by end-others leaves the live session list here', async () => {
  const db = await createFreshDatabase({ part: 'solow022list' });
  try {
    const world = await sharedLogin(db);
    const keep = randomUUID();
    const other = randomUUID();
    const signedInAt = Math.floor(Date.now() / 1000) - 60;
    const old = presented(world.subject, other, signedInAt);
    const current = presented(world.subject, keep, signedInAt);
    expect(
      await db.app.withBusiness(world.bravo, async (tx) => await resolveLogin(tx, old)),
    ).not.toHaveProperty('refused');
    await db.app.withBusiness(world.alpha, async (tx) => {
      await endOtherSeenSessions(tx, world.alphaPerson, keep, 'end_others', world.subject);
    });
    const refused = await db.app.withBusiness(
      world.bravo,
      async (tx) => await resolveLogin(tx, old),
    );
    expect(refused).toHaveProperty('code', 'AUTH_SESSION_EXPIRED');
    const live = await db.app.withBusiness(world.bravo, async (tx) => {
      expect(await resolveLogin(tx, current)).not.toHaveProperty('refused');
      return await listSeenSessions(tx, world.bravoPerson, keep);
    });
    expect(live.map((session) => session.sessionId)).toEqual([keep]);
  } finally {
    await db.drop();
  }
});
