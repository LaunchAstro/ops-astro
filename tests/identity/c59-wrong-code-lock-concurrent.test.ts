// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the wrong-code lockout (five in fifteen minutes) holds when the codes
// arrive at once. Each case fires several requests together on a pool wide
// enough for every one to hold its own connection, against a stand-in
// provider that counts the codes it is asked and answers none until every
// request has either reached it or been answered without it. So a check that
// counted only the failures already recorded would let all of them through.

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
  console.warn('C59 wrong-code lock: DATABASE_URL is unset, so nothing below ran.');
}

/** How many requests each race fires at once. */
const AT_ONCE = 8;
const LIMIT = 5;

let db: FreshDatabase;
let wide: Database;
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
  const now = Math.floor(Date.now() / 1000);
  return {
    database: wide,
    businessId: alpha,
    presented: {
      provider: 'supabase',
      subject,
      assurance: { level: 'aal1', signedInAt: now, factorAt: null },
    },
    accessToken: 'aal1-access-token',
  };
}

const SESSION = { accessToken: 'aal2-access-token', refreshToken: 'refresh', expiresIn: 3600 };

/**
 * A provider that refuses every code (or accepts `good`), counting the codes
 * it is asked, and holding its answers until `release` is called.
 */
function countingProvider(good?: string) {
  const asked: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const done = Promise.resolve({ ok: true, value: undefined } as const);
  const provider: FactorProvider = {
    verifiedFactors: () => Promise.resolve({ ok: true, value: [] }),
    enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
    verify: async (_token, _factor, code) => {
      asked.push(code);
      await gate;
      return code === good
        ? ({ ok: true, value: SESSION } as const)
        : ({ ok: false, fault: 'refused' } as const);
    },
    remove: () => done,
    signOut: () => done,
  };
  return { provider, asked, release: open };
}

/**
 * Fire `requests` together. The provider's gate opens once every request has
 * either reached the provider or been answered without it, so every request
 * passes its check before any code is answered. Answers the refusal codes.
 */
async function race(
  counting: ReturnType<typeof countingProvider>,
  requests: readonly (() => Promise<unknown>)[],
): Promise<readonly string[]> {
  let answeredFirst = 0;
  let released = false;
  const tick = () => {
    if (!released && counting.asked.length + answeredFirst >= requests.length) {
      released = true;
      counting.release();
    }
  };
  const poll = setInterval(tick, 5);
  try {
    const answers = await Promise.all(
      requests.map(async (request) => {
        const answer = await request();
        if (!released) answeredFirst += 1;
        tick();
        return answer;
      }),
    );
    return answers.map((answer) =>
      typeof answer === 'object' && answer !== null && 'code' in answer
        ? String(answer.code)
        : 'served',
    );
  } finally {
    clearInterval(poll);
  }
}

const count = (codes: readonly string[], code: string) =>
  codes.filter((each) => each === code).length;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59wl' });
  // One connection per request: on a narrower pool the transactions queue and
  // the race cannot happen.
  wide = connect(db.appUrl, { source: 'runtime', max: AT_ONCE });
  alpha = await insertBusiness(db.app, 'alpha');
}, 60_000);

afterAll(async () => {
  await wide?.close();
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)(
  'C59 the wrong-code lock under concurrent requests',
  () => {
    it('C59 wrong-code lock: eight wrong codes at once reach the provider at most five times', async () => {
      const caller = await personWithFactor();
      const counting = countingProvider();
      const codes = await race(
        counting,
        Array.from(
          { length: AT_ONCE },
          () => async () => await verifySecondFactor(caller, { code: '000000' }, counting.provider),
        ),
      );

      expect(counting.asked.length).toBeLessThanOrEqual(LIMIT);
      expect(count(codes, 'SECOND_FACTOR_INVALID')).toBe(counting.asked.length);
      expect(count(codes, 'SECOND_FACTOR_LOCKED')).toBe(AT_ONCE - counting.asked.length);
    });

    it('C59 wrong-code lock: verifying and removing at once share the one count of five', async () => {
      const caller = await personWithFactor();
      const counting = countingProvider();
      const codes = await race(
        counting,
        Array.from({ length: AT_ONCE }, (_, index) =>
          index % 2 === 0
            ? async () => await verifySecondFactor(caller, { code: '000000' }, counting.provider)
            : async () => await removeSecondFactor(caller, { code: '000000' }, counting.provider),
        ),
      );

      expect(counting.asked.length).toBeLessThanOrEqual(LIMIT);
      expect(count(codes, 'SECOND_FACTOR_LOCKED')).toBe(AT_ONCE - counting.asked.length);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 the wrong-code lock under concurrent requests',
  () => {
    it('C59 wrong-code lock: a good code sent beside wrong ones is not counted as wrong', async () => {
      const caller = await personWithFactor();
      const first = countingProvider('123456');
      // Three wrong and two good together: once answered, three count against the person.
      const codes = await race(
        first,
        ['000000', '123456', '000000', '123456', '000000'].map(
          (code) => async () => await verifySecondFactor(caller, { code }, first.provider),
        ),
      );
      expect(count(codes, 'SECOND_FACTOR_INVALID')).toBe(3);
      expect(count(codes, 'served')).toBe(2);

      // Two more wrong codes are still asked; the one after them is not.
      const second = countingProvider();
      second.release();
      const answers = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop
        answers.push(await verifySecondFactor(caller, { code: '000000' }, second.provider));
      }
      expect(answers.map((answer) => ('code' in answer ? answer.code : 'served'))).toEqual([
        'SECOND_FACTOR_INVALID',
        'SECOND_FACTOR_INVALID',
        'SECOND_FACTOR_LOCKED',
      ]);
      expect(second.asked).toHaveLength(2);
    });
  },
);
