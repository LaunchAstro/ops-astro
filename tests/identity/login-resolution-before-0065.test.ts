// SPDX-License-Identifier: AGPL-3.0-only
//
// Login resolution on an installation stopped before C58's session endings
// (0065 ended_provider_sessions, 0069 ended_subject_sessions). The upgrade
// suites seed through the runtime at old migration prefixes with tokens that
// name no session, so resolution must not reach for either table when there is
// no session to have ended: a token with no `session_id` is served as before
// and has nothing to list or end (apps/api/auth/supabase.ts sessionIdOf). The
// runtime's tokens carry a first sign-in time, so a sign-in time alone cannot
// decide it. Every provider token names its session.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('login-resolution-before-0065: DATABASE_URL is unset, so nothing below ran.');
}

const BEFORE_0065 = readMigrations('migrations').filter((m) => m.version.slice(0, 4) < '0065');

describe.skipIf(serverUrl === undefined)('login resolution before the session endings', () => {
  let db: EmptyDatabase;
  let alpha: string;
  let ada: string;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'lr0064' });
    await applyMigrations(db.admin, BEFORE_0065);
    alpha = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(alpha, async (tx) => {
      ada = await insertPerson(tx, 'Ada');
      const actor = await insertActor(tx, ada);
      await insertMembership(tx, ada);
      await insertMapping(tx, await insertLogin(tx, 'sub-ada'), ada, actor);
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('serves a token naming no session on an installation stopped at 0064', async () => {
    const session = await db.app.withBusiness(alpha, (tx) =>
      resolveLogin(tx, { provider: 'supabase', subject: 'sub-ada' }),
    );
    expect(session).toMatchObject({ businessId: alpha, personId: ada });
  });

  it('after the upgrade, a token naming no session is still served past an end-others', async () => {
    await db.closeSessions();
    await applyMigrations(db.admin, readMigrations('migrations'));
    const signedInAt = Math.floor(Date.now() / 1000) - 60;
    const served = await db.app.withBusiness(alpha, async (tx) => {
      await tx.query(
        `insert into ops.ended_subject_sessions (subject_digest, kept_session)
         values (encode(sha256(convert_to('sub-ada', 'UTF8')), 'hex'), $1::uuid)`,
        [randomUUID()],
      );
      return await resolveLogin(tx, {
        provider: 'supabase',
        subject: 'sub-ada',
        assurance: { level: 'aal1', signedInAt, factorAt: null },
      });
    });
    expect(served).toMatchObject({ businessId: alpha, personId: ada });
  });
});
