// SPDX-License-Identifier: AGPL-3.0-only
//
// Client access reads the client's people (outside the membership, on the
// client through a live party `task:read`) and then issues each a read share
// on the task, holding each standing grant and the parents it is cut from
// `for share` from that read to the share insert. A former client person and a
// current one stand on client X; the task is on client X. The share is paused
// on its own connection just before it inserts the former person's share; the
// former person's party grant is revoked on another connection; then the share
// goes on. The revocation must wait for the share, and then the share stands;
// on main, which held nothing, it commits first and the former person is
// shared nothing.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { gate } from '../support/lock-waits.ts';
import { addClient } from './fixture.ts';
import {
  admin,
  alpha,
  clientPerson,
  db,
  fresh,
  liveHolders,
  outcomeOf,
  readAs,
  revisionOf,
  serverUrl,
  setUp,
  SHARE,
  tearDown,
} from './client-access-world.ts';

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

/** A racer's own failure is reported by its assertion, not by its cleanup. */
const ignore = (): void => undefined;

/** `pool`, with every transaction paused before it inserts a grant to `personId`. */
function pausedBefore(
  pool: Database,
  personId: string,
): { readonly database: Database; readonly reached: Promise<void>; readonly go: () => void } {
  const reached = gate();
  const resume = gate();
  const database: Database = {
    ...pool,
    withBusiness: async (business, run) =>
      await pool.withBusiness(
        business,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, parameters) => {
              if (sql.includes('insert into public.grants') && parameters?.[2] === personId) {
                reached.release();
                await resume.promise;
              }
              return await tx.query(sql, parameters);
            },
          }),
      ),
  };
  return { database, reached: reached.promise, go: resume.release };
}

/** Whether the revocation committed, or waits on a lock the share holds. */
async function revokedFirst(revoking: Promise<unknown>): Promise<boolean> {
  let committed = false;
  const settled = (): void => {
    committed = true;
  };
  void revoking.then(settled, settled);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await db.admin.execute<{ blocked: boolean }>(
      `select exists (select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and strpos(query, 'update public.grants set revoked_at') > 0) as blocked`,
    );
    if (committed) return true;
    if (row?.blocked === true) return false;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error('the revocation neither committed nor waited on the share');
}

it.skipIf(serverUrl === undefined)(
  'a client standing revoked during client access waits for the share it already counted',
  async () => {
    const client = randomUUID();
    await addClient(db.app, alpha, client, admin);
    const former = await clientPerson(alpha, client, admin);
    await clientPerson(alpha, client, admin);
    const task = await fresh(alpha, admin, 'Client X private task', client);
    const pool = connect(db.appUrl);
    const revoker = connect(db.appUrl);
    const paused = pausedBefore(pool, former.personId);
    let sharing: ReturnType<typeof executeCommand> | undefined;
    try {
      sharing = executeCommand(paused.database, alpha, admin.presented, 'api', {
        command: SHARE,
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: await revisionOf(task),
      });
      await paused.reached;
      const revoking = revoker.withBusiness(
        alpha,
        async (tx) => await revokeGrant(tx, former.partyGrantId),
      );
      const first = await revokedFirst(revoking);
      expect(first, 'the revocation waits on the held standing').toBe(false);
      paused.go();
      const answer = await sharing;
      expect(await revoking).not.toBeNull();
      const read = await readAs(alpha, former, task);
      expect({
        shared: outcomeOf(answer)['code'] ?? 'applied',
        formerHoldsShare: (await liveHolders(task)).includes(former.personId),
        formerReads: outcomeOf(read)['applied'] === true,
      }).toEqual({ shared: 'applied', formerHoldsShare: true, formerReads: true });
    } finally {
      paused.go();
      await sharing?.catch(ignore);
      await Promise.all([pool.close(), revoker.close()]);
    }
  },
);
