// SPDX-License-Identifier: AGPL-3.0-only
//
// A second factor is the sign-in login's, not the person's: a person reached
// by two logins, one of which verified an authenticator, is asked for a code
// only on that login. The other login has no factor at the provider, so a code
// asked of it is one it can never give, and it sets up, completes and removes
// its own authenticator beside the first login's, which stays as it was.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { insertBusiness, insertLogin, insertMapping } from '../identity/fixture.ts';

let db: FreshDatabase;
let business: string;
let elsewhere: string;

beforeAll(async () => {
  db = await createFreshDatabase({ part: 'factorlogin' });
  business = await insertBusiness(db.app, 'factor-login');
  elsewhere = await insertBusiness(db.app, 'factor-login-elsewhere');
}, 120_000);

afterAll(async () => await db?.drop());

/** A verified factor of `member`'s own login, recorded as the factor routes record one. */
async function verifiedFactor(member: Member, at = business): Promise<string> {
  const providerFactorId = `factor-${randomUUID()}`;
  const { personId, presented } = member;
  await db.app.withBusiness(at, async (tx) => {
    const { subject } = presented;
    const factor = await recordFactorEnrolled(tx, {
      personId,
      subject,
      provider: 'supabase',
      providerFactorId,
    });
    await recordFactorVerified(tx, { personId, factorId: factor.id, subject });
  });
  return providerFactorId;
}

/** A person with a verified factor on their first login, and a second login of theirs. */
async function twoLogins(): Promise<{ person: Member; first: string; second: string }> {
  const person = await enrol(db.app, business, 'Two logins');
  const second = `second-login-${randomUUID()}`;
  await db.app.withBusiness(business, async (tx) => {
    await insertMapping(tx, await insertLogin(tx, second), person.personId, person.actorId);
  });
  return { person, first: await verifiedFactor(person), second };
}

/** `subject` signed in with a password a moment ago, acting on its own account here. */
const signedIn = (subject: string): FactorCaller => ({
  database: db.app,
  businessId: business as BusinessId,
  accessToken: `token-${subject}`,
  presented: {
    provider: 'supabase',
    subject,
    sessionId: randomUUID(),
    assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 2, factorAt: null },
  },
});

/** A provider that issues one new factor per enrolment and names every call it takes. */
function namingProvider(): { provider: FactorProvider; asked: string[] } {
  const asked: string[] = [];
  const session = { accessToken: 'aal2', refreshToken: 'r', expiresIn: 3600 };
  const provider: FactorProvider = {
    verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
    heldFactors: () => Promise.resolve({ ok: true, value: [] }),
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
    enrol: () => {
      const factorId = `factor-${randomUUID()}`;
      asked.push(`enrol ${factorId}`);
      return Promise.resolve({
        ok: true,
        value: { factorId, qrCode: 'qr', secret: 's', uri: 'otpauth:' },
      });
    },
    verify: (_token, factorId) => {
      asked.push(`verify ${factorId}`);
      return Promise.resolve({ ok: true, value: session });
    },
    remove: (_token, factorId) => {
      asked.push(`remove ${factorId}`);
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
  return { provider, asked };
}

/** The person's live factor held by `subject`: its provider id and status, or `none`. */
const heldBy = async (personId: string, subject: string) => {
  const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, personId, subject));
  return live === undefined ? 'none' : `${live.providerFactorId} ${live.status}`;
};

it('a factor verified on one login asks no code of another login mapped to the same person', async () => {
  const { person, second } = await twoLogins();
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
    resolveLogin(tx, { provider: 'supabase', subject: second, assurance: passwordOnly }),
  );
  expect('refused' in other ? other.code : 'served').toBe('served');
});

it("a second login of the person sets up, completes and removes its own factor, and the first login's stays verified", async () => {
  const { person, first, second } = await twoLogins();
  const { provider, asked } = namingProvider();
  const caller = signedIn(second);
  const issued = await enrolSecondFactor(caller, provider);
  const own = 'factorId' in issued ? issued.factorId : issued.code;
  const enrolled = {
    first: await heldBy(person.personId, person.presented.subject),
    second: await heldBy(person.personId, second),
  };
  const verified = await verifySecondFactor(caller, { code: '123456' }, provider);
  const completed = await heldBy(person.personId, second);
  const removed = await removeSecondFactor(caller, { code: '123456' }, provider);
  expect({
    enrolled,
    verified: 'code' in verified ? verified.code : 'verified',
    completed,
    removed: 'code' in removed ? removed.code : 'removed',
    asked,
    after: {
      first: await heldBy(person.personId, person.presented.subject),
      second: await heldBy(person.personId, second),
    },
  }).toEqual({
    enrolled: { first: `${first} verified`, second: `${own} unverified` },
    verified: 'verified',
    completed: `${own} verified`,
    removed: 'removed',
    asked: [`enrol ${own}`, `verify ${own}`, `verify ${own}`, `remove ${own}`],
    after: { first: `${first} verified`, second: 'none' },
  });
});

/** Every factor row of these people in `at`, read past row security, in one order. */
const rowsOf = async (at: string, people: readonly string[]) =>
  await db.admin.execute(
    `select row_to_json(f)::text as row from public.second_factors f
      where business_id = $1 and person_id = any($2::uuid[]) order by id`,
    [at, people],
  );

it("one login's factor acts leave another person's rows and another business's rows as they were", async () => {
  const { second } = await twoLogins();
  const bystander = await enrol(db.app, business, 'Bystander');
  await verifiedFactor(bystander);
  const away = await enrol(db.app, elsewhere, 'Elsewhere');
  await verifiedFactor(away, elsewhere);
  const before = {
    here: await rowsOf(business, [bystander.personId]),
    there: await rowsOf(elsewhere, [away.personId]),
  };
  const { provider } = namingProvider();
  const caller = signedIn(second);
  await enrolSecondFactor(caller, provider);
  await verifySecondFactor(caller, { code: '123456' }, provider);
  await removeSecondFactor(caller, { code: '123456' }, provider);
  expect({
    here: await rowsOf(business, [bystander.personId]),
    there: await rowsOf(elsewhere, [away.personId]),
  }).toEqual(before);
  expect(before.here.length + before.there.length).toBe(2);
});
