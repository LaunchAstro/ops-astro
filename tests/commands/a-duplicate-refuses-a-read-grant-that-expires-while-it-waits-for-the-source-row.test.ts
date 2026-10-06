// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.duplicate` asks read on the old task (`tasks-duplicate.ts`
// `authorise`). The instant its grants are judged at must be read after its
// last lock wait, the old task's row: a read grant that expires while the
// duplicate waits on that row no longer counts, and nothing is copied.
//
// The old task's row is held `for update` on another connection; the
// duplicate is seen waiting on that holder with its transaction begun before
// the grant's expiry; the holder lets go once the database clock is past it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { blockedBefore, holdRow, instantOf, waitPast } from '../support/lock-wait-race.ts';
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

describe.skipIf(serverUrl === undefined)('duplicating across a read grant’s expiry', () => {
  beforeAll(setUp, 180_000);
  afterAll(tearDown);

  it('a duplicate refuses a read grant that expires while it waits for the source row', async () => {
    const old = await taskFor(alpha, owner, 'source with a lapsing read', clientA);
    const reader = await person('lapsing-reader');
    const grant = await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, reader, 'write', { kind: 'party', id: clientA });
      return await grantTo(tx, reader, 'read', { kind: 'record', id: old });
    });
    await db.admin.execute(
      `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
        where id = $1`,
      [grant],
    );
    const expiry = await instantOf(
      db,
      'select expires_at::text as at from public.grants where id = $1',
      [grant],
    );
    const held = await holdRow(db, 'select id from public.records where id = $1 for update', [old]);
    const before = await footprint();
    const copying = executeCommand(db.app, alpha, reader.presented, 'api', {
      command: 'task.duplicate',
      operationId: randomUUID(),
      recordId: old,
      client: clientA,
      title: 'copied after the read expired',
      stepNames: [],
    });
    let startedLive = false;
    try {
      startedLive = await blockedBefore(db, held, expiry);
      await waitPast(db, expiry);
    } finally {
      await held.letGo();
    }
    const answer = await copying;
    expect({
      startedLive,
      outcome: outcomeOf(answer),
      footprint: await footprint(),
    }).toMatchObject({
      startedLive: true,
      outcome: { code: 'SCOPE_NOT_GRANTED' },
      footprint: before,
    });
  }, 30_000);
});
