// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, the catalogued ceiling of `email.send` (concurrency 4) as the send
// path counts it. The declaration bounds the provider calls in flight, and one
// call is one email: a daily batch covering several items is one email
// (supporting checklist: "Several waiting items ... make one email a day"),
// so it takes one place under the ceiling, not one per item. And an ask whose
// sender died before recording an outcome stays `asked` (unknown, never sent
// again) but stops holding a place once custody's own timeout and a grace have
// passed, so a business is never held at the ceiling for good and its
// decisions and incidents still go out at once.

import { expect, it as vitestIt } from 'vitest';
import { checkItem, recordAsked } from '../../packages/core-custody/src/broker-email.ts';
import { roomFor } from '../../packages/core-custody/src/email-class.ts';
import { emailAtOnce } from '../../packages/core-custody/src/index.ts';
import { EMAIL_SEND } from '../../packages/core-connectors/src/index.ts';
import { connect } from '../../packages/core-records/src/index.ts';
import { attemptsOf, itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import { aged, freshInbox, timing, useTimingWorld } from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

const atOnce = async (item: string) => await emailAtOnce(w.db.app, w.alpha, item, timing());

/**
 * A sender that recorded `asked` on these items, committed, and then died
 * (or is still waiting on the provider): one email, covering every item.
 */
async function askedAndGone(items: readonly string[], daily: boolean): Promise<void> {
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    const checked = [];
    for (const id of items) {
      // oxlint-disable-next-line no-await-in-loop
      const item = await checkItem(tx, id);
      if (typeof item === 'string') throw new Error(`an item was refused: ${item}`);
      checked.push(item);
    }
    await recordAsked(tx, checked, daily);
  });
}

async function raise(count: number, reason: 'mention' | 'incident'): Promise<string[]> {
  const raised: string[] = [];
  for (let n = 0; n < count; n += 1) {
    // oxlint-disable-next-line no-await-in-loop
    raised.push(await itemFor(w.task, reason));
  }
  return raised;
}

it('AW-07b ceiling: a daily batch in flight is one email under the ceiling, not one per item', async () => {
  await freshInbox();
  // One batch email covering more items than the ceiling, still with the provider.
  await askedAndGone(await raise(EMAIL_SEND.concurrency + 1, 'mention'), true);
  const decision = await itemFor(w.task, 'decision');
  expect(await atOnce(decision)).toMatchObject({ ok: true, state: 'accepted' });
  // Emails still count: with the batch and enough single sends in flight to
  // fill the ceiling, the next decision waits and nothing is written for it.
  for (const one of await raise(EMAIL_SEND.concurrency - 1, 'incident')) {
    // oxlint-disable-next-line no-await-in-loop
    await askedAndGone([one], false);
  }
  const held = await itemFor(w.task, 'decision');
  expect(await atOnce(held)).toEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
  expect(await attemptsOf(held)).toEqual([]);
});

it("AW-07b ceiling: a dead worker's asks stop holding the ceiling past custody's timeout and a grace", async () => {
  await freshInbox();
  const lost = await raise(EMAIL_SEND.concurrency, 'incident');
  for (const one of lost) {
    // oxlint-disable-next-line no-await-in-loop
    await askedAndGone([one], false);
  }
  // Inside the bound they may be live sends: the ceiling holds.
  const decision = await itemFor(w.task, 'decision');
  expect(await atOnce(decision)).toEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
  // Past it (custody ended every one of those calls long ago), they hold nothing.
  await aged('2 minutes');
  expect(await atOnce(decision)).toMatchObject({ ok: true, state: 'accepted' });
  // A lost ask stays unknown: it still may have gone, so it is never sent again.
  const [first] = lost;
  expect(await atOnce(first ?? '')).toEqual({ ok: false, code: 'EMAIL_MAY_HAVE_GONE' });
  expect((await attemptsOf(first ?? '')).map((row) => row.state)).toEqual(['asked']);
});

/** Sends waiting on an advisory lock in this test's database. */
async function waitingOnLock(): Promise<number> {
  const [row] = await w.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`,
  );
  return row?.n ?? 0;
}

it('AW-07b ceiling: a send racing an ask that takes the last room waits on the lock, then is held', async () => {
  await freshInbox();
  // One room short of the ceiling.
  for (const one of await raise(EMAIL_SEND.concurrency - 1, 'incident')) {
    // oxlint-disable-next-line no-await-in-loop
    await askedAndGone([one], false);
  }
  const [last] = await raise(1, 'incident');
  const operation = w.broker.operations.get(EMAIL_SEND.key);
  if (last === undefined || operation === undefined) throw new Error('ceiling case: no setup');
  // A second sender, on a connection of its own, takes the last room and holds its transaction.
  const holder = connect(w.db.appUrl, { source: 'racer' });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let taken!: () => void;
  const roomTaken = new Promise<void>((resolve) => {
    taken = resolve;
  });
  const holding = holder.withBusiness(w.alpha, async (tx) => {
    const item = await checkItem(tx, last);
    if (typeof item === 'string') throw new Error(`ceiling case: ${item}`);
    if (!(await roomFor(tx, operation)())) throw new Error('ceiling case: no room');
    await recordAsked(tx, [item], false);
    taken();
    await released;
  });
  try {
    // The holder's own failure ends the wait, rather than leaving it to the test timeout.
    await Promise.race([roomTaken, holding]);
    const held = await itemFor(w.task, 'decision');
    let settled = false;
    const racing = atOnce(held).finally(() => (settled = true));
    // It reads the count only under the ceiling's lock, so it waits for the holder.
    await expect.poll(waitingOnLock, { timeout: 5000 }).toBe(1);
    expect(settled).toBe(false);
    release();
    await holding;
    expect(await racing).toEqual({ ok: false, code: 'EMAIL_AT_CEILING' });
    expect(await attemptsOf(held)).toEqual([]);
  } finally {
    release();
    await holding.catch(() => {});
    await holder.close();
  }
});
