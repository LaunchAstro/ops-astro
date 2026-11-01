// SPDX-License-Identifier: AGPL-3.0-only
//
// A business's factor row belongs to one login (20261012135116). Rows written
// before it name only the person, so the upgrade attributes each live row to
// a login on evidence, in order: the one subject the login record (0064)
// holds the factor verified for, which only the provider proving a code under
// that login's own token writes; otherwise the person's one login in the
// business. A removed tuple is never evidence: a second login replacing the
// first's unfinished enrolment wrote one under its own subject. A live row
// neither attributes is ended, and held removed for every login it could be,
// so the login that really holds it at the provider lets it go there on its
// next proven code. Removed rows keep no login.
//
// Seeded through the runtime at the migration before, one person per case:
// (i) a row the second login's replacement removed, (ii) a verified row with
// one verified subject, of a person with two logins, (iii) an unfinished row
// of a person with one login, (iv) an unfinished row of a person with two.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
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
const UPGRADE = '20261012135116_second_factor_login';
const BEFORE = readMigrations('migrations').filter((m) => m.version < UPGRADE);

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const bySubject = (a: { readonly subject: string }, b: { readonly subject: string }) =>
  a.subject < b.subject ? -1 : 1;

interface Case {
  readonly person: string;
  readonly subjects: readonly string[];
  readonly factor: string;
  readonly row: string;
}

/** A person of the business with one mapped login per subject. */
async function personWith(tx: TenantQuery, logins: number): Promise<Omit<Case, 'factor' | 'row'>> {
  const person = await insertPerson(tx, 'Upgraded');
  const actor = await insertActor(tx, person);
  await insertMembership(tx, person);
  const subjects = Array.from({ length: logins }, () => `sub-${randomUUID()}`);
  for (const subject of subjects) {
    // oxlint-disable-next-line no-await-in-loop
    await insertMapping(tx, await insertLogin(tx, subject), person, actor);
  }
  return { person, subjects };
}

/** A factor row as the person-wide code wrote one, in `status`. */
async function factorRow(
  tx: TenantQuery,
  person: string,
  status: 'unverified' | 'verified' | 'removed',
): Promise<Pick<Case, 'factor' | 'row'>> {
  const row = randomUUID();
  const factor = `factor-${randomUUID()}`;
  await tx.query(
    `insert into public.second_factors
       (business_id, id, person_id, provider, provider_factor_id, status, verified_at, removed_at)
     values ($1, $2, $3, 'supabase', $4, $5,
             case when $5 = 'verified' then now() end, case when $5 = 'removed' then now() end)`,
    [tx.businessId, row, person, factor, status],
  );
  return { factor, row };
}

/** The login record's tuple, as the person-wide code wrote one beside a factor row. */
const tuple = async (tx: TenantQuery, subject: string, factor: string, state: string) =>
  await tx.query(
    `insert into ops.second_factor_subjects (subject_digest, factor_digest, state)
     values ($1, $2, $3)`,
    [digest(subject), digest(factor), state],
  );

/** The four cases, seeded at the migration before. */
async function seed(tx: TenantQuery): Promise<Record<'i' | 'ii' | 'iii' | 'iv', Case>> {
  const i = await personWith(tx, 2);
  const replaced = { ...i, ...(await factorRow(tx, i.person, 'removed')) };
  await tuple(tx, i.subjects[1] ?? '', replaced.factor, 'removed');
  const ii = await personWith(tx, 2);
  const verified = { ...ii, ...(await factorRow(tx, ii.person, 'verified')) };
  await tuple(tx, ii.subjects[1] ?? '', verified.factor, 'verified');
  await tx.query('update public.people set second_factor_verified = true where id = $1', [
    ii.person,
  ]);
  const iii = await personWith(tx, 1);
  const iv = await personWith(tx, 2);
  return {
    i: replaced,
    ii: verified,
    iii: { ...iii, ...(await factorRow(tx, iii.person, 'unverified')) },
    iv: { ...iv, ...(await factorRow(tx, iv.person, 'unverified')) },
  };
}

let db: EmptyDatabase;

const rowOf = async (row: string) =>
  (
    await db.admin.execute<{ readonly row: Record<string, unknown> }>(
      'select to_jsonb(f) as row from public.second_factors f where id = $1',
      [row],
    )
  )[0]?.row;

const tuplesOf = async (factor: string) =>
  (
    await db.admin.execute<{ readonly subject: string; readonly state: string }>(
      `select subject_digest as subject, state from ops.second_factor_subjects
        where factor_digest = $1`,
      [digest(factor)],
    )
  ).toSorted(bySubject);

describe.skipIf(serverUrl === undefined)('factor rows on the upgrade to one login each', () => {
  let cases: Record<'i' | 'ii' | 'iii' | 'iv', Case>;
  let before: Readonly<Record<string, unknown>>;

  beforeAll(async () => {
    db = await createEmptyDatabase({ part: 'factorloginupgrade' });
    await applyMigrations(db.admin, BEFORE);
    const business = await insertBusiness(db.app, 'factor-login-upgrade');
    cases = await db.app.withBusiness(business, seed);
    before = (await rowOf(cases.i.row)) ?? {};
    await db.closeSessions();
    await applyMigrations(db.admin, readMigrations('migrations'));
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('a row the second login removed when it replaced the first login is kept as it was, attributed to no login', async () => {
    expect(await rowOf(cases.i.row)).toEqual({ ...before, subject_digest: null });
    expect(await tuplesOf(cases.i.factor)).toEqual([
      { subject: digest(cases.i.subjects[1] ?? ''), state: 'removed' },
    ]);
  });

  it('a verified row takes the one subject that verified it, and a person with one login takes that login', async () => {
    expect(await rowOf(cases.ii.row)).toMatchObject({
      status: 'verified',
      subject_digest: digest(cases.ii.subjects[1] ?? ''),
    });
    expect(await rowOf(cases.iii.row)).toMatchObject({
      status: 'unverified',
      subject_digest: digest(cases.iii.subjects[0] ?? ''),
    });
  });

  it('an unfinished row of a person with two logins is ended, and held removed for both logins', async () => {
    expect(await rowOf(cases.iv.row)).toMatchObject({ status: 'removed', subject_digest: null });
    expect((await rowOf(cases.iv.row))?.['removed_at']).not.toBeNull();
    expect(await tuplesOf(cases.iv.factor)).toEqual(
      cases.iv.subjects
        .map((subject) => ({ subject: digest(subject), state: 'removed' }))
        .toSorted(bySubject),
    );
  });
});
