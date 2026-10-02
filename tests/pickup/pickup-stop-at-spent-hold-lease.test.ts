// SPDX-License-Identifier: AGPL-3.0-only
//
// A pickup that meets a spent hold stops the run at its budget and keeps the
// stop's ask (AW-05). It answers another holder's live lease on the task first,
// as every pickup does: a live, unexpired lease is refused LEASE_HELD and the
// refusal takes the stop and its ask back; an expired one is fenced, as a
// pickup fences it, and the stop goes on. Driven through the real command
// entry, a person's and an agent's, on one task with two approved lineages.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  liveWork,
  pickup,
  propose,
  rows,
  seedSchedules,
  waitPast,
  type Detail,
  type Work,
} from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from '../broker/broker-world.ts';
import {
  asksOn,
  holdOpenAtWhole,
  holdsOn,
  pickupOf,
  revoke,
  settleAtWhole,
} from '../runtime/resume-sizing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('stopfence');

interface Beside {
  /** The lineage whose one call spent its whole hold; its delegation is revoked. */
  readonly spent: Work;
  /** The other lineage's approved, unclaimed reservation on the same task. */
  readonly other: string;
}

/**
 * One task with two approved lineages. A first piece of work opens the task's
 * envelope and hands back, leaving room; the spent lineage's call then settles
 * at its whole hold and its delegation is revoked, so its hold settles at that
 * spend and its run waits to be claimed again. (A call still open at the revoke
 * would keep the whole hold for a person, never claimed again.)
 */
const spentBeside = async (label: string): Promise<Beside> => {
  const taskId = await createTask(s, `stop fence ${label} ${randomUUID()}`);
  const opening = await approve(
    s,
    await propose(s, taskId, { maximumMinor: 2_500, purpose: freshPurpose() }),
  );
  const opened = await pickup(s, opening['reservationId']);
  const body = handbackBody(opened);
  appliedDetail(await asAgent(s, body, String(opened['credential'])), 'task.handback');
  const lineage = async () => {
    const proposal = await propose(s, taskId, { maximumMinor: 500, purpose: freshPurpose() });
    return { proposal, decision: await approve(s, proposal) };
  };
  const first = await lineage();
  const second = await lineage();
  const picked = await pickup(s, first.decision['reservationId']);
  const spent = await settleAtWhole(await holdOpenAtWhole({ taskId, ...first, picked }));
  await revoke(spent);
  return { spent, other: String(second.decision['reservationId']) };
};

const personPickup = async (reservationId: unknown, leaseSeconds = 600) =>
  await asPerson(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId,
    leaseSeconds,
  });

const takenByPerson = async (reservationId: string, leaseSeconds = 600): Promise<Detail> =>
  appliedDetail(await personPickup(reservationId, leaseSeconds), 'task.pickup');

const leasesOn = async (taskId: string) =>
  await rows<{ id: string; state: string }>(
    s,
    'select id, state from public.leases where task_id = $1 order by acquired_at, id',
    [taskId],
  );

const runOf = async (work: Work): Promise<string | undefined> =>
  (
    await rows<{ state: string }>(
      s,
      `select run.state from public.planned_runs run
         join public.reservations r on r.run_id = run.id where r.id = $1`,
      [work.decision['reservationId']],
    )
  )[0]?.state;

/** Refused as held, and nothing the stop wrote is kept: no ask, the run unclaimed, the hold as it was. */
const refusedAsHeld = async (code: string, spent: Work, holderLease: unknown): Promise<void> => {
  expect(code).toBe('LEASE_HELD');
  expect(await asksOn(spent)).toEqual([]);
  expect(await runOf(spent)).toBe('planned');
  expect((await holdsOn(spent)).map((one) => one.state)).toEqual(['actual']);
  const live = (await leasesOn(spent.taskId)).filter((one) => one.state === 'live');
  expect(live.map((one) => one.id)).toEqual([holderLease]);
};

const keptTheAsk = async (spent: Work): Promise<void> => {
  expect(await asksOn(spent)).toEqual([
    { run_state: 'waiting_budget', ceiling: '500', spent: '500', kind: 'stop' },
  ]);
};

it("a stop at a spent hold while another holder's lease is live is refused as held, and keeps no ask: an agent claimant", async () => {
  const { spent, other } = await spentBeside('agent');
  const holder = await takenByPerson(other);

  const refused = await pickupOf(spent);

  await refusedAsHeld(codeOf(refused), spent, holder['leaseId']);
});

it("a stop at a spent hold while another holder's lease is live is refused as held, and keeps no ask: a person claimant", async () => {
  const { spent, other } = await spentBeside('person');
  const holder = await pickup(s, other);

  const refused = await personPickup(spent.decision['reservationId']);

  await refusedAsHeld(codeOf(refused), spent, holder['leaseId']);
});

it('with no live lease the stop at a spent hold keeps its ask', async () => {
  const { spent, other } = await spentBeside('handed back');
  const holder = await takenByPerson(other);
  appliedDetail(await asPerson(s, handbackBody(holder)), 'task.handback');

  const stopped = await pickupOf(spent);

  expect(codeOf(stopped)).toBe('BUDGET_UNAVAILABLE');
  await keptTheAsk(spent);
});

it("a stop at a spent hold fences another holder's expired lease as a pickup does, and keeps its ask", async () => {
  const { spent, other } = await spentBeside('expired');
  const holder = await takenByPerson(other, 1);
  await waitPast(s, 'select expires_at from public.leases where id = $1', holder['leaseId']);

  const stopped = await pickupOf(spent);

  expect(codeOf(stopped)).toBe('BUDGET_UNAVAILABLE');
  await keptTheAsk(spent);
  expect(await leasesOn(spent.taskId)).toContainEqual({ id: holder['leaseId'], state: 'expired' });
  const [fenced] = await rows<{ state: string }>(
    s,
    'select state from public.reservations where id = $1',
    [other],
  );
  expect(fenced?.state).not.toBe('held');
});

it("a live lease in another business on a task with the same shape does not refuse this business's stop", async () => {
  const theirs = await seedSchedules(s.db, 'stopfence-other', 1_000_000);
  const held = await liveWork(theirs, `stop fence theirs ${randomUUID()}`, 500);
  const { spent } = await spentBeside('ours');

  const stopped = await pickupOf(spent);

  expect(codeOf(stopped)).toBe('BUDGET_UNAVAILABLE');
  await keptTheAsk(spent);
  expect(await leasesOn(held.taskId)).toEqual([{ id: held.picked['leaseId'], state: 'live' }]);
});
