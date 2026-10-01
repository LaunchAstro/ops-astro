// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-4, red proof. `standingOf` is documented as recording
// nothing, yet on the second-factor refusal it calls `recordRefusal` itself,
// and `resolveLogin` then records the refusal it returns a second time. So one
// password-only (aal1) call by a login holding a verified second factor writes
// two authentication_attempts rows, and `withStanding` (the live recheck, which
// must record nothing) writes one. One attempt is one row; a recheck is none.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subjectDigest } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { withStanding } from '../../packages/core-records/src/identity/standing.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
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
  console.warn('REVIEW-MAIN-2B1-4: DATABASE_URL is unset, so nothing below ran.');
}

const REFUSED = 'AUTH_SECOND_FACTOR_REQUIRED';

let db: FreshDatabase;
let business: string;

/** A login mapped to an active member who has verified a second factor. */
async function loginWithFactor(): Promise<string> {
  const subject = `sub-${randomUUID()}`;
  await db.app.withBusiness(business, async (tx) => {
    const personId = await insertPerson(tx, 'Ivy');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    });
    await recordFactorVerified(tx, { personId, factorId: enrolled.id, subject });
  });
  return subject;
}

const firstFactorOnly = (subject: string): VerifiedSubject => {
  const now = Math.floor(Date.now() / 1000);
  return {
    provider: 'supabase',
    subject,
    assurance: { level: 'aal1', signedInAt: now, factorAt: null },
  };
};

/** Every attempt row for this presented subject, by outcome and code. */
async function attempts(presented: VerifiedSubject) {
  return await db.admin.execute<{ readonly outcome: string; readonly refusal_code: string }>(
    `select outcome, refusal_code from public.authentication_attempts
      where business_id = $1 and subject_digest = $2`,
    [business, subjectDigest(presented)],
  );
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'rm2b1p4' });
  business = await insertBusiness(db.app, 'alpha');
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)(
  'REVIEW-MAIN-2B1-4 second-factor refusal recording',
  () => {
    it('REVIEW-MAIN-2B1-4: one aal1 sign-in by a login holding a verified factor records exactly one refused attempt, not two', async () => {
      const presented = firstFactorOnly(await loginWithFactor());

      const resolved = await db.app.withBusiness(business, (tx) => resolveLogin(tx, presented));
      expect(resolved).toMatchObject({ refused: true, code: REFUSED });

      expect(await attempts(presented)).toEqual([{ outcome: 'refused', refusal_code: REFUSED }]);
    });

    it('REVIEW-MAIN-2B1-4: the live recheck (withStanding) refuses the same aal1 subject and records nothing', async () => {
      const presented = firstFactorOnly(await loginWithFactor());
      let ran = false;

      const rechecked = await withStanding(db.app, business, presented, () => {
        ran = true;
        return Promise.resolve();
      });
      expect(ran).toBe(false);
      expect(rechecked).toMatchObject({ refused: true, code: REFUSED });

      expect(await attempts(presented)).toEqual([]);
    });
  },
);
