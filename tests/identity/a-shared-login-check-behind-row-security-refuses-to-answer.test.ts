// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a login is live in another business (C58, ORCH46 ruling A) is read
// on the owner's connection across businesses, from tables under forced row
// security (`logins`, `person_logins`, `actor_logins`, `access_endings`).
// An owner role that does not see past row security (no superuser, no
// BYPASSRLS) reads none of those rows, so the check answered "not live
// elsewhere" and the endings went on to ban a provider user still live in
// bravo (#643). The check now refuses to answer on such a connection, and an
// ending's provider steps stay owed (`sharedElsewhere` fails, `first` is null)
// instead of banning.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loginLiveElsewhere } from '../../packages/core-records/src/identity/shared-login.ts';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
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
const TABLES = ['logins', 'person_logins', 'actor_logins', 'access_endings'] as const;

let db: FreshDatabase;
let alpha: string;
let bravo: string;
const behind = `t643_owner_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const password = randomBytes(18).toString('hex');

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'shared_login_row_security' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
  // An owner-like login that reads the four tables but does not see past row security.
  await db.admin.execute(
    `create role ${behind} login password '${password}' nosuperuser nobypassrls`,
  );
  await db.admin.execute(`grant connect on database "${db.name}" to ${behind}`);
  await db.admin.execute(`grant usage on schema public to ${behind}`);
  for (const table of TABLES) {
    // eslint-disable-next-line no-await-in-loop -- four grants, one at a time
    await db.admin.execute(`grant select on public.${table} to ${behind}`);
  }
}, 120_000);

afterAll(async () => {
  if (db === undefined) return;
  await db.admin.execute(`drop owned by ${behind}`).catch(() => {});
  await db.drop();
  // The role is the cluster's: dropped once its database has gone.
  const cluster = connectAsAdmin(serverUrl as string, { source: 'admin' });
  await cluster.execute(`drop role if exists ${behind}`).catch(() => {});
  await cluster.close();
});

/** A provider subject with a live login in bravo. */
async function liveInBravo(): Promise<string> {
  const subject = randomUUID();
  await db.app.withBusiness(bravo, async (tx) => {
    const personId = await insertPerson(tx, `Shared ${subject.slice(0, 6)}`);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
  });
  return subject;
}

const asBehind = (): string => {
  const url = new URL(db.appUrl);
  url.username = behind;
  url.password = password;
  return url.toString();
};

it.skipIf(serverUrl === undefined)(
  'control: the owner that sees past row security answers live in bravo',
  async () => {
    expect(await loginLiveElsewhere(db.admin, await liveInBravo(), alpha)).toBe(true);
  },
);

it.skipIf(serverUrl === undefined)(
  'an owner behind row security refuses to answer, never "not live elsewhere"',
  async () => {
    const subject = await liveInBravo();
    const owner = connectAsAdmin(asBehind(), { source: 'admin' });
    try {
      await expect(loginLiveElsewhere(owner, subject, alpha)).rejects.toThrow(/row security/u);
    } finally {
      await owner.close();
    }
  },
);
