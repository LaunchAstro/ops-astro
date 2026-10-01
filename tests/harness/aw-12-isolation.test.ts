// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 isolation, as far as part one reaches: the trigger read is the one
// thing in it that reads a business's rows. Three real crossings, each with
// its status, a stored canary (the task's title and a reading no other run
// has) checked in every answer, and a positive control: another business;
// another client of the same business, by a grant on a task and by one on
// the client itself; another person, an agent under a live child delegation
// on the very run.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { enrol, grantTo } from '../commands/fixture.ts';
import { noDatabase, useChildWorld, w } from '../runtime/aw-11-child-world.ts';
import { cq8World } from '../runtime/cq-8-world.ts';
import { shapedWork, triggerAs } from './aw-12-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw12i');

/** A reading no other run in the world has, so its figure is a canary of its own. */
const CANARY_UNITS = 31_337;

const clean = (answer: unknown, ...canaries: string[]): void => {
  const text = JSON.stringify(answer);
  for (const canary of [...canaries, String(CANARY_UNITS)]) expect(text).not.toContain(canary);
};

it('AW-12 isolation: another business', async () => {
  const canary = `aw12-alpha-canary-${randomUUID()}`;
  const alpha = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const bravo = await shapedWork(w.bravo, [100], w.bravoHelper);

  // Bravo's member naming alpha's run in bravo: not there.
  const crossed = await triggerAs(w.bravo, w.bravo.decider, alpha.runId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  // Alpha's member signed in to bravo: no standing there at all.
  const carried = await triggerAs(w.bravo, w.s.decider, alpha.runId);
  expect(carried).toMatchObject({ refused: true });
  for (const answer of [crossed, carried]) clean(answer, canary, alpha.runId, alpha.work.taskId);
  // Controls: each reads its own.
  expect(await triggerAs(w.s, w.s.decider, alpha.runId)).toMatchObject({
    figures: { reading: { units: CANARY_UNITS }, delegation: { depth: 1 } },
  });
  expect(await triggerAs(w.bravo, w.bravo.decider, bravo.runId)).toMatchObject({
    figures: { reading: { units: 100 } },
  });
});

it('AW-12 isolation: another client in the same business, one grant each', async () => {
  const canary = `aw12-client-one-canary-${randomUUID()}`;
  const one = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const two = await shapedWork(w.s, [200], w.helper);
  // Client two's account manager holds one grant: read on client two's task.
  const manager = await enrol(w.s.db.app, w.s.business, 'aw12-manager');
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, manager, 'read', { kind: 'record', id: two.work.taskId });
    await grantTo(tx, w.s.decider, 'share');
  });
  const clientTwo = await cq8World(w.s).client(
    w.s.business,
    w.s.decider,
    'aw12-two',
    two.work.taskId,
  );

  const wrongClient = await triggerAs(w.s, manager, one.runId);
  expect(wrongClient).toMatchObject({ code: 'NOT_FOUND' });
  // The client is outside the team: the harness result is the team's.
  const asClient = await triggerAs(w.s, clientTwo, one.runId);
  const ownAsClient = await triggerAs(w.s, clientTwo, two.runId);
  expect(asClient).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  expect(ownAsClient).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  for (const answer of [wrongClient, asClient, ownAsClient]) {
    clean(answer, canary, one.runId, one.work.taskId);
  }
  // Control: the manager reads client two's run under the one grant.
  expect(await triggerAs(w.s, manager, two.runId)).toMatchObject({
    figures: { reading: { units: 200 } },
  });
});

it('AW-12 isolation: another client in the same business, a grant on client two itself', async () => {
  const canary = `aw12-client-grant-canary-${randomUUID()}`;
  const one = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const two = await shapedWork(w.s, [300], w.helper);
  const [clientOne, clientTwo] = [randomUUID(), randomUUID()];
  for (const [task, client] of [
    [one.work.taskId, clientOne],
    [two.work.taskId, clientTwo],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one task at a time
    await w.s.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $3::text)
        where business_id = $1 and id = $2`,
      [w.s.business, task, client],
    );
  }
  // task:read on client two (a party grant), never on a task or the business.
  const manager = await enrol(w.s.db.app, w.s.business, 'aw12-client-manager');
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, manager, 'read', { kind: 'party', id: clientTwo });
  });

  const wrongClient = await triggerAs(w.s, manager, one.runId);
  expect(wrongClient).toMatchObject({ code: 'NOT_FOUND' });
  clean(wrongClient, canary, clientOne, one.runId, one.work.taskId);
  // Control: the client grant reads client two's run.
  expect(await triggerAs(w.s, manager, two.runId)).toMatchObject({
    figures: { reading: { units: 300 } },
  });
});

it('AW-12 isolation: another person, an agent under a live child delegation on the run', async () => {
  const canary = `aw12-person-canary-${randomUUID()}`;
  const mine = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  if (mine.childId === null) throw new Error('no child');

  // The helper holds a live child delegation on this very run: no session.
  const helper = await triggerAs(w.s, w.helper, mine.runId);
  expect(helper).toMatchObject({ refused: true, code: 'AUTH_NO_MEMBERSHIP' });
  // A colleague with no grant on the task.
  const colleague = await enrol(w.s.db.app, w.s.business, 'aw12-colleague');
  const ungranted = await triggerAs(w.s, colleague, mine.runId);
  expect(ungranted).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  for (const answer of [helper, ungranted]) clean(answer, canary, mine.runId, mine.childId);
  // Control: the person the parent delegation draws on reads it.
  expect(await triggerAs(w.s, w.s.decider, mine.runId)).toMatchObject({
    figures: { reading: { units: CANARY_UNITS }, delegation: { depth: 1 } },
  });
});
