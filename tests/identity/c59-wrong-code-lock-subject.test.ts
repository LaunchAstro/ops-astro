// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the wrong-code lockout (five in fifteen minutes) is the login's, not
// one business's. The provider holds one factor per sign-in login, so a code
// sent through any business the login reaches is a guess at the same factor.
// Each case opens its own login, mapped to a person in alpha and in bravo,
// each holding a verified record of the one factor the provider holds.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  removeSecondFactor,
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
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
  console.warn('C59 wrong-code lock by login: DATABASE_URL is unset, so nothing below ran.');
}

/** How many requests the race fires at once. */
const AT_ONCE = 8;
const LIMIT = 5;
const WRONG = '000000';
const GOOD = '123456';

let db: FreshDatabase;
let wide: Database;
let alpha: string;
let bravo: string;

/** One login with a verified factor, as its factor routes see it in each business. */
async function loginInBoth(): Promise<Readonly<Record<string, FactorCaller>>> {
  const subject = `sub-${randomUUID()}`;
  const providerFactorId = `factor-${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const callers: Record<string, FactorCaller> = {};
  for (const business of [alpha, bravo]) {
    // oxlint-disable-next-line no-await-in-loop
    await db.app.withBusiness(business, async (tx) => {
      const personId = await insertPerson(tx, 'Mia');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      const enrolled = await recordFactorEnrolled(tx, {
        personId,
        provider: 'supabase',
        providerFactorId,
      });
      await recordFactorVerified(tx, { personId, factorId: enrolled.id, subject });
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
  return callers;
}

const SESSION = { accessToken: 'aal2-access-token', refreshToken: 'refresh', expiresIn: 3600 };

/**
 * A provider that refuses every code but `GOOD`, counting the codes it is
 * asked, and holding its answers until `release` is called.
 */
function countingProvider() {
  const asked: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  const provider: FactorProvider = {
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: async (_token, _factor, code) => {
      asked.push(code);
      await gate;
      return code === GOOD
        ? ({ ok: true, value: SESSION } as const)
        : ({ ok: false, fault: 'refused' } as const);
    },
    remove: () => done,
    signOut: () => done,
  };
  return { provider, asked, release: open };
}

const times = (n: number, code: string) => Array.from({ length: n }, () => code);

const codeOf = (answer: unknown) =>
  typeof answer === 'object' && answer !== null && 'code' in answer
    ? String(answer.code)
    : 'served';

/** Send `codes` one after another through `caller`, answering each refusal code. */
async function inTurn(caller: FactorCaller, codes: readonly string[], provider: FactorProvider) {
  const answers: string[] = [];
  for (const code of codes) {
    // oxlint-disable-next-line no-await-in-loop
    answers.push(codeOf(await verifySecondFactor(caller, { code }, provider)));
  }
  return answers;
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59ws' });
  // One connection per request: on a narrower pool the transactions queue and
  // the race cannot happen.
  wide = connect(db.appUrl, { source: 'runtime', max: AT_ONCE });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
}, 60_000);

afterAll(async () => {
  await wide?.close();
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)('C59 the wrong-code lock in every business', () => {
  it('C59 wrong-code lock: five wrong codes through one business lock the login in another', async () => {
    const callers = await loginInBoth();
    const counting = countingProvider();
    counting.release();
    const first = await inTurn(callers[alpha]!, times(LIMIT, WRONG), counting.provider);
    expect(first).toEqual(times(LIMIT, 'SECOND_FACTOR_INVALID'));

    const sixth = await inTurn(callers[bravo]!, [WRONG], counting.provider);
    expect(sixth).toEqual(['SECOND_FACTOR_LOCKED']);
    const removal = await removeSecondFactor(callers[bravo]!, { code: GOOD }, counting.provider);
    expect(codeOf(removal)).toBe('SECOND_FACTOR_LOCKED');
    expect(counting.asked).toHaveLength(LIMIT);
  });
});

describe.skipIf(serverUrl === undefined)('C59 the wrong-code lock in every business', () => {
  it('C59 wrong-code lock: eight wrong codes at once over two businesses reach the provider at most five times', async () => {
    const callers = await loginInBoth();
    const counting = countingProvider();
    let answeredFirst = 0;
    let released = false;
    const tick = () => {
      if (!released && counting.asked.length + answeredFirst >= AT_ONCE) {
        released = true;
        counting.release();
      }
    };
    // The provider answers once every request has reached it or been
    // answered without it, so every one passes its check before any answer.
    const poll = setInterval(tick, 5);
    const codes = await Promise.all(
      Array.from({ length: AT_ONCE }, async (_, index) => {
        const caller = callers[index % 2 === 0 ? alpha : bravo]!;
        const answer = await verifySecondFactor(caller, { code: WRONG }, counting.provider);
        if (!released) answeredFirst += 1;
        tick();
        return codeOf(answer);
      }),
    ).finally(() => clearInterval(poll));

    expect(counting.asked.length).toBeLessThanOrEqual(LIMIT);
    const locked = codes.filter((code) => code === 'SECOND_FACTOR_LOCKED');
    expect(locked).toHaveLength(AT_ONCE - counting.asked.length);
  });
});

describe.skipIf(serverUrl === undefined)('C59 the wrong-code lock in every business', () => {
  it('C59 wrong-code lock: a good code through one business is not counted against the login', async () => {
    const callers = await loginInBoth();
    const counting = countingProvider();
    counting.release();
    expect(await inTurn(callers[alpha]!, times(4, WRONG), counting.provider)).toEqual(
      times(4, 'SECOND_FACTOR_INVALID'),
    );
    // A good code, then a fifth wrong one, through bravo: both are asked.
    expect(await inTurn(callers[bravo]!, [GOOD, WRONG], counting.provider)).toEqual([
      'served',
      'SECOND_FACTOR_INVALID',
    ]);
    // Five wrong codes now stand against the login, through either business.
    expect(await inTurn(callers[alpha]!, [WRONG], counting.provider)).toEqual([
      'SECOND_FACTOR_LOCKED',
    ]);
    expect(counting.asked).toHaveLength(6);
  });
});
