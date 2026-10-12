// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations view lists a business's privacy incidents. An open incident
// is one somebody still has to act on, and the oldest open ones are the ones
// past their 30-day assessment limit, so no number of newer incidents may push
// an open one off the list.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { readPrivacyIncidents } from '../../packages/core-records/src/operations/privacy-incidents.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'open privacy incidents: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/**
 * One incident found 40 days ago, so past the assessment limit and still open,
 * and two hundred newer ones, each found within the last day.
 */
async function seed(tx: TenantQuery, oldest: string): Promise<void> {
  const personId = randomUUID();
  const actorId = randomUUID();
  await tx.query(`insert into people (business_id, id, display_name) values ($1, $2, 'recorder')`, [
    tx.businessId,
    personId,
  ]);
  await tx.query(
    `insert into actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
    [tx.businessId, actorId, personId],
  );
  await tx.query(
    `insert into public.privacy_incidents
       (business_id, id, what_happened, found_at, found_by, affected, information_kinds,
        recorded_by_actor)
     select $1, case when minutes = 0 then $2::uuid else gen_random_uuid() end,
            'A laptop was left on a train.',
            case when minutes = 0 then now() - interval '40 days'
                 else now() - make_interval(mins => minutes) end,
            'Ada', 'Two clients', array['contact'], $3
       from generate_series(0, 200) as minutes`,
    [tx.businessId, oldest, actorId],
  );
}

describe.skipIf(serverUrl === undefined)('the privacy incidents the operations view reads', () => {
  let db: FreshDatabase;
  let businessId: string;
  const oldest = randomUUID();

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'd' });
    businessId = await insertBusiness(db.app, 'incidents');
    await db.app.withBusiness(businessId, async (tx) => {
      await seed(tx, oldest);
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps the oldest open incident, overdue, behind two hundred newer ones', async () => {
    const incidents = await db.app.withBusiness(businessId, (tx) => readPrivacyIncidents(tx));
    expect(incidents).toHaveLength(201);
    expect(incidents.find((each) => each.id === oldest)).toMatchObject({
      status: 'open',
      overdue: true,
    });
  });

  it('still lists the most recently found first', async () => {
    const incidents = await db.app.withBusiness(businessId, (tx) => readPrivacyIncidents(tx));
    const found = incidents.map((each) => each.foundAt.getTime());
    expect(found).toStrictEqual(found.toSorted((left, right) => right - left));
    expect(incidents.at(-1)?.id).toBe(oldest);
  });
});
