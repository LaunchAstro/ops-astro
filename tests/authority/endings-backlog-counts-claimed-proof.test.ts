// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { retryAccessEndings } from '../../apps/endings/pass.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { insertActor, insertBusiness, insertLogin, insertPerson } from '../identity/fixture.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a claimed ending is still counted in the owed backlog',
  async () => {
    const db = await createFreshDatabase({ part: 'sol_ow070_backlog' });
    try {
      const business = await insertBusiness(db.app, 'sol-backlog');
      await db.app.withBusiness(business, async (tx) => {
        const person = await insertPerson(tx, 'Sol synthetic person');
        const actor = await insertActor(tx, person);
        const login = await insertLogin(tx, randomUUID());
        await tx.query(
          `insert into public.access_endings
             (business_id, person_id, login_id, ended_by_actor_id, attempt_started_at)
           values ($1, $2, $3, $4, now())`,
          [business, person, login, actor],
        );
      });
      let calls = 0;
      const fail = () => {
        calls += 1;
        return Promise.resolve({ ok: false, fault: 'unreachable' } as const);
      };
      const provider = { endSessions: fail, deactivate: fail };
      const reported = await retryAccessEndings(db.admin, db.app, provider);
      expect(calls, 'a current claim must prevent this pass from calling the provider').toBe(0);
      const rows = await db.admin.execute<{ owed: number }>(
        `select count(*)::int as owed from public.access_endings
          where sessions_ended_at is null or login_deactivated_at is null`,
      );
      expect(rows).toEqual([{ owed: 1 }]);
      // Positive control: without the other worker's claim this pass sees and reports the ending.
      await db.admin.execute('update public.access_endings set attempt_started_at = null');
      expect(await retryAccessEndings(db.admin, db.app, provider)).toBe(1);
      expect(calls).toBe(1);
      expect(reported, 'claimed or awaiting retry is not settled').toBe(1);
    } finally {
      await db.drop();
    }
  },
);
