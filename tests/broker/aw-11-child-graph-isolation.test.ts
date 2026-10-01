// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 child graph isolation: the helper entries on a run's node never cross
// a boundary. Three real crossings, each with its status and a stored canary
// checked: another business; another client of the same business, on a task
// shared with them; another person, a second helper under a live child
// delegation of its own, spending on its own parent's work.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from '../runtime/cq-8-world.ts';
import { insertHelper } from '../runtime/aw-11-child-world.ts';
import { codeOf, createTask } from '../runtime/schedules-harness.ts';
import { callOn, noDatabase, useSpendWorld, w } from './aw-11-spend-world.ts';
import { executionAs, handedWork, nodeOf } from './aw-11-child-graph-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useSpendWorld('aw11cgi');

it('AW-11 child graph isolation: another business', async () => {
  const canary = `aw11g-alpha-canary-${randomUUID()}`;
  const alpha = await handedWork(w.s, w.helper, canary);
  expect(codeOf(await callOn(w.s, alpha.work, w.helper.presented, alpha.childCredential))).toBe(
    'applied',
  );
  const bravo = await handedWork(w.bravo, w.bravoHelper);

  // Bravo's decider reads alpha's task, and bravo's helper spends on alpha's lease.
  const crossed = await executionAs(w.bravo, w.bravo.decider.presented, alpha.work.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  const spent = await callOn(w.bravo, alpha.work, w.bravoHelper.presented, bravo.childCredential);
  expect(codeOf(spent)).not.toBe('applied');
  // Bravo's own graph lists bravo's helper only.
  const bravoNode = await nodeOf(w.bravo, bravo.work);
  expect(bravoNode?.helpers).toMatchObject([
    { childDelegationId: bravo.childId, helperActorId: w.bravoHelper.actorId, steps: [] },
  ]);
  for (const body of [crossed, spent, bravoNode]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(alpha.work.taskId);
    expect(text).not.toContain(alpha.childId);
    expect(text).not.toContain(w.helper.actorId);
  }
  // Control: alpha's graph shows its helper and its one step, nothing of bravo's.
  const alphaNode = await nodeOf(w.s, alpha.work);
  expect(alphaNode?.helpers).toMatchObject([{ childDelegationId: alpha.childId }]);
  expect(alphaNode?.helpers?.[0]?.steps).toHaveLength(1);
  expect(JSON.stringify(alphaNode)).not.toContain(bravo.childId);
});

it('AW-11 child graph isolation: another client in the same business', async () => {
  const canary = `aw11g-client-two-canary-${randomUUID()}`;
  const one = await handedWork(w.s, w.helper);
  expect(codeOf(await callOn(w.s, one.work, w.helper.presented, one.childCredential))).toBe(
    'applied',
  );
  const twoTask = await createTask(w.s, canary);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, w.s.decider, 'share');
  });
  const clientTwo = await cq8World(w.s).client(w.s.business, w.s.decider, 'aw11g-two', twoTask);

  // Client two reads the parent's task's graph: not theirs to see.
  const crossed = await executionAs(w.s, clientTwo.presented, one.work.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  // Their own task has no run, so no helper either.
  const own = await executionAs(w.s, clientTwo.presented, twoTask);
  for (const body of [crossed, own]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(one.work.taskId);
    expect(text).not.toContain(one.childId);
    expect(text).not.toContain(w.helper.actorId);
  }
  // Control: the parent's graph names its helper and none of client two's task.
  const node = await nodeOf(w.s, one.work);
  expect(node?.helpers).toMatchObject([{ childDelegationId: one.childId }]);
  expect(JSON.stringify(node)).not.toContain(canary);
  expect(JSON.stringify(node)).not.toContain(twoTask);
});

it('AW-11 child graph isolation: another person, a second helper under a live child of its own', async () => {
  const canary = `aw11g-person-canary-${randomUUID()}`;
  const mine = await handedWork(w.s, w.helper, canary);
  const second = await insertHelper(w.s);
  const theirs = await handedWork(w.s, second);

  // The second helper, on its own live child, spends on my parent's lease: my
  // task is outside its child's purpose, asked before the broker.
  const reached = await callOn(w.s, mine.work, second.presented, theirs.childCredential);
  expect(codeOf(reached)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(codeOf(await callOn(w.s, theirs.work, second.presented, theirs.childCredential))).toBe(
    'applied',
  );
  // My graph lists my helper, with no step of theirs; theirs lists theirs.
  const myNode = await nodeOf(w.s, mine.work);
  expect(myNode?.helpers).toMatchObject([
    { childDelegationId: mine.childId, helperActorId: w.helper.actorId, steps: [] },
  ]);
  const theirNode = await nodeOf(w.s, theirs.work);
  expect(theirNode?.helpers).toMatchObject([
    { childDelegationId: theirs.childId, helperActorId: second.actorId },
  ]);
  expect(theirNode?.helpers?.[0]?.steps).toHaveLength(1);
  for (const body of [reached, theirNode]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(mine.childId);
    expect(text).not.toContain(mine.work.taskId);
  }
  expect(JSON.stringify(myNode)).not.toContain(theirs.childId);
  expect(JSON.stringify(myNode)).not.toContain(second.actorId);
});
