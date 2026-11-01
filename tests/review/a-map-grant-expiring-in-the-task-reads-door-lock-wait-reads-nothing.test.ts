// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- Sol's proof, one lock wait read top to bottom */
//
// C35 (#2114), Sol's proof for S2114-5, at the door (ORCH-2114-T5: an admitted read
// finishes with what existed at admission, so its grant is judged once, at the door). A
// reader whose only grant is on the ticket's map is judged by the map fallback, which takes
// its locking read of the ticket before it asks the map grant. A map grant that expires
// while that read waits on a writer's lock must refuse the read: the grant's answer is the
// one after the wait, never the one before it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { gate, waitingOn } from '../support/lock-waits.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('sol2114doormap', 'sol2114doormap');
  owner = await w.decider('Sol map owner');
}, 180_000);
afterAll(async () => await w?.drop());

const MARKER = 'sol-ticket-read-after-its-map-grant-expired';

describe.skipIf(serverUrl === undefined)('the task read judged at its door through its map', () => {
  it('a map grant expiring in the task read door lock wait reads nothing', async () => {
    const map = await w.create(owner, { title: 'Sol map' }, { taskType: 'map' });
    const ticket = await w.create(owner, { title: MARKER }, { parentId: map.id });
    // The map grant is the reader's only grant, so the door asks the map fallback.
    const reader = await w.member('Sol map reader', ['read'], { kind: 'record', id: map.id });
    expect(codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id }))).toBe(
      'applied',
    );
    const [grant] = await w.db.admin.execute<{ id: string }>(
      `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
        where business_id = $1 and subject_id = $2 and collection = 'task'
          and action = 'read' and scope_kind = 'record' and scope_id = $3
        returning id`,
      [w.business, reader.personId, map.id],
    );
    if (grant === undefined) throw new Error('map grant missing');
    // A writer holds the ticket before the read starts; the door's locking read waits on it
    // while the map grant runs out, and the writer lets go only after it has.
    // The fixture's pool has one connection; the writer holding the ticket needs its own.
    const holder = connect(w.db.appUrl);
    const { promise: locked, release: lockReady } = gate();
    const blocker = holder.withBusiness(w.business, async (hold) => {
      await hold.query(
        'select id from public.records where business_id = $1 and id = $2 for update',
        [w.business, ticket.id],
      );
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
    try {
      const answer = await executeRead(w.db.app, w.business, reader.presented, {
        read: 'task.read',
        recordId: ticket.id,
      });
      await blocker;
      expect({
        code: codeOf(answer),
        leaked: JSON.stringify(answer).includes(MARKER),
        next: codeOf(await w.read(reader, { read: 'task.read', recordId: ticket.id })),
      }).toEqual({ code: 'SCOPE_NOT_GRANTED', leaked: false, next: 'SCOPE_NOT_GRANTED' });
    } finally {
      await blocker.catch(() => null);
      await holder.close();
    }
  }, 30_000);
});
