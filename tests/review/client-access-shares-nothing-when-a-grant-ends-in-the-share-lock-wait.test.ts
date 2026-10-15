// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import {
  admin,
  alpha,
  clientB,
  clientBPerson,
  db,
  fresh,
  revisionOf,
  scopedSharer,
  serverUrl,
  setUp,
  SHARE,
  tearDown,
} from '../commands/client-access-world.ts';
import { grantTo } from '../commands/fixture.ts';
import { instantOf, waitPast } from '../support/lock-wait-race.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
});
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

it.skipIf(serverUrl === undefined).each(['sharer', 'client person'] as const)(
  'Client access shares nothing when the %s grant expires during the new share-lock wait',
  // eslint-disable-next-line max-lines-per-function -- a proof kept as its reviewer wrote it
  async (ending) => {
    const recordId = await fresh(alpha, admin, 'expires across share wait', clientB);
    const expectedRevision = await revisionOf(recordId);
    const accessGrantId = await db.app.withBusiness(
      alpha,
      async (tx) => await grantTo(tx, scopedSharer, 'share', undefined, false, 'access'),
    );
    const [partyGrant] = await db.admin.execute<{ readonly id: string }>(
      `select id from public.grants where business_id = $1 and subject_id = $2
        and scope_kind = 'party' and scope_id = $3 and collection = 'task' and action = 'read'
        and revoked_at is null and parent_grant_id is null`,
      [alpha, clientBPerson.personId, clientB],
    );
    if (partyGrant === undefined) throw new Error('the client person has no standing to expire');
    const grantId = ending === 'sharer' ? accessGrantId : partyGrant.id;
    await db.admin.execute(
      "update public.grants set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
      [grantId],
    );
    const expiry = await instantOf(
      db,
      'select expires_at::text as at from public.grants where id = $1',
      [grantId],
    );
    const key = `record-share:${alpha}:${recordId}:${clientBPerson.personId}`.toLowerCase();
    const blocker = await hold(db.appUrl, alpha, async (tx) => await advisoryLock(tx, key));
    const caller = connect(db.appUrl);
    const sent = executeCommand(caller, alpha, scopedSharer.presented, 'api', {
      command: SHARE,
      operationId: randomUUID(),
      recordId,
      expectedRevision,
    });
    try {
      try {
        await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
        const [atWait] = await db.admin.execute<{ readonly live: boolean }>(
          'select clock_timestamp() < $1::text::timestamptz as live',
          [expiry],
        );
        expect(atWait?.live, 'the grant must still be live when the share starts waiting').toBe(
          true,
        );
        await waitPast(db, expiry);
      } finally {
        await blocker.letGo();
      }
      const answer = await sent;
      const [row] = await db.admin.execute<{ readonly n: number }>(
        `select count(*)::int as n from public.grants
          where business_id = $1 and subject_id = $2 and scope_id = $3
            and collection = 'task' and action = 'read' and revoked_at is null`,
        [alpha, clientBPerson.personId, recordId],
      );
      expect({ refused: isCommandRefusal(answer), createdShares: row?.n }).toEqual({
        refused: true,
        createdShares: 0,
      });
    } finally {
      await caller.close();
    }
  },
  30_000,
);
