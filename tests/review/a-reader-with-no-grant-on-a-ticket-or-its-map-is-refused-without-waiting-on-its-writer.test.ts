// SPDX-License-Identifier: AGPL-3.0-only
//
// #2403: the task read's map fallback asks the map grant before it takes its locking read of
// the ticket. A reader holding no grant on the ticket or on its map is refused at once while a
// writer holds the ticket, exactly as for a fabricated id, so a denied read neither waits on
// the writer nor says by waiting that the ticket exists.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { gate } from '../support/lock-waits.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();
/** Far longer than an unlocked refusal takes, far shorter than the writer holds the ticket. */
const PATIENCE_MS = 3_000;

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('r2403nowait', 'r2403nowait');
  owner = await w.decider('Map owner 2403');
}, 180_000);
afterAll(async () => await w?.drop());

const MARKER = 'ticket-a-denied-reader-never-sees-2403';

describe.skipIf(serverUrl === undefined)('the task read door through a map', () => {
  it('refuses a reader with no grant on the ticket or its map without waiting on its writer', async () => {
    const map = await w.create(owner, { title: 'Held map' }, { taskType: 'map' });
    const ticket = await w.create(owner, { title: MARKER }, { parentId: map.id });
    // A grant on another map, so the reader holds task:read somewhere but nowhere here.
    const elsewhere = await w.create(owner, { title: 'Another map' }, { taskType: 'map' });
    const reader = await w.member('Reader elsewhere 2403', ['read'], {
      kind: 'record',
      id: elsewhere.id,
    });
    const fabricated = codeOf(await w.read(reader, { read: 'task.read', recordId: randomUUID() }));

    // A writer holds the ticket for update until the test lets it go.
    const holder = connect(w.db.appUrl);
    const { promise: locked, release: lockReady } = gate();
    const { promise: done, release: letGo } = gate();
    const blocker = holder.withBusiness(w.business, async (hold) => {
      await hold.query(
        'select id from public.records where business_id = $1 and id = $2 for update',
        [w.business, ticket.id],
      );
      lockReady();
      await done;
    });
    blocker.catch(lockReady);
    await locked;
    try {
      const read = executeRead(w.db.app, w.business, reader.presented, {
        read: 'task.read',
        recordId: ticket.id,
      });
      const waited = new Promise<'waited'>((resolve) => {
        setTimeout(() => resolve('waited'), PATIENCE_MS);
      });
      const first = await Promise.race([read, waited]);
      letGo();
      const answer = await read;
      expect({
        waited: first === 'waited',
        code: codeOf(answer),
        leaked: JSON.stringify(answer).includes(MARKER),
      }).toEqual({ waited: false, code: fabricated, leaked: false });
      expect(fabricated).toBe('SCOPE_NOT_GRANTED');
    } finally {
      letGo();
      await blocker.catch(() => null);
      await holder.close();
    }
  }, 30_000);
});
