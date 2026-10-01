// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: a code stops counting toward the wrong-code lockout (five in fifteen
// minutes) only when the provider proved it good. A provider that answers a
// code slowly, not at all or in a shape it should not may still have checked
// the guess, so such a code keeps counting: the fail-closed choice, at worst
// a fifteen-minute lockout during a provider outage.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type {
  FactorProvider,
  ProviderFault,
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
  console.warn('C59 wrong code at a provider fault: DATABASE_URL is unset, so nothing below ran.');
}

const LIMIT = 5;

let db: FreshDatabase;
let alpha: string;

/** A person with a verified factor, as their factor routes see them on a password sign-in. */
async function personWithFactor(): Promise<FactorCaller> {
  const subject = `sub-${randomUUID()}`;
  await db.app.withBusiness(alpha, async (tx) => {
    const personId = await insertPerson(tx, 'Mia');
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
  return {
    database: db.app,
    businessId: alpha,
    presented: {
      provider: 'supabase',
      subject,
      assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000), factorAt: null },
    },
    accessToken: 'aal1-access-token',
  };
}

/** A provider whose every answer to a code is `fault`, counting the codes it is asked. */
function faultyProvider(fault: ProviderFault) {
  const asked: string[] = [];
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  const provider: FactorProvider = {
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: (_token, _factor, code) => {
      asked.push(code);
      return Promise.resolve({ ok: false, fault });
    },
    remove: () => done,
    signOut: () => done,
    list: () => Promise.resolve({ ok: true, value: [] }),
  };
  return { provider, asked };
}

const codeOf = (answer: unknown) =>
  typeof answer === 'object' && answer !== null && 'code' in answer
    ? String(answer.code)
    : 'served';

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59pf' });
  alpha = await insertBusiness(db.app, 'alpha');
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)('C59 the wrong-code lock at a provider fault', () => {
  it('C59 wrong-code lock: five codes the provider answered slowly lock the login', async () => {
    const caller = await personWithFactor();
    const slow = faultyProvider('slow');
    const answers: string[] = [];
    for (let sent = 0; sent <= LIMIT; sent += 1) {
      // oxlint-disable-next-line no-await-in-loop
      answers.push(codeOf(await verifySecondFactor(caller, { code: '000000' }, slow.provider)));
    }

    expect(answers.slice(0, LIMIT)).toEqual(
      Array.from({ length: LIMIT }, () => 'PROVIDER_ANSWER_INVALID'),
    );
    expect(answers[LIMIT]).toBe('SECOND_FACTOR_LOCKED');
    expect(slow.asked).toHaveLength(LIMIT);
  });
});
