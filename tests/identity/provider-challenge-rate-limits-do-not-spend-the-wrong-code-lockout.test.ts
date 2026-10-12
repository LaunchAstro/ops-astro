// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { verifySecondFactor } from '../../packages/core-commands/src/commands/account-factor.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { insertBusiness } from './fixture.ts';
import { factorCaller } from './factor-lock-wait-fixture.ts';

let db: FreshDatabase;
let business: BusinessId;
beforeAll(async () => {
  db = await createFreshDatabase({ part: 'sol1470lockout' });
  business = await insertBusiness(db.app, 'sol-1470-lockout');
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

it('Sol proof, criterion 1: provider challenge rate limits do not spend the wrong-code lockout', async () => {
  const { caller } = await factorCaller(db, business, true);
  const challengePaths: string[] = [];
  let rateLimited = true;
  const provider = createGoTrueFactors({
    baseUrl: 'http://provider.invalid',
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/challenge')) {
        challengePaths.push(path);
        return rateLimited
          ? Response.json(
              { code: 'over_request_rate_limit', msg: 'Too many requests' },
              { status: 429 },
            )
          : Response.json({ id: 'valid-challenge' });
      }
      if (path.endsWith('/verify'))
        return Response.json({
          access_token: 'proved-access',
          refresh_token: 'proved-refresh',
          expires_in: 3600,
        });
      throw new Error(`unexpected provider request: ${path}`);
    },
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Each challenge fails before the provider can check the code.
    // oxlint-disable-next-line no-await-in-loop
    const refused = await verifySecondFactor(caller, { code: '123456' }, provider);
    expect(refused).toMatchObject({ refused: true });
  }
  expect(challengePaths).toHaveLength(5);
  rateLimited = false;
  const answer = await verifySecondFactor(caller, { code: '123456' }, provider);
  expect(answer).toMatchObject({ accessToken: 'proved-access' });
  expect(challengePaths).toHaveLength(6);
});
