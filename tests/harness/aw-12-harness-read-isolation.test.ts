// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 isolation over the route: `harness.read` is a new endpoint, so the
// trigger read's crossings run again through the real API boundary. Each
// crossing has its status, a stored canary (the task's title and a reading no
// other run has) checked in every body, refusals included, and a positive
// control: another business; another client in the same business; a person
// with no `task:read`; an agent under a live delegation on the very run.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { enrol, grantTo } from '../commands/fixture.ts';
import { noDatabase, useChildWorld, w } from '../runtime/aw-11-child-world.ts';
import { shapedWork } from './aw-12-world.ts';
import { harnessOver, useHarnessRoute, type Answer } from './aw-12-route-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw12ri');
useHarnessRoute();

/** A reading no other run in the world has, so its figure is a canary of its own. */
const CANARY_UNITS = 31_337;

const clean = (answer: Answer, ...canaries: string[]): void => {
  const text = JSON.stringify(answer.body);
  for (const canary of [...canaries, String(CANARY_UNITS)]) expect(text).not.toContain(canary);
  expect(answer.body).not.toHaveProperty('harness');
};

const reads = (units: number) => ({
  status: 200,
  body: {
    ok: true,
    harness: expect.objectContaining({
      figures: expect.objectContaining({ reading: expect.objectContaining({ units }) }),
    }),
  },
});

it('AW-12 harness read isolation: another business’s run is NOT_FOUND over the route', async () => {
  const canary = `aw12r-alpha-canary-${randomUUID()}`;
  const alpha = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const bravo = await shapedWork(w.bravo, [100], w.bravoHelper);

  // Bravo's member naming alpha's run in bravo: not there.
  const crossed = await harnessOver(w.bravo, w.bravo.decider, alpha.runId);
  expect(crossed).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  // A made-up run is the same answer, byte for byte: the refusal tells nothing apart.
  const madeUp = await harnessOver(w.bravo, w.bravo.decider, randomUUID());
  expect(JSON.stringify(madeUp)).toBe(JSON.stringify(crossed));
  // Alpha's member on bravo's address: no standing there at all.
  const carried = await harnessOver(w.bravo, w.s.decider, alpha.runId);
  expect(carried.body).toMatchObject({ refused: true });
  for (const answer of [crossed, carried]) clean(answer, canary, alpha.runId, alpha.work.taskId);
  // Controls: each reads its own over the route.
  expect(await harnessOver(w.s, w.s.decider, alpha.runId)).toMatchObject(reads(CANARY_UNITS));
  expect(await harnessOver(w.bravo, w.bravo.decider, bravo.runId)).toMatchObject(reads(100));
});

it('AW-12 harness read isolation: another client’s run in the same business is NOT_FOUND over the route', async () => {
  const canary = `aw12r-client-canary-${randomUUID()}`;
  const one = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const two = await shapedWork(w.s, [200], w.helper);
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
  // Client two's account manager: task:read on client two, never on a task or the business.
  const manager = await enrol(w.s.db.app, w.s.business, 'aw12r-manager');
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, manager, 'read', { kind: 'party', id: clientTwo });
  });

  const wrongClient = await harnessOver(w.s, manager, one.runId);
  expect(wrongClient).toMatchObject({ status: 404, body: { code: 'NOT_FOUND' } });
  clean(wrongClient, canary, clientOne, one.runId, one.work.taskId);
  // Control: the client grant reads client two's run.
  expect(await harnessOver(w.s, manager, two.runId)).toMatchObject(reads(200));
});

it('AW-12 harness read isolation: a person without task:read gets SCOPE_NOT_GRANTED over the route', async () => {
  const canary = `aw12r-person-canary-${randomUUID()}`;
  const mine = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const colleague = await enrol(w.s.db.app, w.s.business, 'aw12r-colleague');

  const ungranted = await harnessOver(w.s, colleague, mine.runId);
  expect(ungranted).toMatchObject({ status: 403, body: { code: 'SCOPE_NOT_GRANTED' } });
  // The same answer for a run that is not there: the refusal says nothing about the run.
  const missing = await harnessOver(w.s, colleague, randomUUID());
  expect(missing.body).toStrictEqual(ungranted.body);
  clean(ungranted, canary, mine.runId, mine.work.taskId);
  // Control: once granted task:read, the same person reads it.
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, colleague, 'read', { kind: 'record', id: mine.work.taskId });
  });
  expect(await harnessOver(w.s, colleague, mine.runId)).toMatchObject(reads(CANARY_UNITS));
});

it('AW-12 harness read isolation: an agent under a live delegation on the run is refused on the agent route', async () => {
  const canary = `aw12r-agent-canary-${randomUUID()}`;
  const mine = await shapedWork(w.s, [CANARY_UNITS], w.helper, canary);
  const credential = String(mine.work.picked['credential']);

  // The run's own agent, its delegation on this very run live: no agent reads the result.
  const agent = await harnessOver(w.s, { presented: w.s.agent }, mine.runId, credential);
  expect(agent.status).toBeGreaterThanOrEqual(400);
  expect(agent.body).toMatchObject({ refused: true });
  // Its login on the person route is no member's either.
  const asPerson = await harnessOver(w.s, { presented: w.s.agent }, mine.runId);
  expect(asPerson.body).toMatchObject({ refused: true });
  for (const answer of [agent, asPerson]) clean(answer, canary, mine.runId, credential);
  // Control: the person the delegation draws on reads it.
  expect(await harnessOver(w.s, w.s.decider, mine.runId)).toMatchObject(reads(CANARY_UNITS));
});
