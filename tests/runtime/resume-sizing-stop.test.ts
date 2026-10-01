// SPDX-License-Identifier: AGPL-3.0-only
//
// SL11-29 FIXMONEY's blocking findings, Sol's proofs:
// - B1: a hold the classifier settled with a call open at its maximum is sized
//   for its replacement from its calls as they stand now, so a call that came
//   to less gives the step that room back, and raises no false AW-05 ask.
// - B2: a step whose spend used its whole hold, on a run whose three asks are
//   spent, ends the run and tells a person, at pickup and at a drop's resume;
//   it never leaves the run planned or claimed with no hold.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { readTaskExecution } from '../../packages/core-commands/src/reads/execution.ts';
import {
  appliedDetail,
  asAgent,
  codeOf,
  handbackBody,
  liveWork,
  rows,
  type Work,
} from './schedules-harness.ts';
import { call, noDatabase, s, useBrokerWorld, world } from '../broker/broker-world.ts';
import { calls, dispatched, envelopeActual, gated } from '../broker/give-back-world.ts';
import {
  asksOn,
  holdsOn,
  openAtWhole,
  pickupOf,
  revoke,
  spentWhole,
} from './resume-sizing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('resizestop');

it('Sol proof, FIXMONEY: a spent-whole hold whose open call settles lower before pickup is re-held at what remains, with no ask', async () => {
  const work = await liveWork(s, `resize lower ${randomUUID()}`, 500);
  world.provider.mode('answer');
  const { broker: slow, open } = gated();
  const pending = call(work, {}, slow);
  await dispatched(work);
  const before = await envelopeActual(work);
  await revoke(work);
  open();
  await pending;
  const [ended] = await calls(work);
  const came = Number(ended?.came_to);
  expect(came).toBeLessThan(500);

  const picked = await pickupOf(work);

  expect(codeOf(picked)).toBe('applied');
  expect(await asksOn(work)).toEqual([]);
  const [, fresh] = await holdsOn(work);
  expect(fresh).toMatchObject({ state: 'held', held: String(500 - came) });
  expect(await envelopeActual(work)).toBe(before + came);
  const read = await s.db.app.withBusiness(
    s.business,
    async (tx) => await readTaskExecution(tx, work.taskId, 0),
  );
  const node = read.graph.nodes.find((one) => one.nodeId === work.picked['runId']);
  expect(node?.observed).toMatchObject({ spentMinor: came });
});

/** The run's three asks, raised already: the third is the consolidated decision. */
const asksSpent = async (work: Work): Promise<void> => {
  for (const at of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    await rows(
      s,
      `insert into public.budget_asks
         (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
          ceiling_minor, spent_minor, currency)
       select r.business_id, $2, r.run_id, r.id, $3, d.id, $4, $5, r.held_minor, 0, 'AUD'
         from public.reservations r
         join public.gate_decisions d on d.business_id = r.business_id and d.version_id = r.version_id
        where r.id = $1 and d.decision = 'approve'`,
      [
        work.decision['reservationId'],
        randomUUID(),
        work.picked['leaseId'],
        at,
        at === 3 ? 'consolidated' : 'stop',
      ],
    );
  }
};

const ended = async (work: Work) => ({
  run: (
    await rows<{ state: string }>(
      s,
      'select run.state from public.planned_runs run join public.reservations r on r.run_id = run.id where r.id = $1',
      [work.decision['reservationId']],
    )
  )[0]?.state,
  alerts: await rows<{ kind: string; waiting_reason: string }>(
    s,
    `select kind, waiting_reason from public.alerts where task_id = $1 and kind = 'awaiting_person'`,
    [work.taskId],
  ),
  asks: (await asksOn(work)).length,
});

it('Sol proof, FIXMONEY: a spent-whole stop after the consolidated ask ends the run and alerts a person', async () => {
  const work = await spentWhole('consolidated');
  await asksSpent(work);

  const refused = await pickupOf(work);

  expect(codeOf(refused)).toBe('BUDGET_UNAVAILABLE');
  expect(await ended(work)).toEqual({
    run: 'cancelled',
    alerts: [{ kind: 'awaiting_person', waiting_reason: 'needs_approval' }],
    asks: 3,
  });

  // The same through a dropped hand-back's resume.
  const dropped = await openAtWhole('consolidated drop');
  await asksSpent(dropped);
  const body = {
    ...handbackBody(dropped.picked),
    outcome: 'dropped',
    report: { summary: 'the connection went', dropCause: 'connection_lost' },
  };

  appliedDetail(await asAgent(s, body, String(dropped.picked['credential'])), 'task.handback');

  expect(await ended(dropped)).toEqual({
    run: 'cancelled',
    alerts: [{ kind: 'awaiting_person', waiting_reason: 'needs_approval' }],
    asks: 3,
  });
  expect((await holdsOn(dropped)).map((one) => one.state)).toEqual(['actual']);
});
