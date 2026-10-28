// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- Sol's proof, one lock wait read top to bottom */
//
// C35 (#2114), Sol's proof for S2114-5: `task.read` judges its grant again after it is
// served (S2114-3). A reader whose only grant is on the ticket's map is judged by the map
// fallback, which takes its locking read of the ticket. A map grant that expires while that
// read waits on a writer's lock must refuse the read: the grant's answer is the one after
// the wait, never the one before it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { gate, waitingOn } from '../support/lock-waits.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('sol2114lastmap', 'sol2114lastmap');
  owner = await w.decider('Sol map owner');
}, 180_000);
afterAll(async () => await w?.drop());

const MARKER = 'sol-ticket-read-after-its-map-grant-expired';

describe.skipIf(serverUrl === undefined)('the task read judged last through its map', () => {
  it('a map grant expiring in the task read last lock wait reads nothing', async () => {
    const map = await w.create(owner, { title: 'Sol map' }, { taskType: 'map' });
    const ticket = await w.create(owner, { title: MARKER }, { parentId: map.id });
    // A business grant passes the door without its map fallback (which would hold the
    // ticket itself); the map grant is the one left for the last check.
    const reader = await w.member('Sol map reader', ['read']);
    await w.db.app.withBusiness(w.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'record', id: map.id });
    });
    expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
      'applied',
    );
    // The fixture's pool has one connection; the writer holding the ticket needs its own.
    const holder = connect(w.db.appUrl);
    const { promise: locked, release: lockReady } = gate();
    let blocker: Promise<void> | undefined;
    let crossed = false;
    const database: Database = {
      log: w.db.app.log,
      close: async () => {},
      withBusiness: async (business, run) =>
        await w.db.app.withBusiness(
          business,
          async (tx) =>
            await run({
              ...tx,
              query: async (sql, params) => {
                const rows = await tx.query(sql, params);
                // Served, before the last check: the ticket is held and the map grant runs out
                // while the last check's locking read waits on it.
                if (!crossed && sql.includes('r.txt_4 as title') && sql.includes('r.id = $3')) {
                  crossed = true;
                  blocker = holder.withBusiness(w.business, async (hold) => {
                    await hold.query(
                      'select id from public.records where business_id = $1 and id = $2 for update',
                      [w.business, ticket.id],
                    );
                    await w.db.admin.execute(
                      `update public.grants set revoked_at = clock_timestamp()
                        where business_id = $1 and subject_id = $2 and collection = 'task'
                          and action = 'read' and scope_kind = 'business'`,
                      [w.business, reader.personId],
                    );
                    const [grant] = await w.db.admin.execute<{ id: string }>(
                      `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
                        where business_id = $1 and subject_id = $2 and collection = 'task'
                          and action = 'read' and scope_kind = 'record' and scope_id = $3
                        returning id`,
                      [w.business, reader.personId, map.id],
                    );
                    if (grant === undefined) throw new Error('map grant missing');
                    lockReady();
                    await waitingOn(w.db.admin, 'transactionid', 'for share of r');
                    await hold.query(
                      `select pg_sleep(greatest(0, extract(epoch from (expires_at - clock_timestamp()))) + 0.15)
                        from public.grants where business_id = $1 and id = $2`,
                      [w.business, grant.id],
                    );
                  });
                  blocker.catch(lockReady);
                  await locked;
                }
                return rows as never;
              },
            }),
        ),
    };
    try {
      const answer = await executeRead(database, w.business, reader.presented, {
        read: 'task.read',
        recordId: ticket.id,
      });
      await blocker;
      expect(crossed).toBe(true);
      expect({
        code: codeOf(answer),
        leaked: JSON.stringify(answer).includes(MARKER),
        next: codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id })),
      }).toEqual({ code: 'SCOPE_NOT_GRANTED', leaked: false, next: 'SCOPE_NOT_GRANTED' });
    } finally {
      await blocker?.catch(() => undefined);
      await holder.close();
    }
  }, 30_000);
});
