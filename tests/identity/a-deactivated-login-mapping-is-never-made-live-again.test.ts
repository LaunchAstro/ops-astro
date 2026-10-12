// SPDX-License-Identifier: AGPL-3.0-only
//
// A login mapping comes back as a new row, never by reactivating an old one,
// so a mapping an access ending named never goes live again under the same id.

import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertAgentMapping,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
let db: FreshDatabase;
let business: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'no_reactivation' });
  business = await insertBusiness(db.app, 'no-reactivation');
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const reactivate = (table: 'person_logins' | 'actor_logins', id: string) =>
  db.app.withBusiness(business, async (tx) => {
    await tx.query(
      `update public.${table} set active = true, deactivated_at = null
        where business_id = $1 and id = $2`,
      [tx.businessId, id],
    );
  });

it.skipIf(serverUrl === undefined)(
  'a deactivated person login mapping is refused when made live again',
  async () => {
    const mapping = await db.app.withBusiness(business, async (tx) => {
      const person = await insertPerson(tx, 'Was mapped');
      const actor = await insertActor(tx, person);
      return await insertMapping(tx, await insertLogin(tx, 'person-sub'), person, actor, false);
    });
    await expect(reactivate('person_logins', mapping)).rejects.toMatchObject({ code: '23000' });
  },
);

it.skipIf(serverUrl === undefined)(
  'a deactivated agent login mapping is refused when made live again',
  async () => {
    const mapping = await db.app.withBusiness(business, async (tx) => {
      const agent = await insertAgentActor(tx);
      return await insertAgentMapping(tx, await insertLogin(tx, 'agent-sub'), agent, agent, false);
    });
    await expect(reactivate('actor_logins', mapping)).rejects.toMatchObject({ code: '23000' });
  },
);
