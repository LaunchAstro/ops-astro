// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: a login that verified its authenticator through alpha is asked for its
// code in bravo too, so bravo's factor step checks that code against the same
// factor, though bravo holds no factor row for the person. The provider lists
// the login's verified factors; only the one alpha's record holds is checked,
// it is checked again under the login's lock once the provider has proved the
// code, and nothing is recorded in bravo. Each case opens its own login,
// mapped to a person in alpha and a person in bravo.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import {
  liveFactor,
  recordFactorEnrolled,
  recordFactorRemoved,
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
  console.warn('C59 code in another business: DATABASE_URL is unset, so nothing below ran.');
}

let db: FreshDatabase;
let alpha: string;
let bravo: string;

/** A login with a person in each business, and its factor verified through alpha. */
async function verifiedInAlpha() {
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
  const personId = person[alpha] ?? '';
  const factorId = await db.app.withBusiness(alpha, async (tx) => {
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: 'factor-alpha',
    });
    await recordFactorVerified(tx, { personId, factorId: enrolled.id, subject });
    return enrolled.id;
  });
  const removeInAlpha = async () =>
    await db.app.withBusiness(alpha, (tx) =>
      recordFactorRemoved(tx, { personId, factorId, subject }),
    );
  return { subject, bravoPerson: person[bravo] ?? '', removeInAlpha };
}

/** A provider listing `listed` as the login's verified factors and proving any code. */
function listingProvider(
  asked: string[],
  listed: readonly string[],
  meanwhile: () => Promise<unknown> = () => Promise.resolve(),
): FactorProvider {
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  const session = { accessToken: 'aal2-access-token', refreshToken: 'refresh', expiresIn: 3600 };
  return {
    verifiedFactors: () => {
      asked.push('list');
      return Promise.resolve({ ok: true, value: listed } as const);
    },
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: async (_token, factorId) => {
      asked.push(`verify ${factorId}`);
      await meanwhile();
      return { ok: true, value: session } as const;
    },
    remove: () => done,
    signOut: () => done,
  };
}

/**
 * The real GoTrue adapter, as the server builds it, over a provider whose user
 * carries 20,000 characters of profile metadata beside the login's one verified
 * factor, and which proves any code with a compact session.
 */
function largeUserProvider(asked: string[]): FactorProvider {
  const fetch: typeof globalThis.fetch = (input, init) => {
    const path = new URL(String(input)).pathname.replace('/auth/v1', '');
    asked.push(`${init?.method} ${path}`);
    if (path === '/user') {
      return Promise.resolve(
        Response.json({
          id: 'user-one',
          user_metadata: { profile: 'x'.repeat(20_000) },
          factors: [{ id: 'factor-alpha', factor_type: 'totp', status: 'verified' }],
        }),
      );
    }
    if (path.endsWith('/challenge')) return Promise.resolve(Response.json({ id: 'challenge-one' }));
    return Promise.resolve(
      Response.json({
        access_token: 'aal2-access-token',
        refresh_token: 'refresh',
        expires_in: 3600,
      }),
    );
  };
  return createGoTrueFactors({ baseUrl: 'http://identity.invalid/auth/v1', fetch });
}

/** The login's code at bravo's factor route, on a password-only sign-in: the refusal code or token. */
async function codeInBravo(
  subject: string,
  provider: FactorProvider,
  businessId: string = bravo,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const caller: FactorCaller = {
    database: db.app,
    businessId,
    presented: {
      provider: 'supabase',
      subject,
      assurance: { level: 'aal1', signedInAt: now, factorAt: null },
    },
    accessToken: 'aal1-access-token',
  };
  const answer = await verifySecondFactor(caller, { code: '123456' }, provider);
  return 'code' in answer ? answer.code : answer.accessToken;
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59ab' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('C59 a code in a business holding no factor', () => {
  it('C59: the code is checked against the factor the login verified in another business', async () => {
    const mia = await verifiedInAlpha();
    const asked: string[] = [];
    const provider = listingProvider(asked, ['factor-stray', 'factor-alpha']);

    expect(await codeInBravo(mia.subject, provider)).toBe('aal2-access-token');
    expect(asked).toEqual(['list', 'verify factor-alpha']);
    // Nothing is recorded in bravo: the factor stays held, and removed, where it was verified.
    const live = await db.app.withBusiness(bravo, (tx) => liveFactor(tx, mia.bravoPerson));
    expect(live).toBeUndefined();
  });

  it('C59: a provider factor the login never verified through any business is not checked', async () => {
    const mia = await verifiedInAlpha();
    const asked: string[] = [];

    expect(await codeInBravo(mia.subject, listingProvider(asked, ['factor-stray']))).toBe(
      'FACTOR_NOT_ENROLLED',
    );
    expect(asked).toEqual(['list']);
  });

  it('C59: a factor removed in another business while its code is at the provider is refused', async () => {
    const mia = await verifiedInAlpha();
    const asked: string[] = [];
    const provider = listingProvider(asked, ['factor-alpha'], mia.removeInAlpha);

    expect(await codeInBravo(mia.subject, provider)).toBe('FACTOR_NOT_ENROLLED');
    expect(asked).toEqual(['list', 'verify factor-alpha']);
  });

  it('C59: a login whose provider user is large still completes its code in another business, and never locks', async () => {
    const mia = await verifiedInAlpha();
    const asked: string[] = [];
    const provider = largeUserProvider(asked);

    expect(await codeInBravo(mia.subject, provider, alpha)).toBe('aal2-access-token');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each code after the last, as a person retries
      expect(await codeInBravo(mia.subject, provider)).toBe('aal2-access-token');
    }
    expect(asked.filter((call) => call === 'GET /user')).toHaveLength(6);
  });
});
