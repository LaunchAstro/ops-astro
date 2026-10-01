// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the tick's identity from the local seed, on a real database.
// `pnpm db:seed` makes the business and its agent's login; the stack reads them
// back and makes the business one active worker, once, in that business only.
// A business or agent the seed has not made is refused and nothing is written.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { localIdentity } from '../../apps/local-agent/seed.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The agent's actor, login and mapping, as scripts/local-seed.mjs writes them. */
async function seedAgent(
  app: Database,
  businessId: string,
  subject: string,
  linkActive = true,
): Promise<void> {
  await app.withBusiness(businessId, async (tx) => {
    const actorId = randomUUID();
    const loginId = randomUUID();
    await tx.query(
      `insert into public.actors (business_id, id, kind, active) values ($1, $2, 'agent', true)`,
      [businessId, actorId],
    );
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1,$2,'supabase',$3)`,
      [businessId, loginId, subject],
    );
    await tx.query(
      `insert into public.actor_logins
         (business_id, id, login_id, actor_id, linked_by_actor_id, active, deactivated_at)
       values ($1, $2, $3, $4, $4, $5, case when $5 then null else now() end)`,
      [businessId, randomUUID(), loginId, actorId, linkActive],
    );
  });
}

describe.skipIf(serverUrl === undefined)(
  'LA-1 local stack: the tick identity from the seed',
  // eslint-disable-next-line max-lines-per-function -- one database, the cases that share it
  () => {
    let db: FreshDatabase;
    let alpha: string;
    let bravo: string;
    const alphaAgent = randomUUID();
    const bravoAgent = randomUUID();

    const workers = async (businessId: string): Promise<readonly { id: string }[]> =>
      await db.admin.execute<{ id: string }>(
        `select id from public.actors where business_id = $1 and kind = 'worker' and active`,
        [businessId],
      );

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'la1seed' });
      alpha = await insertBusiness(db.app, 'alpha');
      bravo = await insertBusiness(db.app, 'bravo');
      await seedAgent(db.app, alpha, alphaAgent);
      await seedAgent(db.app, bravo, bravoAgent);
    }, 180_000);

    afterAll(async () => {
      await db?.drop();
    });

    it("a seeded business gives its id, its agent's subject and one active worker, made once", async () => {
      const first = await localIdentity(db, 'alpha', alphaAgent);
      expect(first).toMatchObject({
        ok: true,
        identity: { businessId: alpha, agentSubject: alphaAgent },
      });
      const second = await localIdentity(db, 'alpha', alphaAgent);
      expect(second).toEqual(first);
      const made = await workers(alpha);
      expect(made).toHaveLength(1);
      expect(first.ok && first.identity.workerActorId).toBe(made[0]?.id);
    });

    it("the worker is made in its own business only, and bravo's own is its own", async () => {
      const read = await localIdentity(db, 'bravo', bravoAgent);
      const bravoWorkers = await workers(bravo);
      expect(bravoWorkers).toHaveLength(1);
      expect(read.ok && read.identity.workerActorId).toBe(bravoWorkers[0]?.id);
      expect(await workers(alpha)).toHaveLength(1);
    });

    it('a business the seed has not made is refused and nothing is written', async () => {
      const read = await localIdentity(db, 'charlie', alphaAgent);
      expect(read).toMatchObject({ ok: false, code: 'NOT_SEEDED' });
    });

    it("another business's agent is refused and that business gets no worker", async () => {
      const charlie = await insertBusiness(db.app, 'charlie');
      const read = await localIdentity(db, 'charlie', alphaAgent);
      expect(read).toMatchObject({ ok: false, code: 'NOT_SEEDED' });
      expect(await workers(charlie)).toHaveLength(0);
    });

    it('an agent whose login link is inactive is refused and its business gets no worker', async () => {
      const delta = await insertBusiness(db.app, 'delta');
      const unlinked = randomUUID();
      await seedAgent(db.app, delta, unlinked, false);
      const read = await localIdentity(db, 'delta', unlinked);
      expect(read).toMatchObject({ ok: false, code: 'NOT_SEEDED' });
      expect(await workers(delta)).toHaveLength(0);
    });
  },
);
