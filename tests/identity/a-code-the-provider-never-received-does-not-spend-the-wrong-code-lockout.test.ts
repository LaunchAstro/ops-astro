// SPDX-License-Identifier: AGPL-3.0-only
//
// The wrong-code lockout counts codes that may have reached the provider's
// check. A code that never left this server (the lookup of a factor held in
// another business failed, or the provider refused the challenge) stops
// counting, even when the session that sent it ended while it waited. A code
// the provider's verify step refused still counts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import {
  verifySecondFactor,
  type FactorCaller,
} from '../../packages/core-commands/src/commands/account-factor.ts';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { endOwnSession } from '../../packages/core-records/src/identity/sessions.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { provider as doneProvider } from './factor-lock-wait-fixture.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

const live = databaseUrlFromEnvironment() !== undefined;
let db: FreshDatabase;
let alpha: BusinessId;
let bravo: BusinessId;

beforeAll(async () => {
  if (!live) return;
  db = await createFreshDatabase({ part: 'unsentlockout' });
  alpha = (await insertBusiness(db.app, 'unsent-alpha')) as BusinessId;
  bravo = (await insertBusiness(db.app, 'unsent-bravo')) as BusinessId;
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

/** One login mapped in `business`, its person holding `factor` verified there when given. */
async function member(business: BusinessId, subject: string, factor?: string): Promise<string> {
  return await db.app.withBusiness(business, async (tx) => {
    const personId = await insertPerson(tx, 'Code sender');
    await insertMembership(tx, personId);
    await insertMapping(
      tx,
      await insertLogin(tx, subject),
      personId,
      await insertActor(tx, personId),
    );
    if (factor !== undefined) {
      const row = await recordFactorEnrolled(tx, {
        personId,
        subject,
        provider: 'supabase',
        providerFactorId: factor,
      });
      await recordFactorVerified(tx, { personId, factorId: row.id, subject });
    }
    return personId;
  });
}

const callerIn = (business: BusinessId, subject: string): FactorCaller => ({
  database: db.app,
  businessId: business,
  accessToken: 'unsent-test-bearer',
  presented: {
    provider: 'supabase',
    subject,
    sessionId: randomUUID(),
    assurance: { level: 'aal1', signedInAt: Math.floor(Date.now() / 1000) - 2, factorAt: null },
  },
});

const tooMany = () =>
  Response.json({ code: 'over_request_rate_limit', msg: 'Too many requests' }, { status: 429 });
const signedIn = () =>
  Response.json({ access_token: 'proved-access', refresh_token: 'r', expires_in: 3600 });

it.skipIf(!live)(
  'five failed lookups of a factor held in another business spend no wrong code',
  async () => {
    const subject = `unsent-${randomUUID()}`;
    const factor = `factor-${randomUUID()}`;
    await member(alpha, subject, factor);
    await member(bravo, subject);
    let limited = true;
    const provider = createGoTrueFactors({
      baseUrl: 'http://provider.invalid',
      // oxlint-disable-next-line require-await
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/user')
          return limited
            ? tooMany()
            : Response.json({ factors: [{ id: factor, status: 'verified' }] });
        if (path.endsWith('/challenge')) return Response.json({ id: 'challenge-1' });
        if (path.endsWith('/verify')) return signedIn();
        throw new Error(`unexpected provider request: ${path}`);
      },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await verifySecondFactor(
        callerIn(bravo, subject),
        { code: '123456' },
        provider,
      );
      expect(refused).toMatchObject({ refused: true });
    }
    limited = false;
    const answer = await verifySecondFactor(callerIn(bravo, subject), { code: '123456' }, provider);
    expect(answer).toMatchObject({ accessToken: 'proved-access' });
  },
);

it.skipIf(!live)(
  'codes never sent while their session ended spend no wrong code for the next session',
  async () => {
    const subject = `unsent-${randomUUID()}`;
    const person = await member(bravo, subject, `factor-${randomUUID()}`);
    const ending = callerIn(bravo, subject);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parked: FactorProvider = {
      ...doneProvider([]),
      verify: async () => {
        arrived += 1;
        await gate;
        return { ok: false, fault: 'unsent' as const };
      },
    };
    const sent = Array.from(
      { length: 5 },
      async () => await verifySecondFactor(ending, { code: '123456' }, parked),
    );
    await expect.poll(() => arrived, { timeout: 10_000 }).toBe(5);
    await db.app.withBusiness(bravo, (tx) => endOwnSession(tx, person, ending.presented.sessionId));
    release();
    for (const answer of await Promise.all(sent)) expect(answer).toMatchObject({ refused: true });

    const removed: string[] = [];
    const next = await verifySecondFactor(
      callerIn(bravo, subject),
      { code: '123456' },
      doneProvider(removed),
    );
    expect(next).toMatchObject({ accessToken: 'local-elevated-bearer' });
    expect(removed).toEqual([]);
  },
);

it.skipIf(!live)('a challenge the provider refuses is not answered as a wrong code', async () => {
  const subject = `unsent-${randomUUID()}`;
  await member(bravo, subject, `factor-${randomUUID()}`);
  const provider = createGoTrueFactors({
    baseUrl: 'http://provider.invalid',
    // oxlint-disable-next-line require-await
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/challenge')) return tooMany();
      throw new Error(`unexpected provider request: ${path}`);
    },
  });
  const answer = await verifySecondFactor(callerIn(bravo, subject), { code: '123456' }, provider);
  expect(answer).toMatchObject({ refused: true });
  expect(answer).not.toMatchObject({ code: 'SECOND_FACTOR_INVALID' });
});

it.skipIf(!live)(
  'five codes the provider refused at its verify step still lock the login',
  async () => {
    const subject = `unsent-${randomUUID()}`;
    await member(bravo, subject, `factor-${randomUUID()}`);
    const provider = createGoTrueFactors({
      baseUrl: 'http://provider.invalid',
      // oxlint-disable-next-line require-await
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/challenge')) return Response.json({ id: 'challenge-1' });
        if (path.endsWith('/verify')) return tooMany();
        throw new Error(`unexpected provider request: ${path}`);
      },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await verifySecondFactor(callerIn(bravo, subject), { code: '123456' }, provider);
    }
    const locked = await verifySecondFactor(callerIn(bravo, subject), { code: '123456' }, provider);
    expect(locked).toMatchObject({ code: 'SECOND_FACTOR_LOCKED' });
  },
);
