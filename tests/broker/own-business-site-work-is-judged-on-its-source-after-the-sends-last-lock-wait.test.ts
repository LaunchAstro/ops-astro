// SPDX-License-Identifier: AGPL-3.0-only
//
// R6, part 2: a model call is held in one transaction and started in another, and the start
// reads its facts again under the same locks (`lockFacts`): the task shared, then the run,
// the lease, the delegation and the held step's reservation, each locked for update. The
// task's source and party are read after the last of those waits, so a write by someone
// other than the owner, committed while the start waits on any of them, is seen: the call is
// released unsent with `LOCAL_MODEL_REQUIRED`, and never started. Each case commits its hold
// first, then holds one of those rows on a connection of its own, so the wait falls in the
// start and not in the hold, which reads the task afresh in its own transaction.

import { describe, expect, it } from 'vitest';
import { held, seenWaiting } from '../site/party-site-races.ts';
import {
  ask,
  askHeld,
  sends,
  serverUrl,
  useOwnSiteWorld,
  w,
  workedBy,
  wrote,
} from './own-site-broker-world.ts';

if (serverUrl === undefined)
  console.warn('Own-business site start waits: DATABASE_URL is unset, so nothing ran.');

useOwnSiteWorld('own1699start');

/** One lock the start takes after the task's: the row to hold, and the start's statement on it. */
interface Wait {
  readonly name: string;
  readonly hold: string;
  readonly start: RegExp;
}

const WAITS: readonly Wait[] = [
  {
    name: 'the run',
    hold: `select 1 from public.planned_runs r join public.leases l
              on l.business_id = r.business_id and l.run_id = r.id
            where l.business_id = $1 and l.id = $2 for update of r`,
    start: /from public\.planned_runs where business_id = \$1 and id = \$2 for update/u,
  },
  {
    name: 'the lease',
    hold: 'select 1 from public.leases where business_id = $1 and id = $2 for update',
    start: /from public\.leases where business_id = \$1 and id = \$2 for update/u,
  },
  {
    name: 'the delegation',
    hold: `select 1 from public.delegations d join public.leases l
              on l.business_id = d.business_id and l.delegation_id = d.id
            where l.business_id = $1 and l.id = $2 for update of d`,
    start: /from public\.delegations where business_id = \$1 and id = \$2 for update/u,
  },
  {
    name: 'the held step’s reservation',
    hold: `select 1 from public.reservations r join public.leases l
              on l.business_id = r.business_id and l.reservation_id = r.id
            where l.business_id = $1 and l.id = $2 for update of r`,
    start: /from public\.reservations r\s+join public\.planned_runs run[\s\S]*for update of r/u,
  },
];

/** The call's row: whether it was ever started, and where it ended. */
const callRow = async (
  callId: string,
): Promise<{ readonly state: string; readonly started: boolean } | undefined> =>
  (
    await w.world.db.admin.execute<{ readonly state: string; readonly started: boolean }>(
      'select state, started_at is not null as started from public.model_calls where id = $1',
      [callId],
    )
  )[0];

/**
 * The owner's work, its call held, then the start run while `wait`'s row is held; `during`
 * runs once the start is seen waiting there, before the row is let go.
 */
async function startWaitingOn(
  wait: Wait,
  title: string,
  during: (taskId: string) => Promise<void>,
) {
  const picked = await workedBy('owner', title);
  const leaseId = String(picked.detail['leaseId']);
  const { callId, send } = await askHeld(picked);
  const holding = held(w, async (tx) => {
    await tx.query(wait.hold, [tx.businessId, leaseId]);
  });
  await holding.ready;
  const before = sends();
  let waited = false;
  const answer = send();
  try {
    waited = await seenWaiting(w, wait.start);
    if (waited) await during(picked.taskId);
  } finally {
    holding.release();
    await holding.done;
  }
  return { answer: await answer, waited, sent: sends() - before, call: await callRow(callId) };
}

describe.skipIf(serverUrl === undefined)('at the start of a held model call', () => {
  it('refuses at once a call on work someone other than the owner has written', async () => {
    const picked = await workedBy('owner', 'Our about page, written before the call');
    await wrote(picked.taskId, w.world.agentActorId);
    const before = sends();
    expect(await ask(picked)).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
    expect(sends()).toBe(before);
  }, 120_000);

  for (const wait of WAITS) {
    it(`sends the owner’s work after a wait on ${wait.name} that nothing was written in`, async () => {
      const ran = await startWaitingOn(
        wait,
        `Our about page, quiet wait on ${wait.name}`,
        async () => {},
      );
      expect(ran.waited).toBe(true);
      expect(ran.answer).toMatchObject({ ok: true });
      expect(ran.sent).toBe(1);
    }, 120_000);

    it(`sees a non-owner write committed while the start waits on ${wait.name}, and sends nothing`, async () => {
      const ran = await startWaitingOn(
        wait,
        `Our about page, write during the wait on ${wait.name}`,
        async (taskId) => await wrote(taskId, w.world.agentActorId),
      );
      expect(ran.waited).toBe(true);
      expect(ran.answer).toMatchObject({ ok: false, code: 'LOCAL_MODEL_REQUIRED' });
      expect(ran.call).toEqual({ state: 'released', started: false });
      expect(ran.sent).toBe(0);
    }, 120_000);
  }
});
