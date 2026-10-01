// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 and the attempt trail (I13): a password-only sign-in by a person who
// holds a verified second factor is one refused attempt, recorded once by
// `resolveLogin`. `standingOf` records nothing, so the live channel's recheck
// through `withStanding` adds no row of its own. The command path is proved in
// `c59-second-factor-commands.test.ts`, whose fixture this file reuses.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Assurance } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import { withStanding } from '../../packages/core-records/src/identity/standing.ts';
import { readAuthenticationAttempts } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from './fixture.ts';
import { enrol, installSpine, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('C59 attempt trail: DATABASE_URL is unset, so the database cases did not run.');
}

let db: FreshDatabase;
let alpha: string;

/** Holds a verified second factor in alpha. */
let milo: Member;

const passwordOnly = (): Assurance => ({
  level: 'aal1',
  signedInAt: Math.floor(Date.now() / 1000),
  factorAt: null,
});

/** How many of milo's attempts were refused for want of the second factor. */
const factorRefusals = async (): Promise<number> =>
  await db.app.withBusiness(alpha, async (tx) => {
    const rows = await readAuthenticationAttempts(tx, milo.presented);
    return rows.filter((row) => row.refusal_code === 'AUTH_SECOND_FACTOR_REQUIRED').length;
  });

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59_attempts' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
  milo = await enrol(db.app, alpha, 'milo');
  await db.app.withBusiness(alpha, async (tx) => {
    const enrolled = await recordFactorEnrolled(tx, {
      personId: milo.personId,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    });
    await recordFactorVerified(tx, {
      personId: milo.personId,
      factorId: enrolled.id,
      subject: milo.presented.subject,
    });
  });
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('C59 attempt trail', () => {
  it('C59 attempt trail: one password-only sign-in with a factor held is recorded as exactly one refused attempt', async () => {
    const before = await factorRefusals();
    const refused = await db.app.withBusiness(
      alpha,
      async (tx) =>
        await resolveLogin(tx, { ...milo.presented, assurance: passwordOnly() }, 'required'),
    );
    expect('refused' in refused && refused.code).toBe('AUTH_SECOND_FACTOR_REQUIRED');
    expect(await factorRefusals()).toBe(before + 1);
  });

  it('C59 attempt trail: the live recheck through withStanding refuses and records nothing', async () => {
    const before = await factorRefusals();
    const refused = await withStanding(
      db.app,
      alpha,
      { ...milo.presented, assurance: passwordOnly() },
      () => Promise.resolve('served'),
    );
    expect(typeof refused === 'object' && refused.code).toBe('AUTH_SECOND_FACTOR_REQUIRED');
    expect(await factorRefusals()).toBe(before);
  });
});
