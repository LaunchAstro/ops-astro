// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.duplicate` asks read and write on the old task before it locks that
// task's row (`tasks-duplicate.ts` `authorise`, SEC-B1B F1). A caller who
// cannot read the task is refused without waiting on its row: a wait would
// tell them the task exists and is being changed, and would queue them behind
// its writers.
//
// The old task's row is held `for update` on another connection. The
// duplicate must be answered while the row is still held, and no backend may
// be seen waiting on the holder.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { holdRow, type Held } from '../support/lock-wait-race.ts';
import {
  alpha,
  clientA,
  db,
  footprint,
  outcomeOf,
  owner,
  person,
  serverUrl,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';
import { grantTo } from './fixture.ts';

/** Whether a backend of this database waits on a lock `held` holds now. */
const waitsOn = async (held: Held): Promise<boolean> => {
  const rows = await db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from pg_stat_activity a
      where a.datname = current_database() and a.wait_event_type = 'Lock'
        and $1::int = any(pg_blocking_pids(a.pid))`,
    [held.pid],
  );
  return (rows[0]?.n ?? 0) > 0;
};

describe.skipIf(serverUrl === undefined)('duplicating a task the caller cannot read', () => {
  beforeAll(setUp, 180_000);
  afterAll(tearDown);

  it('a duplicate by a caller who cannot read the source is refused without waiting on its row', async () => {
    const old = await taskFor(alpha, owner, 'source the writer cannot read', clientA);
    const writer = await person('write-only');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, writer, 'write', { kind: 'party', id: clientA });
    });
    const held = await holdRow(db, 'select id from public.records where id = $1 for update', [old]);
    const before = await footprint();
    let settled = false;
    const copying = executeCommand(db.app, alpha, writer.presented, 'api', {
      command: 'task.duplicate',
      operationId: randomUUID(),
      recordId: old,
      client: clientA,
      title: 'copied without a read',
      stepNames: [],
    }).then((answer) => {
      settled = true;
      return answer;
    });
    let waited = false;
    let answeredWhileHeld = false;
    try {
      // oxlint-disable-next-line no-unmodified-loop-condition -- settled is set by the duplicate's answer
      for (let attempt = 0; attempt < 500 && !settled && !waited; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
        waited = await waitsOn(held);
        // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
        if (!settled && !waited) await delay(10);
      }
      answeredWhileHeld = settled;
    } finally {
      await held.letGo();
    }
    const answer = await copying;
    expect({
      answeredWhileHeld,
      waited,
      outcome: outcomeOf(answer),
      footprint: await footprint(),
    }).toMatchObject({
      answeredWhileHeld: true,
      waited: false,
      outcome: { code: 'SCOPE_NOT_GRANTED' },
      footprint: before,
    });
  }, 30_000);
});
