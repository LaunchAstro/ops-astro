// SPDX-License-Identifier: AGPL-3.0-only
//
// What the C59 orphan cases share (`c59-factor-orphan*.test.ts`): Mia, a
// person in alpha and bravo under one login, her factors there, stand-in
// sign-in providers that race the record, and the audit events and server log
// lines read back. Each test file calls `openWorld()` and gets a database of
// its own.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
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

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('C59 factor orphan: DATABASE_URL is unset, so nothing below ran.');
}

export let db: FreshDatabase;
export let alpha: string;
export let bravo: string;

/** Opens the world for one test file: a fresh database with alpha and bravo. */
export function openWorld(): void {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    db = await createFreshDatabase({ part: 'c59fo' });
    alpha = await insertBusiness(db.app, 'alpha');
    bravo = await insertBusiness(db.app, 'bravo');
  }, 60_000);

  afterAll(async () => await db?.drop());
}

export async function personIn(business: string, subject: string): Promise<string> {
  return await db.app.withBusiness(business, async (tx) => {
    const personId = await insertPerson(tx, 'Mia');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    return personId;
  });
}

export async function enrolHere(
  business: string,
  personId: string,
  subject: string,
  verify: boolean,
  endOthers = false,
): Promise<void> {
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

interface AuditRow {
  outcome: string;
  refusal_code: string | null;
  operation_id: string | null;
}

export async function events(business: string, command: string): Promise<readonly AuditRow[]> {
  return await db.app.withBusiness(business, (tx) =>
    tx.query<AuditRow>(
      'select outcome, refusal_code, operation_id from audit_events where command = $1 order by seq',
      [command],
    ),
  );
}


/** A provider's calls these cases never decide on: no factor listed, every sign-out done. */
const QUIET: Pick<FactorProvider, 'verifiedFactors' | 'signOut'> = {
  verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
  signOut: () => Promise.resolve({ ok: true, value: undefined }),
};
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
    ...QUIET,
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
  };
  return { provider, asked };
}

export async function race(
  removal: ProviderAnswer<void>,
  endOthers = false,
): Promise<{ code: string; asked: string[] }> {
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
export async function stepUpAfterSignOut(): Promise<{
  code: string;
  asked: string[];
  statuses: readonly { status: string }[];
}> {
  const subject = `sub-${randomUUID()}`;
  const person = await personIn(bravo, subject);
  await enrolHere(bravo, person, subject, true);
  const asked: string[] = [];
  const provider: FactorProvider = {
    ...QUIET,
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

export const callerFor = (subject: string): FactorCaller => ({
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
export async function factorIn(
  person: string,
  subject: string,
  verify: boolean,
): Promise<{ id: string; providerFactorId: string }> {
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

export const statusOf = async (person: string): Promise<readonly { status: string }[]> =>
  await db.app.withBusiness(bravo, (tx) =>
    tx.query<{ status: string }>(
      'select status from public.second_factors where person_id = $1 order by enrolled_at',
      [person],
    ),
  );

/** A provider naming each call, its verify running `during` first. */
export function namingProvider(during: () => Promise<void> = async () => {}): {
  provider: FactorProvider;
  asked: string[];
} {
  const asked: string[] = [];
  const session = { accessToken: 'aal2', refreshToken: 'r', expiresIn: 3600 };
  const provider: FactorProvider = {
    ...QUIET,
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
  };
  return { provider, asked };
}
