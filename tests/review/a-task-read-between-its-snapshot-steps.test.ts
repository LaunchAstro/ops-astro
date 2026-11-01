// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each case is one interleaving, read top to bottom */
//
// C35 (#2114), ORCH-2114-WIDEN (ii) and the 40001 catch of ORCH-2114-SEAM. `task.read`
// runs in three steps: standing and the quota charge (read committed), admission and the
// answer from one snapshot (repeatable read), then its audit event (read committed). The
// snapshot step asks standing again, so a membership ended between the first two steps is
// refused. A row changed after the snapshot fails the map fallback's locking read with
// 40001 (a real one here: the ticket is updated between the snapshot and that read). The
// snapshot step alone runs once more, with no second charge and no second recorded sign-in,
// and a second 40001 refuses with VERSION_STALE, audited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import {
  createQuotaGate,
  withQuotaScope,
  type QuotaGate,
} from '../../packages/core-records/src/identity/quota.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('c35snapsteps', 'c35snapsteps');
  owner = await w.decider('Snapshot steps owner');
}, 180_000);
afterAll(async () => await w?.drop());

/**
 * The app database, with `opening` run before each repeatable read step begins and `before`
 * ahead of each of its statements, the snapshot already taken.
 */
function watched(
  before: (sql: string, step: number) => Promise<void>,
  opening: (step: number) => Promise<void> = async () => {},
): Database & { snapshots: () => number } {
  let snapshots = 0;
  return {
    log: w.db.app.log,
    close: async () => {},
    snapshots: () => snapshots,
    withBusiness: async (business, run, options) => {
      if (options?.isolation !== 'repeatable read') {
        return await w.db.app.withBusiness(business, run, options);
      }
      snapshots += 1;
      const step = snapshots;
      await opening(step);
      return await w.db.app.withBusiness(
        business,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, params) => {
              await before(sql, step);
              return (await tx.query(sql, params)) as never;
            },
          }),
        options,
      );
    },
  };
}

/** Commits a new version of the ticket from another connection, after the snapshot. */
const touch = async (ticketId: string): Promise<void> => {
  await w.db.admin.execute(
    `update public.records set data = data where business_id = $1 and id = $2`,
    [w.business, ticketId],
  );
};

const resolvedSignIns = async (personId: string): Promise<number> => {
  const [row] = await w.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.authentication_attempts
      where business_id = $1 and person_id = $2 and outcome = 'resolved'`,
    [w.business, personId],
  );
  return Number(row?.n ?? 'NaN');
};

/** A gate that counts its charges, so a second one shows. */
function countingGate(): QuotaGate & { taken: () => number } {
  const gate = createQuotaGate();
  let taken = 0;
  return {
    ...gate,
    take: (holders) => {
      taken += 1;
      return gate.take(holders);
    },
    taken: () => taken,
  };
}

const LOCKING_READ = 'for share of r';

describe.skipIf(serverUrl === undefined)('a task read between its snapshot steps', () => {
  it('a membership ended between the charge and the snapshot is refused', async () => {
    const marker = 'c35-read-after-membership-ended';
    const ticket = await w.create(owner, { title: marker });
    const reader = await w.member('Snapshot steps leaver', ['read']);
    let ended = false;
    // After the first step has charged and resolved, before the snapshot is taken.
    const database = watched(
      async () => {},
      async (step) => {
        if (step !== 1) return;
        ended = true;
        await w.db.admin.execute(
          `update public.memberships set active = false, ended_at = clock_timestamp()
          where business_id = $1 and person_id = $2`,
          [w.business, reader.personId],
        );
      },
    );
    const answer = await executeRead(database, w.business, reader.presented, {
      read: 'task.read',
      recordId: ticket.id,
    });
    expect(ended).toBe(true);
    expect({
      code: codeOf(answer),
      leaked: JSON.stringify(answer).includes(marker),
    }).toEqual({ code: 'AUTH_NO_MEMBERSHIP', leaked: false });
  }, 30_000);

  it('a 40001 in the snapshot step runs that step again, charged and signed in once', async () => {
    const map = await w.create(owner, { title: 'Snapshot steps map' }, { taskType: 'map' });
    const ticket = await w.create(owner, { title: 'Snapshot steps ticket' }, { parentId: map.id });
    // Only a map grant, so the door takes its locking read of the ticket.
    const reader = await w.member('Snapshot steps retried', ['read'], {
      kind: 'record',
      id: map.id,
    });
    const signedIn = await resolvedSignIns(reader.personId);
    const database = watched(async (sql, step) => {
      if (step === 1 && sql.includes(LOCKING_READ)) await touch(ticket.id);
    });
    const gate = countingGate();
    const answer = await withQuotaScope(
      gate,
      async () =>
        await executeRead(database, w.business, reader.presented, {
          read: 'task.read',
          recordId: ticket.id,
        }),
    );
    expect({
      code: codeOf(answer),
      snapshots: database.snapshots(),
      charges: gate.taken(),
      signIns: (await resolvedSignIns(reader.personId)) - signedIn,
    }).toEqual({ code: 'applied', snapshots: 2, charges: 1, signIns: 1 });
  }, 30_000);

  it('a second 40001 refuses the read with VERSION_STALE, audited, showing nothing', async () => {
    const marker = 'c35-read-refused-after-two-serialization-failures';
    const map = await w.create(owner, { title: 'Snapshot steps stale map' }, { taskType: 'map' });
    const ticket = await w.create(owner, { title: marker }, { parentId: map.id });
    const reader = await w.member('Snapshot steps stale', ['read'], { kind: 'record', id: map.id });
    const database = watched(async (sql) => {
      if (sql.includes(LOCKING_READ)) await touch(ticket.id);
    });
    const answer = await executeRead(database, w.business, reader.presented, {
      read: 'task.read',
      recordId: ticket.id,
    });
    const [audited] = await w.db.admin.execute<{ outcome: string; refusal_code: string | null }>(
      `select outcome, refusal_code from public.audit_events
        where business_id = $1 and command = 'task.read' and actor_id = $2
        order by seq desc limit 1`,
      [w.business, reader.actorId],
    );
    expect({
      code: codeOf(answer),
      snapshots: database.snapshots(),
      leaked: JSON.stringify(answer).includes(marker),
      audited,
    }).toEqual({
      code: 'VERSION_STALE',
      snapshots: 2,
      leaked: false,
      audited: { outcome: 'refused', refusal_code: 'VERSION_STALE' },
    });
  }, 30_000);
});
