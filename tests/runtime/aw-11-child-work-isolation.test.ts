// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 child work isolation: a helper's pickup, handback and the parent's
// merged result never cross a boundary. Three real crossings, each with its
// status and a stored canary checked: another business; another client of
// the same business, on a task shared with them; another person, a second
// helper under a live child delegation of its own.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { handBackChild } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { createTask } from './schedules-harness.ts';
import {
  callCode,
  childRequest,
  insertHelper,
  noDatabase,
  parentWork,
  readAsHelper,
  useChildWorld,
  w,
} from './aw-11-child-world.ts';
import { codeOf, delegated, delegateOn, handBack, resultsOf } from './aw-11-child-work-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11wi');

it('AW-11 child work isolation: another business', async () => {
  const canary = `aw11w-alpha-canary-${randomUUID()}`;
  const alpha = await parentWork(w.s, canary);
  const handed = await delegateOn(w.s, alpha.parent, alpha.work, childRequest(w.helper));
  if (!handed.ok) throw new Error(handed.refusal.code);
  const bravo = await parentWork(w.bravo);

  // Bravo's parent, and alpha's parent carried into bravo's transaction,
  // naming alpha's lease: no such lease there, and no child written.
  const crossed = await delegateOn(w.bravo, bravo.parent, alpha.work, childRequest(w.bravoHelper));
  const carried = await delegateOn(w.bravo, alpha.parent, alpha.work, childRequest(w.bravoHelper));
  expect(codeOf(crossed)).toBe('LEASE_NOT_OWNED');
  expect(codeOf(carried)).toBe('LEASE_NOT_OWNED');
  // Alpha's child handed back in bravo, as alpha's helper and as bravo's.
  const back = await handBack(w.bravo, w.helper, handed.value.credential, { outcome: 'completed' });
  const bravoBack = await handBack(w.bravo, w.bravoHelper, handed.value.credential, {
    outcome: 'completed',
  });
  expect(codeOf(back)).toBe('DELEGATION_NOT_LIVE');
  expect(codeOf(bravoBack)).toBe('DELEGATION_NOT_LIVE');
  // Alpha's parent read in bravo lists nothing.
  const listed = await resultsOf(w.bravo, alpha.parent);
  expect(listed).toEqual([]);
  for (const body of [crossed, carried, back, bravoBack, listed]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(alpha.work.taskId);
    expect(text).not.toContain(handed.value.childDelegationId);
  }
  // Controls: alpha still sees its helper at work; bravo hands over its own.
  expect(await resultsOf(w.s, alpha.parent)).toMatchObject([{ state: 'working' }]);
  expect(
    codeOf(await delegateOn(w.bravo, bravo.parent, bravo.work, childRequest(w.bravoHelper))),
  ).toBe('ok');
});

it('AW-11 child work isolation: another client in the same business', async () => {
  const canary = `aw11w-client-two-canary-${randomUUID()}`;
  const one = await delegated(w.s, w.helper);
  const twoTask = await createTask(w.s, canary);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, w.s.decider, 'share');
  });
  const clientTwo = await cq8World(w.s).client(w.s.business, w.s.decider, 'aw11w-two', twoTask);

  // The helper, reaching for the other client's task, is outside its purpose.
  const reached = await readAsHelper(w.s, w.helper, one.credential, twoTask);
  expect(callCode(reached)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(JSON.stringify(reached)).not.toContain(canary);
  expect(JSON.stringify(reached)).not.toContain(twoTask);
  // The helper's merged result names nothing of the other client's task.
  expect(codeOf(await handBack(w.s, w.helper, one.credential, { outcome: 'completed' }))).toBe(
    'ok',
  );
  const merged = await resultsOf(w.s, one.parent);
  expect(JSON.stringify(merged)).not.toContain(twoTask);
  // The other client reads their own task, never the parent's or its helper.
  const read = async (recordId: string) =>
    await executeRead(w.s.db.app, w.s.business, clientTwo.presented, {
      read: 'task.read',
      recordId,
    } as never);
  expect(await read(twoTask)).toHaveProperty('sharedTask');
  const crossed = await read(one.work.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  expect(JSON.stringify(crossed)).not.toContain(one.childId);
  expect(JSON.stringify(crossed)).not.toContain(w.helper.actorId);
});

it('AW-11 child work isolation: another person, a second helper under a live child of its own', async () => {
  const canary = `aw11w-person-canary-${randomUUID()}`;
  const mine = await parentWork(w.s, canary);
  const handed = await delegateOn(w.s, mine.parent, mine.work, childRequest(w.helper));
  if (!handed.ok) throw new Error(handed.refusal.code);
  const second = await insertHelper(w.s);
  const theirs = await delegated(w.s, second);

  // Each child's credential is bound to its own helper.
  const borrowed = await handBack(w.s, second, handed.value.credential, { outcome: 'completed' });
  const lent = await handBack(w.s, w.helper, theirs.credential, { outcome: 'completed' });
  expect(codeOf(borrowed)).toBe('DELEGATION_NOT_LIVE');
  expect(codeOf(lent)).toBe('DELEGATION_NOT_LIVE');
  // The other parent, under its own live delegation, cannot hand my work over.
  const taken = await delegateOn(w.s, theirs.parent, mine.work, childRequest(second));
  expect(codeOf(taken)).toBe('LEASE_NOT_OWNED');
  // The parent's agent is no helper: its own credential settles no child.
  const parentAsHelper = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) =>
      await handBackChild(
        tx,
        { agentActorId: w.s.agentActorId, credential: mine.credential },
        { outcome: 'completed' },
      ),
  );
  expect(codeOf(parentAsHelper)).toBe('DELEGATION_NOT_LIVE');
  // Each parent's merged result lists its own helper only.
  const theirResults = await resultsOf(w.s, theirs.parent);
  expect(theirResults).toMatchObject([{ helperActorId: second.actorId, state: 'working' }]);
  for (const body of [borrowed, lent, taken, parentAsHelper, theirResults]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(handed.value.childDelegationId);
    expect(text).not.toContain(mine.work.taskId);
  }
  // Controls.
  expect(
    codeOf(await handBack(w.s, w.helper, handed.value.credential, { outcome: 'completed' })),
  ).toBe('ok');
  expect(codeOf(await handBack(w.s, second, theirs.credential, { outcome: 'completed' }))).toBe(
    'ok',
  );
});
