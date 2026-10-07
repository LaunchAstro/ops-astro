// SPDX-License-Identifier: AGPL-3.0-only
//
// SOLOW-D D3 (Sol OW-070.3, the factor-reset half of the same pass): the
// endings loop's backlog counts a factor reset another settle holds claimed,
// and a fault on a reset the pass asked fails it (`--once` exits 1).

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { retryOwedSteps } from '../../apps/endings/pass.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { insertActor, insertBusiness, insertLogin, insertPerson } from '../identity/fixture.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a claimed factor reset is still counted in the owed backlog, and a fault fails the pass',
  async () => {
    const db = await createFreshDatabase({ part: 'solowd3resets' });
    try {
      const business = await insertBusiness(db.app, 'solow-d3-resets');
      await db.app.withBusiness(business, async (tx) => {
        const person = await insertPerson(tx, 'SOLOW-D D3 synthetic person');
        const actor = await insertActor(tx, person);
        const login = await insertLogin(tx, randomUUID());
        await tx.query(
          `insert into public.factor_resets
             (business_id, person_id, login_id, reset_by_actor_id, provider_factor_id,
              attempt_started_at)
           values ($1, $2, $3, $4, 'solow-d3-factor', now())`,
          [business, person, login, actor],
        );
      });
      let calls = 0;
      const fail = () => {
        calls += 1;
        return Promise.resolve({ ok: false, fault: 'unreachable' } as const);
      };
      const provider = { endSessions: fail, deactivate: fail, deleteFactor: fail };
      const held = await retryOwedSteps(db.admin, db.app, provider);
      expect(calls, 'a current claim keeps this pass from the provider').toBe(0);
      expect(held, 'a claimed reset is owed, and no fault was met').toEqual({ owed: 1, faults: 0 });
      // Without the other settle's claim this pass asks, meets the fault and still counts the reset.
      await db.admin.execute('update public.factor_resets set attempt_started_at = null');
      expect(await retryOwedSteps(db.admin, db.app, provider)).toEqual({ owed: 1, faults: 1 });
      expect(calls).toBe(1);
    } finally {
      await db.drop();
    }
  },
);
