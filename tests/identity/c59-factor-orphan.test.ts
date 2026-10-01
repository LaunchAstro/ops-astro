// SPDX-License-Identifier: AGPL-3.0-only
//
// C59, security review 2b2 finding 1: a code completes an enrolment at the
// provider while the record here refuses it, because the login verified a
// factor through another business in between. The provider-side factor is
// removed, and when the provider will not remove it, the orphan is not lost:
// the removal is asked again, and if that also fails an
// `account.factor_orphaned` event names it in the business it was enrolled in.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type {
  FactorProvider,
  ProviderAnswer,
} from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
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
  console.warn('C59 factor orphan: DATABASE_URL is unset, so nothing below ran.');
}

let db: FreshDatabase;
let alpha: string;
let bravo: string;

async function personIn(business: string, subject: string): Promise<string> {
  return await db.app.withBusiness(business, async (tx) => {
    const personId = await insertPerson(tx, 'Mia');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    return personId;
  });
}

async function enrolHere(business: string, personId: string, subject: string, verify: boolean) {
  await db.app.withBusiness(business, async (tx) => {
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    });
    if (verify) await recordFactorVerified(tx, { personId, factorId: enrolled.id, subject });
  });
}

async function events(business: string, command: string) {
  return await db.app.withBusiness(business, (tx) =>
    tx.query<{ outcome: string; refusal_code: string | null }>(
      'select outcome, refusal_code from audit_events where command = $1 order by seq',
      [command],
    ),
  );
}

/** Mia's code is good at the provider; while it is checked, alpha verifies her other factor. */
function racingProvider(subject: string, alphaPerson: string, removal: ProviderAnswer<void>) {
  const asked: string[] = [];
  const session = { accessToken: 'aal2-access-token', refreshToken: 'r', expiresIn: 3600 };
  const provider: FactorProvider = {
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: async () => {
      asked.push('verify');
      await enrolHere(alpha, alphaPerson, subject, true);
      return { ok: true, value: session };
    },
    remove: () => {
      asked.push('remove');
      return Promise.resolve(removal);
    },
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
  };
  return { provider, asked };
}

async function race(removal: ProviderAnswer<void>) {
  const subject = `sub-${randomUUID()}`;
  const alphaPerson = await personIn(alpha, subject);
  const bravoPerson = await personIn(bravo, subject);
  await enrolHere(bravo, bravoPerson, subject, false);
  const { provider, asked } = racingProvider(subject, alphaPerson, removal);
  const caller: FactorCaller = {
    database: db.app,
    businessId: bravo,
    presented: {
      provider: 'supabase',
      subject,
      assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000), factorAt: null },
    },
    accessToken: 'aal1-access-token',
  };
  const answer = await verifySecondFactor(caller, { code: '123456' }, provider);
  return { code: 'code' in answer ? answer.code : 'verified', asked };
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59fo' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)(
  'C59 a refused enrolment is not left at the provider',
  () => {
    it('C59: a provider factor that will not be removed after a refused enrolment is asked again and recorded as orphaned', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const { code, asked } = await race({ ok: false, fault: 'unreachable' });

      expect(code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual(['verify', 'remove', 'remove']);
      const orphaned = await events(bravo, 'account.factor_orphaned');
      expect(orphaned.slice(before)).toEqual([
        { outcome: 'refused', refusal_code: 'PROVIDER_ANSWER_INVALID' },
      ]);
    });

    it('C59: a provider factor removed after a refused enrolment records no orphan', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const { code, asked } = await race({ ok: true, value: undefined });

      expect(code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual(['verify', 'remove']);
      expect(await events(bravo, 'account.factor_orphaned')).toHaveLength(before);
    });
  },
);
