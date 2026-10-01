// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the second factor belongs to the sign-in login, not to one business.
// The provider holds one set of factors per subject, so a factor verified
// through alpha is the login's factor in bravo too: a password-only (aal1)
// sign-in is refused in every business the login reaches, and removing the
// factor serves it again in every one. Each case opens its own login, mapped
// to a person in alpha and a person in bravo.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import type { AssuranceLevel } from '../../packages/core-records/src/identity/verified-subject.ts';
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

if (serverUrl === undefined) {
  console.warn('C59 factor in every business: DATABASE_URL is unset, so nothing below ran.');
}

let db: FreshDatabase;
let alpha: string;
let bravo: string;

/** One login, a person in each business. */
interface Login {
  readonly subject: string;
  readonly person: Readonly<Record<string, string>>;
}

async function loginInBoth(): Promise<Login> {
  const subject = `sub-${randomUUID()}`;
  const person: Record<string, string> = {};
  for (const business of [alpha, bravo]) {
    // oxlint-disable-next-line no-await-in-loop
    person[business] = await db.app.withBusiness(business, async (tx) => {
      const personId = await insertPerson(tx, 'Mia');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      return personId;
    });
  }
  return { subject, person };
}

/** The refusal code, or `served`. */
async function signIn(login: Login, business: string, level: AssuranceLevel): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const resolved = await db.app.withBusiness(business, (tx) =>
    resolveLogin(tx, {
      provider: 'supabase',
      subject: login.subject,
      assurance: { level, signedInAt: now, factorAt: level === 'aal2' ? now : null },
    }),
  );
  return 'refused' in resolved ? resolved.code : 'served';
}

/** Enrol and verify a factor through `business`, as the factor routes record it. */
async function verifyThrough(login: Login, business: string): Promise<string> {
  return await db.app.withBusiness(business, async (tx) => {
    const personId = login.person[business] ?? '';
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    });
    const factor = { personId, factorId: enrolled.id, subject: login.subject };
    await recordFactorVerified(tx, factor);
    return enrolled.id;
  });
}

async function removeThrough(login: Login, business: string, factorId: string): Promise<void> {
  await db.app.withBusiness(business, async (tx) => {
    const factor = { personId: login.person[business] ?? '', factorId, subject: login.subject };
    await recordFactorRemoved(tx, factor);
  });
}

const everywhere = async (login: Login, level: AssuranceLevel) => [
  await signIn(login, alpha, level),
  await signIn(login, bravo, level),
];

const REFUSED = 'AUTH_SECOND_FACTOR_REQUIRED';

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59fe' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('C59 the second factor is the login’s', () => {
  it('C59: a factor verified in one business refuses a password-only sign-in in every business the login reaches', async () => {
    const mia = await loginInBoth();
    expect(await everywhere(mia, 'aal1')).toEqual(['served', 'served']);

    await verifyThrough(mia, alpha);

    expect(await everywhere(mia, 'aal1')).toEqual([REFUSED, REFUSED]);
    expect(await everywhere(mia, 'aal2')).toEqual(['served', 'served']);
    // Another login in the same two businesses has no factor, and needs none.
    expect(await everywhere(await loginInBoth(), 'aal1')).toEqual(['served', 'served']);
  });

  it('C59: removing the factor in one business serves a password-only sign-in in every business again', async () => {
    const mia = await loginInBoth();
    const factor = await verifyThrough(mia, alpha);
    expect(await everywhere(mia, 'aal1')).toEqual([REFUSED, REFUSED]);

    await removeThrough(mia, alpha, factor);

    expect(await everywhere(mia, 'aal1')).toEqual(['served', 'served']);
  });

  it('C59: removing one factor leaves another the login verified elsewhere standing everywhere', async () => {
    const mia = await loginInBoth();
    const first = await verifyThrough(mia, alpha);
    await verifyThrough(mia, bravo);

    await removeThrough(mia, alpha, first);

    expect(await everywhere(mia, 'aal1')).toEqual([REFUSED, REFUSED]);
  });
});
