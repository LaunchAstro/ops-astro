// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3 client groups, the read's cost (an interim review finding): the inbox read names
// the clients of the tasks it lists, so its cost follows the page, never the
// number of clients the reader reaches (every client, for a business-wide
// reader), on each `inbox.read` and each live-board digest (`shownInbox`).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { raiseInboxItem, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { readInbox } from '../../packages/core-commands/src/reads/inbox.ts';
import { clearingWorld } from '../commands/inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('MP-7-3 client groups cost', () => {
  const w = clearingWorld('r12p1');

  it('MP-7-3 client groups: the inbox read reads no more client rows for a business of many clients than of one', async () => {
    const own = randomUUID();
    await w.fixture.db.admin.execute(
      `insert into public.clients (business_id, id, name, created_by_actor_id)
       values ($1, $2, $3, (select id from public.actors where business_id = $1 limit 1))`,
      [w.fixture.business, own, `own-${randomUUID()}`],
    );
    const task = await w.task('one entry on one client', own);
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: w.fixture.member.personId,
          subjectRecordId: task.id,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
    );
    const rowsRead = async (): Promise<number> =>
      await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        let rows = 0;
        const counted: TenantQuery = {
          businessId: tx.businessId,
          query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
            const answer = await tx.query<Row>(sql, parameters);
            rows += answer.length;
            return answer;
          },
        };
        await readInbox(counted, w.fixture.member.personId, [
          { kind: 'person', id: w.fixture.member.personId },
          { kind: 'actor', id: w.fixture.member.actorId },
        ]);
        return rows;
      });
    const before = await rowsRead();
    await w.fixture.db.admin.execute(
      `insert into public.clients (business_id, id, name, created_by_actor_id)
       select $1, gen_random_uuid(), 'bulk-' || g || '-' || gen_random_uuid(),
              (select id from public.actors where business_id = $1 limit 1)
         from generate_series(1, 300) as g`,
      [w.fixture.business],
    );
    expect(await rowsRead()).toBe(before);
  });
});
