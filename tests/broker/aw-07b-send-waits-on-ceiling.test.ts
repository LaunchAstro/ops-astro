// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, a send held on the ceiling's lock. A send reads the count of emails
// in flight only under the ceiling's lock, so it may wait there on another
// sender's transaction. Two things hold across that wait:
//
// - the recipient's read is judged again after it: access revoked while the
//   send waited withholds the item, writes nothing and sends nothing;
// - the fence on a paused send counts from when its ask is reserved, after
//   the wait: an ask whose transaction waited long on the lock is fresh when
//   it commits, and it sends.

import { expect, it as vitestIt, vi } from 'vitest';
import { roomFor } from '../../packages/core-custody/src/email-class.ts';
import { emailAtOnce } from '../../packages/core-custody/src/index.ts';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import { freshInbox, timing, useTimingWorld } from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

/** Sends waiting on an advisory lock in this test's database. */
async function waitingOnLock(): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`,
  );
  return row?.n ?? 0;
}

/**
 * Another sender, on a connection of its own, holding the ceiling's lock with
 * room to spare until `release`. `run` starts the send under test once the lock
 * is held; `whileWaiting` runs once that send waits on it.
 */
async function heldAtCeiling<T>(
  run: () => Promise<T>,
  whileWaiting: () => Promise<void>,
): Promise<T> {
  const operation = w.broker.operations.get(EMAIL_SEND.key);
  if (operation === undefined) throw new Error('ceiling wait: no operation');
  const holder = connect(w.db.appUrl, { source: 'ceiling-holder' });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holding = holder.withBusiness(w.alpha, async (tx) => {
    if (!(await roomFor(tx, operation)())) throw new Error('ceiling wait: no room');
    locked();
    await released;
  });
  let sending: Promise<T> | undefined;
  try {
    await Promise.race([lockHeld, holding]);
    sending = run();
    await expect.poll(waitingOnLock, { timeout: 5000 }).toBe(1);
    await whileWaiting();
    release();
    await holding;
    return await sending;
  } finally {
    release();
    await holding.catch(() => {});
    await sending?.catch(() => {});
    await holder.close();
  }
}

it('AW-07b at once: read access revoked while the send waits on the ceiling withholds the item', async () => {
  await freshInbox();
  const item = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const [grant] = await w.db.admin.execute<{ id: string }>(
    `select id from public.grants where business_id = $1 and subject_kind = 'person'
        and subject_id = $2 and collection = 'task' and action = 'read' and revoked_at is null`,
    [w.alpha, w.person],
  );
  if (grant === undefined) throw new Error('missing read grant');
  const revoker = connect(w.db.appUrl);
  try {
    const result = await heldAtCeiling(
      async () => await emailAtOnce(w.db.app, w.alpha, item, timing()),
      async () => {
        await revoker.withBusiness(w.alpha, async (other) => {
          expect(await revokeGrant(other, grant.id)).not.toBeNull();
        });
      },
    );
    expect(result).toEqual({ ok: false, code: 'ITEM_WITHHELD' });
    expect(await attemptsOf(item)).toEqual([]);
    expect(w.provider.outbox.length).toBe(before);
  } finally {
    await revoker.close();
    // Restore the grant so the cases that follow are independent.
    await w.db.admin.execute('update public.grants set revoked_at = null where id = $1', [
      grant.id,
    ]);
  }
});

it('AW-07b at once: an ask that waited long on the ceiling is fresh when reserved, and sends', async () => {
  await freshInbox();
  const item = await itemFor(w.task, 'decision');
  const before = w.provider.outbox.length;
  const monotonic = performance.now.bind(performance);
  const wall = Date.now.bind(Date);
  try {
    const result = await heldAtCeiling(
      async () => await emailAtOnce(w.db.app, w.alpha, item, timing()),
      async () => {
        // Both host clocks move past the grace while the send waits on the lock.
        vi.spyOn(performance, 'now').mockImplementation(() => monotonic() + 70_000);
        vi.spyOn(Date, 'now').mockImplementation(() => wall() + 70_000);
        await Promise.resolve();
      },
    );
    expect(result).toMatchObject({ ok: true, state: 'accepted' });
    expect((await attemptsOf(item)).map((row) => row.state)).toEqual(['asked', 'accepted']);
    expect(w.provider.outbox.length).toBe(before + 1);
  } finally {
    vi.restoreAllMocks();
  }
});
