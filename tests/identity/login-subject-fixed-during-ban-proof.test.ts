// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import { settleAccessEndings } from '../../packages/core-commands/src/commands/access-end.ts';
import { loginLiveElsewhere } from '../../packages/core-records/src/identity/shared-login.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from './fixture.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'business to business live login subject changes cannot bypass an in-flight ending',
  async () => {
    const db = await createFreshDatabase({ part: 'sold3subject' });
    const wide = connect(db.appUrl, { max: 4 });
    const subject = randomUUID();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const banning = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let settlement: ReturnType<typeof settleAccessEndings> | undefined;
    let mapping: Promise<void> | undefined;
    try {
      const alpha = await insertBusiness(wide, `alpha-${randomUUID()}`);
      const bravo = await insertBusiness(wide, `bravo-${randomUUID()}`);
      await wide.withBusiness(alpha, async (tx) => {
        const person = await insertPerson(tx, 'Ended alpha person');
        const actor = await insertActor(tx, person);
        const login = await insertLogin(tx, subject);
        await insertMembership(tx, person, false);
        await insertMapping(tx, login, person, actor);
        await tx.query(
          `insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
           values ($1, $2, $3, $4)`,
          [alpha, person, login, actor],
        );
      });
      const bravoLogin = await wide.withBusiness(bravo, async (tx) => {
        const person = await insertPerson(tx, 'Live bravo person');
        const actor = await insertActor(tx, person);
        await insertMembership(tx, person);
        const login = await insertLogin(tx, randomUUID());
        await insertMapping(tx, login, person, actor);
        return login;
      });
      const provider = createGoTrueLogins({
        baseUrl: 'http://127.0.0.1:9/auth/v1',
        adminKey: () => Promise.resolve('sol-d3-synthetic-key'),
        fetch: async () => {
          reached();
          await released;
          return Response.json({ id: subject, banned_until: '2999-01-01T00:00:00Z' });
        },
      });
      settlement = settleAccessEndings(wide, alpha, provider, {
        sharedElsewhere: async (user) => await loginLiveElsewhere(db.admin, user, alpha),
      });
      await banning;
      mapping = wide.withBusiness(bravo, async (tx) => {
        await tx.query(
          'update public.logins set subject = $3 where business_id = $1 and id = $2',
          [bravo, bravoLogin, subject],
        );
      });
      const state = await Promise.race([
        mapping.then(() => 'committed', () => 'refused'),
        delay(1000).then(() => 'waiting'),
      ]);
      const liveDuringBan = await loginLiveElsewhere(db.admin, subject, alpha);
      release();
      const report = await settlement;
      const [update] = await Promise.allSettled([mapping]);
      if (update?.status === 'rejected') {
        expect(update.reason).toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/u) });
      }
      expect(report, 'alpha accepted and stamped the provider ban').toMatchObject({
        settled: 1,
        owed: 0,
      });
      expect(
        { state, liveDuringBan },
        'changing the subject of a live bravo login must wait until alpha stamps the ban',
      ).toEqual({
        state: expect.stringMatching(/^(waiting|refused)$/u),
        liveDuringBan: false,
      });
    } finally {
      release();
      await Promise.allSettled([settlement, mapping]);
      await wide.close();
      await db.drop();
    }
  },
);
