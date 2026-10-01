// SPDX-License-Identifier: AGPL-3.0-only
//
// C59, security review 2b2 finding 1: a code completes an enrolment at the
// provider while the record here refuses it, because the login verified a
// factor through another business in between. The provider-side factor is
// removed, and when the provider will not remove it, the orphan is not lost:
// the removal is asked again, and if that also fails an
// `account.factor_orphaned` event names it in the business it was enrolled in.
//
// No other refusal removes anything at the provider (rounds 7 and 8: the factor
// may be the one another tab has just recorded). A provider factor nothing
// records is removed at the person's next enrolment or removal instead.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enrolSecondFactor,
  removeSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type {
  FactorProvider,
  ListedFactor,
  ProviderAnswer,
} from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  recordFactorEnrolled,
  recordFactorRemoved,
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
    list: () => Promise.resolve({ ok: true, value: [] }),
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
    list: () => Promise.resolve({ ok: true, value: [] }),
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

const callerFor = (subject: string): FactorCaller => ({
  database: db.app,
  businessId: bravo,
  presented: {
    provider: 'supabase',
    subject,
    assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 5, factorAt: null },
  },
  accessToken: 'aal1-access-token',
});

/** Mia's one factor in bravo, unverified or verified: its row id and provider id. */
async function factorIn(person: string, subject: string, verify: boolean) {
  const providerFactorId = `factor-${randomUUID()}`;
  const id = await db.app.withBusiness(bravo, async (tx) => {
    const enrolled = await recordFactorEnrolled(tx, {
      personId: person,
      provider: 'supabase',
      providerFactorId,
    });
    if (verify)
      await recordFactorVerified(tx, { personId: person, factorId: enrolled.id, subject });
    return enrolled.id;
  });
  return { id, providerFactorId };
}

const statusOf = async (person: string) =>
  await db.app.withBusiness(bravo, (tx) =>
    tx.query<{ status: string }>(
      'select status from public.second_factors where person_id = $1 order by enrolled_at',
      [person],
    ),
  );

/** A provider naming each call, holding `listed`, its verify running `during` first. */
function namingProvider(
  listed: readonly ListedFactor[],
  during: () => Promise<void> = async () => {},
) {
  const asked: string[] = [];
  const session = { accessToken: 'aal2', refreshToken: 'r', expiresIn: 3600 };
  const provider: FactorProvider = {
    enrol: () => {
      asked.push('enrol');
      const issued = {
        factorId: `factor-${randomUUID()}`,
        qrCode: 'qr',
        secret: 's',
        uri: 'otpauth:',
      };
      return Promise.resolve({ ok: true, value: issued });
    },
    verify: async () => {
      asked.push('verify');
      await during();
      return { ok: true, value: session };
    },
    remove: (_token, factorId) => {
      asked.push(`remove ${factorId}`);
      return Promise.resolve({ ok: true, value: undefined });
    },
    list: () => {
      asked.push('list');
      return Promise.resolve({ ok: true, value: listed });
    },
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
  };
  return { provider, asked };
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

    it('C59: a losing enrolment refused FACTOR_ALREADY_ENROLLED under the lock removes its own unrecorded factor, and records no orphan', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const { code, asked } = await race({ ok: true, value: undefined });

      expect(code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual(['verify', 'remove']);
      expect(await events(bravo, 'account.factor_orphaned')).toHaveLength(before);
    });

    it('C59: a losing enrolment refused for a session the winner ended removes nothing at the provider', async () => {
      const before = (await events(bravo, 'account.factor_orphaned')).length;

      const answer = await race({ ok: true, value: undefined }, true);

      expect(answer).toEqual({ code: 'AUTH_SESSION_EXPIRED', asked: ['verify'] });
      expect(await events(bravo, 'account.factor_orphaned')).toHaveLength(before);
    });

    it('C59: a step-up with a good code refused because the session ended keeps the verified factor at the provider', async () => {
      const { code, asked, statuses } = await stepUpAfterSignOut();

      expect(code).toBe('AUTH_SESSION_EXPIRED');
      expect(asked).toEqual(['verify']);
      expect(statuses).toEqual([{ status: 'verified' }]);
    });

    it('C59: two tabs completing one enrolment, the winner ending the loser, leave the factor verified at the provider', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      const factor = await factorIn(person, subject, false);
      // Tab B's completion commits while tab A's good code is at the provider.
      const { provider, asked } = namingProvider([], async () => {
        await db.app.withBusiness(bravo, async (tx) => {
          await recordFactorVerified(tx, { personId: person, factorId: factor.id, subject });
          await endOtherSeenSessions(tx, person, randomUUID(), 'factor_change', subject);
        });
      });
      const caller = callerFor(subject);
      const tabA = { ...caller, presented: { ...caller.presented, sessionId: randomUUID() } };

      const answer = await verifySecondFactor(tabA, { code: '123456' }, provider);

      expect('code' in answer ? answer.code : 'verified').toBe('AUTH_SESSION_EXPIRED');
      expect(asked).toEqual(['verify']);
      expect(await statusOf(person)).toEqual([{ status: 'verified' }]);
    });

    it('C59: a concurrent first verify in another business keeps its factor at the provider', async () => {
      // Security review 2b2 round 10: Mia's good code for F, enrolled in alpha,
      // is through at the provider but not yet recorded while she enrols in
      // bravo; alpha then records F verified. Bravo removes nothing there.
      const subject = `sub-${randomUUID()}`;
      const alphaPerson = await personIn(alpha, subject);
      const f = await db.app.withBusiness(alpha, (tx) =>
        recordFactorEnrolled(tx, {
          personId: alphaPerson,
          provider: 'supabase',
          providerFactorId: `factor-${randomUUID()}`,
        }),
      );
      const person = await personIn(bravo, subject);
      const { provider, asked } = namingProvider([
        { factorId: f.providerFactorId, status: 'verified' },
      ]);

      const answer = await enrolSecondFactor(callerFor(subject), provider);
      await db.app.withBusiness(alpha, (tx) =>
        recordFactorVerified(tx, { personId: alphaPerson, factorId: f.id, subject }),
      );

      expect('code' in answer ? answer.code : 'issued').toBe('issued');
      expect(asked.filter((call) => call.startsWith('remove'))).toEqual([]);
      expect(await statusOf(person)).toEqual([{ status: 'unverified' }]);
    });

    it('C59: the next enrolment removes an unrecorded factor unverified at the provider, with an audit event, and touches no recorded one', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      const recorded = await factorIn(person, subject, false);
      const stray = `factor-${randomUUID()}`;
      const { provider, asked } = namingProvider([
        { factorId: recorded.providerFactorId, status: 'unverified' },
        { factorId: stray, status: 'unverified' },
        { factorId: `factor-${randomUUID()}`, status: 'verified' },
      ]);
      const before = (await events(bravo, 'account.factor_reconciled')).length;

      const answer = await enrolSecondFactor(callerFor(subject), provider);

      expect('code' in answer ? answer.code : 'issued').toBe('issued');
      expect(asked).toEqual(['list', `remove ${stray}`, 'enrol']);
      const reconciled = (await events(bravo, 'account.factor_reconciled')).slice(before);
      expect(reconciled.map(({ outcome }) => outcome)).toEqual(['applied']);
    });

    it('C59 sec r9: the next enrolment removes a factor verified at the provider that no business records, after a replaced enrolment', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      // Tab A's good code verified F at the provider; tab B's enrolment G
      // replaced F in the record first, so F was never recorded. G was then
      // completed and removed.
      const replaced = `factor-${randomUUID()}`;
      const g = await factorIn(person, subject, true);
      await db.app.withBusiness(bravo, (tx) =>
        recordFactorRemoved(tx, { personId: person, factorId: g.id, subject }),
      );
      const { provider, asked } = namingProvider([{ factorId: replaced, status: 'verified' }]);
      const before = (await events(bravo, 'account.factor_reconciled')).length;

      const answer = await enrolSecondFactor(callerFor(subject), provider);

      expect('code' in answer ? answer.code : 'issued').toBe('issued');
      expect(asked).toEqual(['list', `remove ${replaced}`, 'enrol']);
      const reconciled = (await events(bravo, 'account.factor_reconciled')).slice(before);
      expect(reconciled.map(({ outcome }) => outcome)).toEqual(['applied']);
    });

    it('C59 sec r9: reconciling never removes a factor another business records as verified', async () => {
      const subject = `sub-${randomUUID()}`;
      const alphaPerson = await personIn(alpha, subject);
      await enrolHere(alpha, alphaPerson, subject, true);
      const elsewhere = await db.app.withBusiness(alpha, (tx) =>
        tx.query<{ provider_factor_id: string }>(
          'select provider_factor_id from public.second_factors where person_id = $1',
          [alphaPerson],
        ),
      );
      const person = await personIn(bravo, subject);
      const own = await factorIn(person, subject, true);
      const stray = `factor-${randomUUID()}`;
      const { provider, asked } = namingProvider([
        { factorId: own.providerFactorId, status: 'verified' },
        { factorId: elsewhere[0]!.provider_factor_id, status: 'verified' },
        { factorId: stray, status: 'verified' },
      ]);

      await removeSecondFactor(callerFor(subject), { code: '123456' }, provider);

      expect(asked.slice(0, 3)).toEqual(['list', `remove ${stray}`, 'verify']);
      expect(asked).not.toContain(`remove ${elsewhere[0]!.provider_factor_id}`);
    });

    it('C59: a removal the product refuses removes nothing at the provider', async () => {
      const subject = `sub-${randomUUID()}`;
      const person = await personIn(bravo, subject);
      await factorIn(person, subject, true);
      // Signed out in another tab while this one held the code.
      const { provider, asked } = namingProvider([], async () => {
        await db.app.withBusiness(bravo, (tx) =>
          endOtherSeenSessions(tx, person, randomUUID(), 'factor_change', subject),
        );
      });
      const caller = callerFor(subject);
      const tab = { ...caller, presented: { ...caller.presented, sessionId: randomUUID() } };

      const answer = await removeSecondFactor(tab, { code: '123456' }, provider);

      expect('code' in answer ? answer.code : 'removed').toBe('AUTH_SESSION_EXPIRED');
      expect(asked.filter((call) => call.startsWith('remove'))).toEqual([]);
      expect(await statusOf(person)).toEqual([{ status: 'verified' }]);
    });
  },
);
