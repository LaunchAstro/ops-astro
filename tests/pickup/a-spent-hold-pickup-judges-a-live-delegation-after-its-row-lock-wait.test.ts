// SPDX-License-Identifier: AGPL-3.0-only
//
// A pickup that stops at a spent hold raises its budget ask, then, for an agent, locks the agent's
// unsettled delegation for the purpose and refuses the stop while that delegation is live. Each
// case here holds that delegation's row on a connection of its own while the pickup, on another,
// waits on it: the delegation is judged once the wait is over, at the clock, and so is the
// delegating person's authority the ask rests on.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { s, useBrokerWorld } from '../broker/broker-world.ts';
import { instantOf, latch, waiterOf, waitPast, type Held } from '../support/lock-wait-race.ts';
import { codeOf, racer, rows, settle, type Work } from '../runtime/schedules-harness.ts';
import {
  asksOn,
  delegationBeside,
  holdDelegation,
  pickupOf,
  spentWhole,
} from '../runtime/resume-sizing-world.ts';

useBrokerWorld('spentholdwait');

const LATER = (): Date => new Date(Date.now() + 600_000);

/** Moves a delegation's expiry to a few seconds from the database's now, and answers it. */
const expiringSoon = async (id: string): Promise<string> =>
  await instantOf(
    s.db,
    `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
      where id = $1 returning expires_at::text as at`,
    [id],
  );

/** Whether the pickup was already waiting on `holder` while the database's clock was before `deadline`. */
async function waitingBefore(holder: Held, deadline: string): Promise<boolean> {
  await waiterOf(s.db, holder);
  const [row] = await s.db.admin.execute<{ before: boolean }>(
    'select clock_timestamp() < $1::text::timestamptz as before',
    [deadline],
  );
  return row?.before === true;
}

it.skipIf(serverUrl === undefined)(
  'a live delegation that expires while the stop waits on its row lets the ask stand',
  async () => {
    const work = await spentWhole('expires in the wait');
    const live = await delegationBeside(work, LATER());
    const deadline = await expiringSoon(live);
    const holder = await holdDelegation(live);
    const other = racer(s);
    try {
      const picking = pickupOf(work, { database: other });
      expect(await waitingBefore(holder, deadline)).toBe(true);
      await waitPast(s.db, deadline);
      await holder.letGo();
      expect(codeOf(await picking)).toBe('BUDGET_UNAVAILABLE');
    } finally {
      await holder.letGo();
      await other.close();
    }
    expect(await asksOn(work)).toHaveLength(1);
  },
);

it.skipIf(serverUrl === undefined)(
  'a handback settling the live delegation while the stop waits lets the ask stand',
  async () => {
    const work = await spentWhole('settled in the wait');
    const live = await delegationBeside(work, LATER());
    const holder = await holdDelegation(live, async (execute) => {
      await execute('update public.delegations set settled_at = now() where id = $1', [live]);
    });
    const other = racer(s);
    try {
      const picking = pickupOf(work, { database: other });
      await waiterOf(s.db, holder);
      await holder.letGo();
      expect(codeOf(await picking)).toBe('BUDGET_UNAVAILABLE');
    } finally {
      await holder.letGo();
      await other.close();
    }
    expect(await asksOn(work)).toHaveLength(1);
  },
);

it.skipIf(serverUrl === undefined)(
  'a delegation still live when the stop gets its row refuses the stop and takes the ask back',
  async () => {
    const work = await spentWhole('live after the wait');
    const live = await delegationBeside(work, LATER());
    const holder = await holdDelegation(live);
    const other = racer(s);
    try {
      const picking = pickupOf(work, { database: other });
      await waiterOf(s.db, holder);
      await holder.letGo();
      expect(codeOf(await picking)).toBe('DELEGATION_ALREADY_LIVE');
    } finally {
      await holder.letGo();
      await other.close();
    }
    expect(await asksOn(work)).toEqual([]);
  },
);

/** Waits until `count` backends wait on a lock one of `pids` holds. */
async function waitingOn(pids: readonly number[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await s.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity a
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and pg_blocking_pids(a.pid) && $1::int[]`,
      [pids],
    );
    if ((row?.n ?? 0) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(25);
  }
  throw new Error(`fewer than ${String(count)} pickups ever waited`);
}

/** The backend of a racer's one connection. */
const pidOf = async (database: ReturnType<typeof racer>): Promise<number> =>
  await database.withBusiness(s.business, async (tx) => {
    const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    return Number(me?.pid);
  });

it.skipIf(serverUrl === undefined)(
  'two stops at once beside a live delegation are both refused and raise no ask',
  async () => {
    const work = await spentWhole('two beside live');
    const live = await delegationBeside(work, LATER());
    const holder = await holdDelegation(live);
    const first = racer(s);
    const second = racer(s);
    try {
      const pids = [holder.pid, await pidOf(first), await pidOf(second)];
      const racing = [pickupOf(work, { database: first }), pickupOf(work, { database: second })];
      await waitingOn(pids, 2);
      await holder.letGo();
      const results = await settle(racing);
      expect(
        results.map((one) => (one.status === 'fulfilled' ? codeOf(one.value) : 'rejected')),
      ).toEqual(['DELEGATION_ALREADY_LIVE', 'DELEGATION_ALREADY_LIVE']);
    } finally {
      await holder.letGo();
      await first.close();
      await second.close();
    }
    expect(await asksOn(work)).toEqual([]);
  },
);

it.skipIf(serverUrl === undefined)(
  "a delegating person's grant lapsing while the stop waits on the delegation raises no ask",
  async () => {
    const work = await spentWhole('grant lapses in the wait');
    const live = await delegationBeside(work, LATER());
    const holder = await holdDelegation(live, async (execute) => {
      await execute('update public.delegations set settled_at = now() where id = $1', [live]);
    });
    // The approver's write lapses while the stop waits: an ask made then rests on nothing.
    const lapsing = await rows<{ id: string; at: string }>(
      s,
      `update public.grants set expires_at = clock_timestamp() + interval '3 seconds'
        where subject_id = $1 and action = 'write' and expires_at is null
        returning id, expires_at::text as at`,
      [s.decider.personId],
    );
    const deadline = lapsing[0]?.at ?? '';
    const other = racer(s);
    try {
      const picking = pickupOf(work, { database: other, operationId: randomUUID() });
      expect(await waitingBefore(holder, deadline)).toBe(true);
      await waitPast(s.db, deadline);
      await holder.letGo();
      expect(codeOf(await picking)).toBe('DELEGATION_WIDENS');
    } finally {
      await holder.letGo();
      await other.close();
      await rows(s, 'update public.grants set expires_at = null where id = any($1::uuid[])', [
        lapsing.map((one) => one.id),
      ]);
    }
    expect(await asksOn(work)).toEqual([]);
  },
);

/**
 * A mint of the agent's next delegation for `work`'s purpose, on a connection of its own: it
 * settles the expired one, inserts the new one, and holds both rows until let go, which commits it
 * and answers the new one's id.
 */
async function mintHeldOpen(work: Work): Promise<Held<string> & { close(): Promise<void> }> {
  const minter = racer(s);
  const minted = latch<number>();
  const release = latch();
  const minting = minter.withBusiness(s.business, async (tx) => {
    const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    const id = await delegationBeside(work, LATER(), tx);
    minted.open(Number(me?.pid));
    await release.promise;
    return id;
  });
  const pid = await Promise.race([minted.promise, minting.then(() => -1)]);
  if (pid === -1) throw new Error('the mint ended before it held its rows');
  return {
    pid,
    letGo: async () => {
      release.open();
      return await minting;
    },
    close: async () => {
      release.open();
      await minting.catch(() => null);
      await minter.close();
    },
  };
}

it.skipIf(serverUrl === undefined)(
  "a mint settling the agent's expired delegation while the stop waits on it leaves the stop's ask",
  async () => {
    const work = await spentWhole('mint in the wait');
    const spent = await delegationBeside(work, LATER());
    await s.db.admin.execute(
      `update public.delegations
        set granted_at = clock_timestamp() - interval '1 minute',
            expires_at = clock_timestamp() - interval '1 second'
      where id = $1`,
      [spent],
    );
    const mint = await mintHeldOpen(work);
    const other = racer(s);
    try {
      const picking = pickupOf(work, { database: other });
      await waiterOf(s.db, mint);
      const fresh = String(await mint.letGo());
      // Its read began before the mint committed: as if it came first, it asks.
      expect(codeOf(await picking)).toBe('BUDGET_UNAVAILABLE');
      const settled = await rows<{ id: string; settled: boolean }>(
        s,
        'select id, settled_at is not null as settled from public.delegations where id = any($1::uuid[])',
        [[spent, fresh]],
      );
      expect(new Map(settled.map((one) => [one.id, one.settled]))).toEqual(
        new Map([
          [spent, true],
          [fresh, false],
        ]),
      );
    } finally {
      await mint.close();
      await other.close();
    }
    expect(await asksOn(work)).toHaveLength(1);
  },
);
