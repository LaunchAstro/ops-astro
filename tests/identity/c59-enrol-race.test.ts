// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: a login holds one verified second factor, in every business it
// reaches (0064), even when two businesses complete enrolments at the same
// moment. One login has an enrolment started, not yet completed, in alpha
// and in bravo; good codes for both go at once, on a pool wide enough for
// each to hold its own connection, against a stand-in provider that answers
// neither until both have reached it. So both pass their checks before
// either is recorded.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { recordFactorEnrolled } from '../../packages/core-records/src/identity/second-factor.ts';
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
  console.warn('C59 enrolment race: DATABASE_URL is unset, so nothing below ran.');
}

const GOOD = '123456';
const SESSION = { accessToken: 'aal2-access-token', refreshToken: 'refresh', expiresIn: 3600 };

let db: FreshDatabase;
let wide: Database;
let alpha: string;
let bravo: string;

/** One login with an unverified enrolment in alpha and in bravo, each its own provider factor. */
async function enrollingInBoth() {
  const subject = `sub-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const callers: Record<string, FactorCaller> = {};
  const factors: Record<string, string> = {};
  for (const business of [alpha, bravo]) {
    const providerFactorId = `factor-${randomUUID()}`;
    factors[business] = providerFactorId;
    // oxlint-disable-next-line no-await-in-loop
    await db.app.withBusiness(business, async (tx) => {
      const personId = await insertPerson(tx, 'Mia');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      await recordFactorEnrolled(tx, { personId, provider: 'supabase', providerFactorId });
    });
    callers[business] = {
      database: wide,
      businessId: business,
      presented: {
        provider: 'supabase',
        subject,
        assurance: { level: 'aal1', signedInAt: now, factorAt: null },
      },
      accessToken: 'aal1-access-token',
    };
  }
  return { subject, callers, factors };
}

/** A provider that accepts every code, answering none until `waitFor` codes have reached it. */
function gatedProvider(waitFor: number) {
  const asked: string[] = [];
  const removed: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  const provider: FactorProvider = {
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: async (_token, factorId) => {
      asked.push(factorId);
      if (asked.length >= waitFor) open();
      await gate;
      return { ok: true, value: SESSION } as const;
    },
    remove: (_token, factorId) => {
      removed.push(factorId);
      return done;
    },
    signOut: () => done,
  };
  return { provider, asked, removed };
}

const codeOf = (answer: unknown) =>
  typeof answer === 'object' && answer !== null && 'code' in answer
    ? String(answer.code)
    : 'served';

/** The login's factors recorded as verified, installation-wide (0064). */
async function verifiedBySubject(subject: string): Promise<number> {
  const rows = await db.admin.execute<{ readonly verified: number }>(
    `select count(*)::int as verified from ops.second_factor_subjects
      where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')
        and state = 'verified'`,
    [subject],
  );
  return rows[0]?.verified ?? 0;
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59er' });
  // One connection per request: on a narrower pool the transactions queue and
  // the race cannot happen.
  wide = connect(db.appUrl, { source: 'runtime', max: 4 });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
}, 60_000);

afterAll(async () => {
  await wide?.close();
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)('C59 one verified factor per login', () => {
  it('C59 enrolment race: two businesses completing enrolments at once leave one verified factor', async () => {
    const { subject, callers, factors } = await enrollingInBoth();
    const gated = gatedProvider(2);
    const answers = await Promise.all(
      [alpha, bravo].map(async (business) =>
        codeOf(await verifySecondFactor(callers[business]!, { code: GOOD }, gated.provider)),
      ),
    );

    expect(gated.asked).toHaveLength(2);
    expect(answers.toSorted()).toEqual(['FACTOR_ALREADY_ENROLLED', 'served']);
    expect(await verifiedBySubject(subject)).toBe(1);
    // The refused business's factor, just verified at the provider, is
    // removed there, so the provider is left holding no factor the app
    // does not record.
    const loser = answers[0] === 'served' ? bravo : alpha;
    expect(gated.removed).toEqual([factors[loser]]);
  });
});
