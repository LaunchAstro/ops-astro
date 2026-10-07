// SPDX-License-Identifier: AGPL-3.0-only
//
// A second factor is the sign-in login's, not the person's: a person reached
// by two logins, one of which verified an authenticator, is asked for a code
// only on that login. The other login has no factor at the provider, so a code
// asked of it is one it can never give.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { enrol } from '../commands/fixture.ts';
import { insertBusiness, insertLogin, insertMapping } from '../identity/fixture.ts';

let db: FreshDatabase;
let business: string;

beforeAll(async () => {
  db = await createFreshDatabase({ part: 'factorlogin' });
  business = await insertBusiness(db.app, 'factor-login');
}, 120_000);

afterAll(async () => await db?.drop());

it('a factor verified on one login asks no code of another login mapped to the same person', async () => {
  const person = await enrol(db.app, business, 'Two logins');
  const otherSubject = `second-login-${randomUUID()}`;
  await db.app.withBusiness(business, async (tx) => {
    await insertMapping(tx, await insertLogin(tx, otherSubject), person.personId, person.actorId);
    const factor = await recordFactorEnrolled(tx, {
      personId: person.personId,
      provider: 'supabase',
      providerFactorId: randomUUID(),
    });
    await recordFactorVerified(tx, {
      personId: person.personId,
      factorId: factor.id,
      subject: person.presented.subject,
    });
  });
  const passwordOnly = {
    level: 'aal1' as const,
    signedInAt: Math.floor(Date.now() / 1000),
    factorAt: null,
  };
  const first = await db.app.withBusiness(business, (tx) =>
    resolveLogin(tx, { ...person.presented, assurance: passwordOnly }),
  );
  expect(first).toMatchObject({ code: 'AUTH_SECOND_FACTOR_REQUIRED' });
  const other = await db.app.withBusiness(business, (tx) =>
    resolveLogin(tx, { provider: 'supabase', subject: otherSubject, assurance: passwordOnly }),
  );
  expect('refused' in other ? other.code : 'served').toBe('served');
});
