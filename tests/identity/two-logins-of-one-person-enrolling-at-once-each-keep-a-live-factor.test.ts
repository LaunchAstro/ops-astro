// SPDX-License-Identifier: AGPL-3.0-only
//
// The provider holds one set of factors per sign-in login, so two logins of
// one person enrol two factors, and each is its own login's to complete. Both
// logins set up an authenticator at once, each on its own connection, against
// a stand-in provider that answers neither enrolment until both have reached
// it, so both pass their checks before either is recorded. Afterwards both
// factors are live at the same moment, each recorded under its own login's
// subject digest with the provider id issued to that login. Neither replaced
// the other.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  enrolSecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { liveFactor } from '../../packages/core-records/src/identity/second-factor.ts';
import { connect, type BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { gate } from '../support/lock-waits.ts';
import { insertBusiness, insertLogin, insertMapping } from './fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorbothlogins' });
  business = (await insertBusiness(db.app, 'factor-both-logins')) as BusinessId;
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The provider calls an enrolment never makes. */
const unused = () => Promise.resolve({ ok: false, fault: 'refused' } as const);

/** A provider whose enrolments wait at a barrier until `expected` have arrived; each issues `factor-<token>`. */
function barrierProvider(expected: number): FactorProvider {
  const arrived = gate();
  let count = 0;
  return {
    verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
    heldFactors: () => Promise.resolve({ ok: true, value: [] }),
    signOut: () => Promise.resolve({ ok: true, value: undefined }),
    verify: unused,
    remove: unused,
    enrol: async (token) => {
      count += 1;
      if (count === expected) arrived.release();
      await arrived.promise;
      const value = { factorId: `factor-${token}`, qrCode: 'qr', secret: 's', uri: 'otpauth:' };
      return { ok: true, value };
    },
  };
}

/** `subject` signed in with a password a moment ago, on a connection of its own. */
const onItsOwnConnection = (subject: string, token: string): FactorCaller => ({
  database: connect(db.appUrl),
  businessId: business,
  accessToken: token,
  presented: {
    provider: 'supabase',
    subject,
    sessionId: randomUUID(),
    assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 2, factorAt: null },
  },
});

it('two logins of one person enrolling at once both end with a live factor, each under its own subject', async () => {
  const person = await enrol(db.app, business, 'Two logins at once');
  const first = person.presented.subject;
  const second = `second-login-${randomUUID()}`;
  await db.app.withBusiness(business, async (tx) => {
    await insertMapping(tx, await insertLogin(tx, second), person.personId, person.actorId);
  });
  const callers = [onItsOwnConnection(first, 'first'), onItsOwnConnection(second, 'second')];
  const provider = barrierProvider(callers.length);
  try {
    const answers = await Promise.all(callers.map((caller) => enrolSecondFactor(caller, provider)));
    const live = await db.admin.execute<{ factor: string; subject: string | null }>(
      `select provider_factor_id as factor, to_jsonb(f) ->> 'subject_digest' as subject
         from public.second_factors f
        where business_id = $1 and person_id = $2 and status <> 'removed'
        order by provider_factor_id`,
      [business, person.personId],
    );
    const read = async (subject: string) =>
      (await db.app.withBusiness(business, (tx) => liveFactor(tx, person.personId, subject)))
        ?.providerFactorId;
    expect({
      answers: answers.map((answer) => ('factorId' in answer ? answer.factorId : answer.code)),
      live,
      byLogin: { first: await read(first), second: await read(second) },
    }).toEqual({
      answers: ['factor-first', 'factor-second'],
      live: [
        { factor: 'factor-first', subject: digest(first) },
        { factor: 'factor-second', subject: digest(second) },
      ],
      byLogin: { first: 'factor-first', second: 'factor-second' },
    });
  } finally {
    await Promise.all(callers.map(async (caller) => await caller.database.close()));
  }
});
