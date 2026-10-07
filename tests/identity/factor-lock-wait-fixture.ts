// SPDX-License-Identifier: AGPL-3.0-only
//
// What the factor lock-wait proofs share: a provider that answers every call
// as done, a member signed in a moment ago, the same login in a second
// business, the three acts, and the login's factor lock key.

import { createHash, randomUUID } from 'node:crypto';
import {
  enrolSecondFactor,
  removeSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

/** A provider that answers every call as done, and records each factor it removes. */
export function provider(removed: string[]): FactorProvider {
  return {
    verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
    enrol: () =>
      Promise.resolve({
        ok: true,
        value: {
          factorId: `factor-${randomUUID()}`,
          qrCode: 'local qr',
          secret: 'local secret',
          uri: 'otpauth:',
        },
      }),
    verify: () =>
      Promise.resolve({
        ok: true,
        value: { accessToken: 'local-elevated-bearer', refreshToken: 'local', expiresIn: 3600 },
      }),
    remove: (_token, factorId) => {
      removed.push(factorId);
      return Promise.resolve({ ok: true, value: undefined });
    },
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
  };
}

/** A member signed in a moment ago with a password, holding a verified factor unless enrolling. */
export async function factorCaller(
  db: FreshDatabase,
  business: BusinessId,
  verified: boolean,
): Promise<{ caller: FactorCaller; person: string }> {
  const subject = `factor-${randomUUID()}`;
  const person = await db.app.withBusiness(business, async (tx) => {
    const personId = await insertPerson(tx, 'Factor holder');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    if (verified) {
      const factor = await recordFactorEnrolled(tx, {
        personId,
        provider: 'supabase',
        providerFactorId: `factor-${randomUUID()}`,
      });
      await recordFactorVerified(tx, { personId, factorId: factor.id, subject });
    }
    return personId;
  });
  return {
    person,
    caller: {
      database: db.app,
      businessId: business,
      accessToken: 'local-test-bearer',
      presented: {
        provider: 'supabase',
        subject,
        sessionId: randomUUID(),
        assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 2, factorAt: null },
      },
    },
  };
}

/** The same login, mapped to its own person in a second business. */
export async function standingElsewhere(
  db: FreshDatabase,
  subject: string,
): Promise<{ business: BusinessId; person: string }> {
  const elsewhere = (await insertBusiness(
    db.app,
    `factor-elsewhere-${randomUUID()}`,
  )) as BusinessId;
  const person = await db.app.withBusiness(elsewhere, async (tx) => {
    const personId = await insertPerson(tx, 'Factor holder elsewhere');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    return personId;
  });
  return { business: elsewhere, person };
}

type Act = (on: FactorCaller, to: FactorProvider) => Promise<unknown>;

export const ACTS: { readonly enrol: Act; readonly verify: Act; readonly remove: Act } = {
  enrol: (on, to) => enrolSecondFactor(on, to),
  verify: (on, to) => verifySecondFactor(on, { code: '123456' }, to),
  remove: (on, to) => removeSecondFactor(on, { code: '123456' }, to),
};

/** The login's factor lock, as `liveFactor` takes it. */
export const factorLockKey = (subject: string): string =>
  `second-factor-subject:${createHash('sha256').update(subject).digest('hex')}`;
