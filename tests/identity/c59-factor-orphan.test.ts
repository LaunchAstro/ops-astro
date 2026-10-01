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
import { endOtherSeenSessions } from '../../packages/core-records/src/identity/sessions.ts';
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

async function enrolHere(
  business: string,
  personId: string,
  subject: string,
  verify: boolean,
  endOthers = false,
) {
  await db.app.withBusiness(business, async (tx) => {
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    });
    if (verify) await recordFactorVerified(tx, { personId, factorId: enrolled.id, subject });
    // The winner's completed enrolment ends every other session (C58), the loser's included.
    if (endOthers) await endOtherSeenSessions(tx, personId, randomUUID(), 'factor_change', subject);
  });
}

async function events(business: string, command: string) {
  return await db.app.withBusiness(business, (tx) =>
    tx.query<{ outcome: string; refusal_code: string | null; operation_id: string | null }>(
      'select outcome, refusal_code, operation_id from audit_events where command = $1 order by seq',
      [command],
    ),
  );
}

/**
 * Mia's code is good at the provider; while it is checked, alpha verifies her
 * other factor, and with `endOthers` ends her other sessions as it does so.
 */
function racingProvider(
  subject: string,
  alphaPerson: string,
  removal: ProviderAnswer<void>,
  endOthers: boolean,
) {
  const asked: string[] = [];
  const session = { accessToken: 'aal2-access-token', refreshToken: 'r', expiresIn: 3600 };
  const provider: FactorProvider = {
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: async () => {
      asked.push('verify');
      await enrolHere(alpha, alphaPerson, subject, true, endOthers);
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

async function race(removal: ProviderAnswer<void>, endOthers = false) {
  const subject = `sub-${randomUUID()}`;
  const alphaPerson = await personIn(alpha, subject);
  const bravoPerson = await personIn(bravo, subject);
  await enrolHere(bravo, bravoPerson, subject, false);
  const { provider, asked } = racingProvider(subject, alphaPerson, removal, endOthers);
  const caller: FactorCaller = {
    database: db.app,
    businessId: bravo,
    presented: {
      provider: 'supabase',
      subject,
      sessionId: randomUUID(),
      assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 5, factorAt: null },
    },
    accessToken: 'aal1-access-token',
  };
  const answer = await verifySecondFactor(caller, { code: '123456' }, provider);
  return { code: 'code' in answer ? answer.code : 'verified', asked };
}

/**
 * Mia steps up with her verified factor; the code is good at the provider,
 * but she signed out in another tab while this one held it.
 */
async function stepUpAfterSignOut() {
  const subject = `sub-${randomUUID()}`;
  const person = await personIn(bravo, subject);
  await enrolHere(bravo, person, subject, true);
  const asked: string[] = [];
  const provider: FactorProvider = {
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: async () => {
      asked.push('verify');
      // Signed out in another tab while this one held the code.
      await db.app.withBusiness(bravo, (tx) =>
        endOtherSeenSessions(tx, person, randomUUID(), 'factor_change', subject),
      );
      return { ok: true, value: { accessToken: 'aal2', refreshToken: 'r', expiresIn: 3600 } };
    },
    remove: () => {
      asked.push('remove');
      return Promise.resolve({ ok: true, value: undefined });
    },
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
  };
  const caller: FactorCaller = {
    database: db.app,
    businessId: bravo,
    presented: {
      provider: 'supabase',
      subject,
      sessionId: randomUUID(),
      assurance: {
        level: 'aal1',
        signedInAt: Math.floor(Date.now() / 1000) - 5,
        factorAt: null,
      },
    },
    accessToken: 'aal1-access-token',
  };

  const answer = await verifySecondFactor(caller, { code: '123456' }, provider);

  const statuses = await db.app.withBusiness(bravo, (tx) =>
    tx.query<{ status: string }>('select status from public.second_factors where person_id = $1', [
      person,
    ]),
  );
  return { code: 'code' in answer ? answer.code : 'verified', asked, statuses };
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
      expect(
        orphaned.slice(before).map(({ outcome, refusal_code }) => ({ outcome, refusal_code })),
      ).toEqual([{ outcome: 'refused', refusal_code: 'PROVIDER_ANSWER_INVALID' }]);
    });

    it('C59: the orphan row carries the operation id of the refused verify attempt', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      await race({ ok: false, fault: 'unreachable' });

      const [orphan] = (await events(bravo, 'account.factor_orphaned')).slice(before);
      const attempt = (await events(bravo, 'account.factor_verify')).at(-1);
      expect(attempt?.outcome).toBe('refused');
      expect(orphan?.operation_id).not.toBeNull();
      expect(orphan?.operation_id).toBe(attempt?.operation_id);
    });

    it('C59: a provider factor removed after a refused enrolment records no orphan', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const { code, asked } = await race({ ok: true, value: undefined });

      expect(code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual(['verify', 'remove']);
      expect(await events(bravo, 'account.factor_orphaned')).toHaveLength(before);
    });

    it('C59: a losing session ended by the winning enrolment still removes its provider factor, and records the orphan when removal fails', async () => {
      const removed = await race({ ok: true, value: undefined }, true);
      expect(removed).toEqual({ code: 'AUTH_SESSION_EXPIRED', asked: ['verify', 'remove'] });

      const before = (await events(bravo, 'account.factor_orphaned')).length;
      const stuck = await race({ ok: false, fault: 'unreachable' }, true);
      expect(stuck).toEqual({
        code: 'AUTH_SESSION_EXPIRED',
        asked: ['verify', 'remove', 'remove'],
      });
      const orphans = (await events(bravo, 'account.factor_orphaned')).slice(before);
      expect(orphans.map(({ outcome, refusal_code }) => ({ outcome, refusal_code }))).toEqual([
        { outcome: 'refused', refusal_code: 'PROVIDER_ANSWER_INVALID' },
      ]);
    });
    it('C59: a step-up with a good code refused because the session ended keeps the verified factor at the provider', async () => {
      const { code, asked, statuses } = await stepUpAfterSignOut();

      expect(code).toBe('AUTH_SESSION_EXPIRED');
      expect(asked).toEqual(['verify']);
      expect(statuses).toEqual([{ status: 'verified' }]);
    });
  },
);
