// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.duplicate` across clients asks share at the new client
// (`tasks-duplicate.ts` `authorise`). The new task is ranked after the
// business's top-level tasks, under their sibling lock (`lockSiblings`), and
// that wait comes after the asks: a share grant that expires while the
// duplicate waits there no longer counts, and client A's text is not copied
// under client B (Sol PRV-oa-1035-R1 F1, #444).
//
// The top-level sibling lock is held on another connection, which locks no
// record or grant; the duplicate is seen waiting on that holder while the
// database clock is still before the share grant's expiry; the holder lets go
// once the clock is past it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { blockedBefore, hold, instantOf, waitPast } from '../support/lock-wait-race.ts';
import {
  alpha,
  CANARY,
  clientA,
  clientB,
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

/** Client A's task, and a person who may read it and share it to client B for three seconds more. */
async function lapsingSharer(title: string) {
  const old = await taskFor(alpha, owner, title, clientA);
  const sharer = await person('lapsing-sharer');
  const share = await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, sharer, 'read', { kind: 'record', id: old });
    await grantTo(tx, sharer, 'write', { kind: 'party', id: clientB });
    return await grantTo(tx, sharer, 'share', { kind: 'party', id: clientB });
  });
  await db.admin.execute(
    `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
      where id = $1`,
    [share],
  );
  const expiry = await instantOf(
    db,
    'select expires_at::text as at from public.grants where id = $1',
    [share],
  );
  return { old, sharer, expiry };
}

/** The copies of `title` filed under client B. */
async function copiesUnderB(title: string): Promise<number | undefined> {
  const copies = await db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from public.records
      where business_id = $1 and uuid_7 = $2 and data->>'title' = $3`,
    [alpha, clientB, title],
  );
  return copies[0]?.n;
}

/** `lockSiblings(tx, null, null)`'s key, taken as it takes it, on a connection of its own. */
async function holdTopLevelRank() {
  return await hold(db, async (execute) => {
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `task.siblings:${alpha}:board:none`,
    ]);
  });
}

describe.skipIf(serverUrl === undefined)('duplicating across a share grant’s expiry', () => {
  beforeAll(setUp, 180_000);
  afterAll(tearDown);

  it('a cross-client duplicate refuses a share grant that expires while it waits for the sibling-rank lock', async () => {
    const title = `private to client A ${CANARY}`;
    const { old, sharer, expiry } = await lapsingSharer(title);
    const held = await holdTopLevelRank();
    const before = await footprint();
    const copying = executeCommand(db.app, alpha, sharer.presented, 'api', {
      command: 'task.duplicate',
      operationId: randomUUID(),
      recordId: old,
      client: clientB,
      title,
      stepNames: [],
      confirmCarried: true,
    });
    let startedLive = false;
    let waitedLive = false;
    try {
      startedLive = await blockedBefore(db, held, expiry);
      const [clock] = await db.admin.execute<{ readonly live: boolean }>(
        'select clock_timestamp() < $1::text::timestamptz as live',
        [expiry],
      );
      waitedLive = clock?.live === true;
      await waitPast(db, expiry);
    } finally {
      await held.letGo();
    }
    const answer = await copying;
    expect({
      startedLive,
      waitedLive,
      outcome: outcomeOf(answer),
      footprint: await footprint(),
      copiesUnderB: await copiesUnderB(title),
    }).toMatchObject({
      startedLive: true,
      waitedLive: true,
      outcome: { code: 'SCOPE_NOT_GRANTED' },
      footprint: before,
      copiesUnderB: 0,
    });
  }, 30_000);
});
