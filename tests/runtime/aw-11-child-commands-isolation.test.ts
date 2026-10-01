// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 command isolation: `run.delegate_child` and `run.child_handback`,
// through the production agent entry, never cross a boundary. Three real
// crossings, each with its status and a stored canary checked: another
// business; another client of the same business, on a task shared with them;
// another person, a second helper under a live child of its own.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { appliedDetail, codeOf as callOf } from './schedules-harness.ts';
import { insertHelper, noDatabase, parentWork, useChildWorld, w } from './aw-11-child-world.ts';
import { resultsOf } from './aw-11-child-work-world.ts';
import {
  delegateBody,
  delegateCall,
  handbackBody,
  handbackCall,
} from './aw-11-child-commands-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11ci');

it('AW-11 command isolation: another business', async () => {
  const canary = `aw11c-alpha-canary-${randomUUID()}`;
  const alpha = await parentWork(w.s, canary);
  const handed = appliedDetail(
    await delegateCall(w.s, alpha.credential, delegateBody(alpha.work, w.helper)),
    'alpha hand-over',
  );
  const alphaChild = String(handed['credential']);
  const bravo = await parentWork(w.bravo);

  // Alpha's parent credential carried into bravo: no such delegation there.
  const carried = await delegateCall(
    w.bravo,
    alpha.credential,
    delegateBody(alpha.work, w.bravoHelper),
  );
  expect(callOf(carried)).toBe('DELEGATION_NOT_LIVE');
  // Bravo's own parent naming alpha's lease: no such lease in bravo.
  const crossed = await delegateCall(
    w.bravo,
    bravo.credential,
    delegateBody(alpha.work, w.bravoHelper),
  );
  expect(callOf(crossed)).toBe('LEASE_NOT_OWNED');
  // Alpha's child credential handed back in bravo by bravo's helper.
  const back = await handbackCall(w.bravo, w.bravoHelper, alphaChild, handbackBody());
  expect(callOf(back)).toBe('DELEGATION_NOT_LIVE');
  // Answered as a made-up credential is, byte for byte.
  const madeUp = await handbackCall(w.bravo, w.bravoHelper, randomUUID(), handbackBody());
  expect(JSON.stringify(back)).toBe(JSON.stringify(madeUp));
  for (const body of [carried, crossed, back]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(alpha.work.taskId);
    expect(text).not.toContain(String(handed['childDelegationId']));
  }
  // Controls: alpha's helper still works; bravo hands over on its own lease.
  expect(await resultsOf(w.s, alpha.parent)).toMatchObject([{ state: 'working' }]);
  expect(await resultsOf(w.bravo, alpha.parent)).toEqual([]);
  expect(
    callOf(await delegateCall(w.bravo, bravo.credential, delegateBody(bravo.work, w.bravoHelper))),
  ).toBe('applied');
});

it('AW-11 command isolation: another client in the same business', async () => {
  const canary = `aw11c-client-two-canary-${randomUUID()}`;
  const one = await parentWork(w.s);
  const two = await parentWork(w.s, canary);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, w.s.decider, 'share');
  });
  const clientTwo = await cq8World(w.s).client(
    w.s.business,
    w.s.decider,
    'aw11c-two',
    two.work.taskId,
  );

  // Task one's parent naming the lease on the other client's task.
  const reached = await delegateCall(w.s, one.credential, delegateBody(two.work, w.helper));
  expect(callOf(reached)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(JSON.stringify(reached)).not.toContain(canary);
  expect(JSON.stringify(reached)).not.toContain(two.work.taskId);
  expect(await resultsOf(w.s, two.parent)).toEqual([]);
  // Task one's own hand-over and handback, then the other client reads.
  const handed = appliedDetail(
    await delegateCall(w.s, one.credential, delegateBody(one.work, w.helper)),
    'task one hand-over',
  );
  expect(
    callOf(await handbackCall(w.s, w.helper, String(handed['credential']), handbackBody())),
  ).toBe('applied');
  const read = async (recordId: string) =>
    await executeRead(w.s.db.app, w.s.business, clientTwo.presented, {
      read: 'task.read',
      recordId,
    } as never);
  expect(await read(two.work.taskId)).toHaveProperty('sharedTask');
  const crossed = await read(one.work.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  expect(JSON.stringify(crossed)).not.toContain(String(handed['childDelegationId']));
  expect(JSON.stringify(crossed)).not.toContain(w.helper.actorId);
});

it('AW-11 command isolation: another person, a second helper under a live child of its own', async () => {
  const canary = `aw11c-person-canary-${randomUUID()}`;
  const mine = await parentWork(w.s, canary);
  const handed = appliedDetail(
    await delegateCall(w.s, mine.credential, delegateBody(mine.work, w.helper)),
    'my hand-over',
  );
  const myChild = String(handed['credential']);
  const second = await insertHelper(w.s);
  const theirs = await parentWork(w.s);
  const theirHanded = appliedDetail(
    await delegateCall(w.s, theirs.credential, delegateBody(theirs.work, second)),
    'their hand-over',
  );
  const theirChild = String(theirHanded['credential']);

  // Each child credential is bound to its own helper.
  const borrowed = await handbackCall(w.s, second, myChild, handbackBody());
  const lent = await handbackCall(w.s, w.helper, theirChild, handbackBody());
  expect(callOf(borrowed)).toBe('DELEGATION_NOT_LIVE');
  expect(callOf(lent)).toBe('DELEGATION_NOT_LIVE');
  // The other parent, under its own live delegation, cannot hand my work over.
  const taken = await delegateCall(w.s, theirs.credential, delegateBody(mine.work, second));
  expect(callOf(taken)).toBe('DELEGATION_OUT_OF_PURPOSE');
  // A helper cannot hand over further with its child credential: depth one.
  const deeper = await handbackCall(w.s, second, theirChild, delegateBody(theirs.work, w.helper));
  expect(callOf(deeper)).not.toBe('applied');
  for (const body of [borrowed, lent, taken, deeper]) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(String(handed['childDelegationId']));
    expect(text).not.toContain(mine.work.taskId);
    expect(text).not.toContain(myChild);
  }
  // Controls: each helper hands back its own.
  expect(callOf(await handbackCall(w.s, w.helper, myChild, handbackBody()))).toBe('applied');
  expect(callOf(await handbackCall(w.s, second, theirChild, handbackBody()))).toBe('applied');
  expect(await resultsOf(w.s, theirs.parent)).toMatchObject([
    { helperActorId: second.actorId, state: 'handed_back' },
  ]);
});
