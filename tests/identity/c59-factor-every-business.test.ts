// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the second factor belongs to the sign-in login, not to one business.
// The provider holds one set of factors per subject, so a factor verified
// through alpha is the login's factor in bravo too: a password-only (aal1)
// sign-in is refused in every business the login reaches, removing the
// factor serves it again in every one, and no business starts a second
// enrolment for it, nor completes one started before the factor was verified
// elsewhere. Each case opens its own login, mapped to a person in alpha
// and a person in bravo.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enrolSecondFactor,
  removeSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  liveFactor,
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import type { AssuranceLevel } from '../../packages/core-records/src/identity/verified-subject.ts';
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
  console.warn('C59 factor in every business: DATABASE_URL is unset, so nothing below ran.');
}

let db: FreshDatabase;
let alpha: string;
let bravo: string;

/** One login, a person in each business. */
interface Login {
  readonly subject: string;
  readonly person: Readonly<Record<string, string>>;
}

async function loginInBoth(): Promise<Login> {
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
  return { subject, person };
}

/** The refusal code, or `served`. */
async function signIn(login: Login, business: string, level: AssuranceLevel): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const resolved = await db.app.withBusiness(business, (tx) =>
    resolveLogin(tx, {
      provider: 'supabase',
      subject: login.subject,
      assurance: { level, signedInAt: now, factorAt: level === 'aal2' ? now : null },
    }),
  );
  return 'refused' in resolved ? resolved.code : 'served';
}

/** Enrol and verify a factor through `business`, as the factor routes record it. */
async function verifyThrough(login: Login, business: string): Promise<string> {
  return await db.app.withBusiness(business, async (tx) => {
    const personId = login.person[business] ?? '';
    const enrolled = await recordFactorEnrolled(tx, {
      personId,
      provider: 'supabase',
      providerFactorId: `factor-${randomUUID()}`,
    });
    const factor = { personId, factorId: enrolled.id, subject: login.subject };
    await recordFactorVerified(tx, factor);
    return enrolled.id;
  });
}

async function removeThrough(login: Login, business: string, factorId: string): Promise<void> {
  await db.app.withBusiness(business, async (tx) => {
    const factor = { personId: login.person[business] ?? '', factorId, subject: login.subject };
    await recordFactorRemoved(tx, factor);
  });
}

const everywhere = async (login: Login, level: AssuranceLevel) => [
  await signIn(login, alpha, level),
  await signIn(login, bravo, level),
];

const REFUSED = 'AUTH_SECOND_FACTOR_REQUIRED';

/** A provider that issues a factor to anyone, as one that does not hold AAL2 to enrol would. */
function lenientProvider(asked: string[]): FactorProvider {
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  return {
    enrol: () => {
      asked.push('enrol');
      const factorId = `factor-${randomUUID()}`;
      const issued = { factorId, qrCode: 'qr', secret: 'secret', uri: 'otpauth:' };
      return Promise.resolve({ ok: true, value: issued } as const);
    },
    verify: () => Promise.resolve({ ok: false, fault: 'refused' }),
    remove: () => done,
    signOut: () => done,
  };
}

/** A provider that answers every call yes, naming each call it is asked. */
function answeringProvider(asked: string[]): FactorProvider {
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  const session = { accessToken: 'aal2-access-token', refreshToken: 'refresh', expiresIn: 3600 };
  return {
    ...lenientProvider(asked),
    verify: () => {
      asked.push('verify');
      return Promise.resolve({ ok: true, value: session } as const);
    },
    remove: () => {
      asked.push('remove');
      return done;
    },
  };
}

/** The login, on a fresh password-only sign-in, at `business`'s factor routes. */
function callerIn(login: Login, business: string): FactorCaller {
  const now = Math.floor(Date.now() / 1000);
  return {
    database: db.app,
    businessId: business,
    presented: {
      provider: 'supabase',
      subject: login.subject,
      assurance: { level: 'aal1', signedInAt: now, factorAt: null },
    },
    accessToken: 'aal1-access-token',
  };
}

/** An enrolment through `business` on a fresh password-only sign-in: the refusal code, or `issued`. */
async function enrolThrough(login: Login, business: string, provider: FactorProvider) {
  const answer = await enrolSecondFactor(callerIn(login, business), provider);
  return 'code' in answer ? answer.code : 'issued';
}

/** The status of the person's live factor in `business`, or `none`. */
async function factorStatus(login: Login, business: string): Promise<string> {
  const live = await db.app.withBusiness(business, (tx) =>
    liveFactor(tx, login.person[business] ?? ''),
  );
  return live?.status ?? 'none';
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59fe' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('C59 the second factor is the login’s', () => {
  it('C59: a factor verified in one business refuses a password-only sign-in in every business the login reaches', async () => {
    const mia = await loginInBoth();
    expect(await everywhere(mia, 'aal1')).toEqual(['served', 'served']);

    await verifyThrough(mia, alpha);

    expect(await everywhere(mia, 'aal1')).toEqual([REFUSED, REFUSED]);
    expect(await everywhere(mia, 'aal2')).toEqual(['served', 'served']);
    // Another login in the same two businesses has no factor, and needs none.
    expect(await everywhere(await loginInBoth(), 'aal1')).toEqual(['served', 'served']);
  });

  it('C59: removing the factor in one business serves a password-only sign-in in every business again', async () => {
    const mia = await loginInBoth();
    const factor = await verifyThrough(mia, alpha);
    expect(await everywhere(mia, 'aal1')).toEqual([REFUSED, REFUSED]);

    await removeThrough(mia, alpha, factor);

    expect(await everywhere(mia, 'aal1')).toEqual(['served', 'served']);
  });

  it('C59: removing one factor leaves another the login verified elsewhere standing everywhere', async () => {
    const mia = await loginInBoth();
    const first = await verifyThrough(mia, alpha);
    await verifyThrough(mia, bravo);

    await removeThrough(mia, alpha, first);

    expect(await everywhere(mia, 'aal1')).toEqual([REFUSED, REFUSED]);
  });

  it('C59: a login with a factor verified in one business cannot start a second enrolment in another', async () => {
    const mia = await loginInBoth();
    await verifyThrough(mia, alpha);
    const asked: string[] = [];

    expect(await enrolThrough(mia, bravo, lenientProvider(asked))).toBe('FACTOR_ALREADY_ENROLLED');
    expect(asked).toEqual([]);
    // A login with no factor anywhere still enrols.
    expect(await enrolThrough(await loginInBoth(), bravo, lenientProvider(asked))).toBe('issued');
  });
});

describe.skipIf(serverUrl === undefined)(
  'C59 a factor is completed and removed where it is held',
  () => {
    it('C59: an enrolment started in one business cannot be completed once a factor is verified in another', async () => {
      const mia = await loginInBoth();
      const asked: string[] = [];
      expect(await enrolThrough(mia, bravo, answeringProvider(asked))).toBe('issued');
      const factor = await verifyThrough(mia, alpha);
      asked.length = 0;

      const answer = await verifySecondFactor(
        callerIn(mia, bravo),
        { code: '123456' },
        answeringProvider(asked),
      );

      expect('code' in answer ? answer.code : 'verified').toBe('FACTOR_ALREADY_ENROLLED');
      expect(asked).toEqual([]);
      expect(await factorStatus(mia, bravo)).toBe('unverified');
      // The login keeps exactly one live verified factor: removing alpha's frees it everywhere.
      await removeThrough(mia, alpha, factor);
      expect(await everywhere(mia, 'aal1')).toEqual(['served', 'served']);
    });

    it('C59: a factor is removed where it was verified; another business holding none answers not enrolled', async () => {
      const mia = await loginInBoth();
      const asked: string[] = [];
      expect(await enrolThrough(mia, bravo, answeringProvider(asked))).toBe('issued');
      await verifyThrough(mia, alpha);
      asked.length = 0;

      const answer = await removeSecondFactor(
        callerIn(mia, bravo),
        { code: '123456' },
        answeringProvider(asked),
      );

      expect('code' in answer ? answer.code : 'removed').toBe('FACTOR_NOT_ENROLLED');
      expect(asked).toEqual([]);
      expect(await factorStatus(mia, bravo)).toBe('unverified');
      expect(await factorStatus(mia, alpha)).toBe('verified');
      expect(await everywhere(mia, 'aal1')).toEqual([REFUSED, REFUSED]);
    });
  },
);
