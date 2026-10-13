// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 sidebar door: a task:read revoked while the site read is under way, after
// its first check and before the statement that reads the file, discloses
// nothing. The read decides on grants as they stand after the file is read.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, BEFORE, PAGE, type C80World } from '../site/c80-world.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('locaterevoke');
  await w.world.db.admin.execute(
    `insert into public.party_site_page_snapshots
       (business_id, page_url, source_revision, source_text)
     values ($1, $2, 'rev-1', $3)`,
    [w.world.business, PAGE, BEFORE],
  );
});

afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('the sidebar door under a revocation', () => {
  it('task read revoked before the snapshot statement discloses no source text', async () => {
    const request = { read: 'live_correction.locate', recordId: w.taskA, pageUrl: PAGE } as const;
    expect(
      await executeRead(w.world.db.app, w.world.business, w.ava.presented, request),
    ).toMatchObject({ ok: true, target: { before: BEFORE } });

    let revoked = 0;
    // Run every query against real Postgres. Commit the competing revocation
    // after the permission check and before the statement fetching the bytes.
    const crossing: Database = {
      log: w.world.db.app.log,
      close: async () => {},
      withBusiness: async (business, run) =>
        await w.world.db.app.withBusiness(
          business,
          async (tx) =>
            await run({
              ...tx,
              query: async (sql, parameters = []) => {
                if (sql.includes('join public.party_site_page_snapshots')) {
                  const rows = await w.world.db.admin.execute(
                    `update public.grants set revoked_at = clock_timestamp()
                    where business_id = $1 and collection = 'task' and action = 'read'
                      and subject_id in ($2::uuid, $3::uuid) and revoked_at is null
                    returning id`,
                    [w.world.business, w.ava.personId, w.ava.actorId],
                  );
                  revoked += rows.length;
                }
                return await tx.query(sql, parameters);
              },
            }),
        ),
    };
    const answer = await executeRead(crossing, w.world.business, w.ava.presented, request);
    expect(revoked).toBeGreaterThan(0);
    // Confirm the permission has really gone, using a fresh normal call.
    expect(
      await executeRead(w.world.db.app, w.world.business, w.ava.presented, request),
    ).toMatchObject({ refused: true, code: 'NOT_FOUND' });
    expect(answer).toMatchObject({ refused: true, code: 'NOT_FOUND' });
  });
});
