// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 Duplicate without contents: the read on the old task is asked with
// the caller's grants held for share, so a revocation and a duplicate
// serialise on the grant row. A revocation that commits first is seen; one
// that comes second waits for the duplicate to commit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { grantTo } from './fixture.ts';
import { revokeGrant, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  alpha,
  clientA,
  clientB,
  db,
  duplicate,
  footprint,
  outcomeOf,
  owner,
  person,
  serverUrl,
  setUp,
  taskFor,
  tearDown,
} from './duplicate-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-duplicate-race: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

// The copy runs on the world's one application connection; the lock holder and
// the revocation each need a backend of their own, or they queue in the client.
let holder: Database;
let revoker: Database;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await setUp();
  holder = connect(db.appUrl, { source: 'runtime' });
  revoker = connect(db.appUrl, { source: 'runtime' });
}, 180_000);

afterAll(async () => {
  await holder?.close();
  await revoker?.close();
  if (serverUrl !== undefined) await tearDown();
});

/** Waits until at least `count` backends in this database wait on a lock. */
async function waitersReach(count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling the server until the wait shows
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = $1 and wait_event_type = 'Lock'`,
      [db.name],
    );
    if (Number(rows[0]?.n) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polling the server until the wait shows
    await sleep(25);
  }
  throw new Error(`fewer than ${String(count)} backends ever waited on a lock`);
}

/** A transaction of `alpha` that runs `statements`, then holds its locks until released. */
function hold(statements: (tx: TenantQuery) => Promise<unknown>) {
  // The executor runs at once, so `release` is set before anything reads it.
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = holder.withBusiness(alpha, async (tx) => {
    await statements(tx);
    await released;
  });
  return { done, release };
}

/** A person with write for client B and read on `old` only; returns the read grant. */
async function reader(old: string, name: string) {
  const who = await person(name);
  const readGrant = await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, who, 'write', { kind: 'party', id: clientB });
    return await grantTo(tx, who, 'read', { kind: 'record', id: old });
  });
  return { who, readGrant };
}

/** The task's row held `for update`, so a copy of it parks after its authority check. */
const holdRow = (taskId: string) =>
  hold(
    async (tx) =>
      await tx.query(`select 1 from public.records where business_id = $1 and id = $2 for update`, [
        alpha,
        taskId,
      ]),
  );

/** A revocation in its own transaction, and whether it has settled yet. */
function revokeAside(grantId: string) {
  let settled = false;
  const done = revoker
    .withBusiness(alpha, async (tx) => await revokeGrant(tx, grantId))
    .finally(() => {
      settled = true;
    });
  return { done, settled: () => settled };
}

describe.skipIf(serverUrl === undefined)('MP-4-8 duplicate and a revocation race', () => {
  it('MP-4-8 duplicate: a revocation that locks the read grant first is seen under the lock', async () => {
    const old = await taskFor(alpha, owner, 'revoked while the copy waits', clientA);
    const { who, readGrant } = await reader(old, 'race-first');
    const before = await footprint();
    const revoking = hold(async (tx) => await revokeGrant(tx, readGrant));
    await sleep(50);
    const copying = duplicate(who, { recordId: old, client: clientB, title: 'copy' });
    try {
      // Held for share behind the revocation's row lock, or answered already when unheld.
      await Promise.race([waitersReach(1), copying]);
    } finally {
      revoking.release();
      await revoking.done;
    }
    const answer = await copying;
    expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(answer)).not.toContain(old);
    expect(await footprint()).toStrictEqual(before);
  }, 60_000);

  it('MP-4-8 duplicate: a revocation that comes second waits for the copy to commit', async () => {
    const old = await taskFor(alpha, owner, 'copied while a revocation arrives', clientA);
    const { who, readGrant } = await reader(old, 'race-second');
    const blocker = holdRow(old);
    await sleep(50);
    const copying = duplicate(who, { recordId: old, client: clientB, title: 'copy' });
    let revoking: { readonly done: Promise<unknown>; settled: () => boolean };
    try {
      await waitersReach(1);
      revoking = revokeAside(readGrant);
      await sleep(300);
      // The revocation is parked on the read grant the copy holds for share.
      expect(revoking.settled()).toBe(false);
    } finally {
      blocker.release();
      await blocker.done;
    }
    const answer = await copying;
    await revoking.done;
    expect(outcomeOf(answer)).not.toHaveProperty('code');
    expect(revoking.settled()).toBe(true);
  }, 60_000);
});
