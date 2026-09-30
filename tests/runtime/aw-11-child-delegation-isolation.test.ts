// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-11 isolation: a child delegation never carries its holder across a
// boundary its parent could not cross. Three real crossings, each with its
// status and a stored canary checked: another business; another client of
// the same business, on a task shared with them; another person, an agent
// under a live delegation of its own.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { asAgent, createTask } from './schedules-harness.ts';
import {
  callCode,
  child,
  childRequest,
  insertRaw,
  mintChild,
  mintedCode,
  noDatabase,
  parentWork,
  readAsHelper,
  useChildWorld,
  w,
} from './aw-11-child-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useChildWorld('aw11i');

const REFUSED = /delegations: /u;

it('AW-11 isolation: another business', async () => {
  const canary = `aw11-alpha-canary-${randomUUID()}`;
  const alpha = await parentWork(w.s, canary);
  const alphaChild = await child(w.s, alpha.parent, w.helper);
  const bravo = await parentWork(w.bravo);
  const bravoChild = await child(w.bravo, bravo.parent, w.bravoHelper);

  // Alpha's parent, handed to a mint in bravo's transaction: the re-read under
  // the lock finds no such delegation there.
  expect(mintedCode(await mintChild(w.bravo, alpha.parent, childRequest(w.bravoHelper)))).toBe(
    'DELEGATION_NOT_LIVE',
  );
  // Bravo's role cannot name alpha's parent.
  expect(await insertRaw(w.bravo, alpha.parent.id, w.bravoHelper)).not.toBe('inserted');
  // Alpha's child credential presented in bravo, and bravo's child reaching
  // for alpha's task: nothing, and nothing of alpha in either body.
  const crossed = await readAsHelper(
    w.bravo,
    w.bravoHelper,
    alphaChild.credential,
    alpha.work.taskId,
  );
  expect(callCode(crossed)).toBe('DELEGATION_NOT_LIVE');
  const reached = await readAsHelper(
    w.bravo,
    w.bravoHelper,
    bravoChild.credential,
    alpha.work.taskId,
  );
  expect(callCode(reached)).toBe('DELEGATION_OUT_OF_PURPOSE');
  for (const body of [crossed, reached]) {
    expect(JSON.stringify(body)).not.toContain(canary);
    expect(JSON.stringify(body)).not.toContain(alpha.work.taskId);
  }
  // Controls: each child reads its own task.
  expect(
    callCode(await readAsHelper(w.s, w.helper, alphaChild.credential, alpha.work.taskId)),
  ).toBe('applied');
  expect(
    callCode(await readAsHelper(w.bravo, w.bravoHelper, bravoChild.credential, bravo.work.taskId)),
  ).toBe('applied');
});

it('AW-11 isolation: another client in the same business', async () => {
  const canary = `aw11-client-two-canary-${randomUUID()}`;
  const one = await parentWork(w.s);
  const oneChild = await child(w.s, one.parent, w.helper);
  const twoTask = await createTask(w.s, canary);
  await w.s.db.app.withBusiness(w.s.business, async (tx) => {
    await grantTo(tx, w.s.decider, 'share');
  });
  const clientTwo = await cq8World(w.s).client(w.s.business, w.s.decider, 'aw11-two', twoTask);

  // The child, reaching for the other client's task, is outside its purpose,
  // and the refusal names nothing of that task.
  const reached = await readAsHelper(w.s, w.helper, oneChild.credential, twoTask);
  expect(callCode(reached)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(JSON.stringify(reached)).not.toContain(canary);
  expect(JSON.stringify(reached)).not.toContain(twoTask);
  // A child scoped to the other client's task cannot be written at the role.
  expect(await insertRaw(w.s, one.parent.id, w.helper, { purpose_scope_id: twoTask })).toMatch(
    REFUSED,
  );
  // The other client reads their own task, never the child's.
  const read = async (recordId: string) =>
    await executeRead(w.s.db.app, w.s.business, clientTwo.presented, {
      read: 'task.read',
      recordId,
    } as never);
  expect(await read(twoTask)).toHaveProperty('sharedTask');
  const crossed = await read(one.work.taskId);
  expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
  expect(JSON.stringify(crossed)).not.toContain(oneChild.delegation.id);
});

it('AW-11 isolation: another person, an agent under a live delegation of its own', async () => {
  const canary = `aw11-person-canary-${randomUUID()}`;
  const mine = await parentWork(w.s, canary);
  const mineChild = await child(w.s, mine.parent, w.helper);
  const other = await parentWork(w.s);

  // The parent's agent holds a live delegation of its own; the child's
  // credential is bound to the helper, not to it, and the helper cannot
  // borrow the parent's.
  const borrowed = await asAgent(
    w.s,
    { command: 'task.read', operationId: randomUUID(), recordId: mine.work.taskId },
    mineChild.credential,
  );
  expect(callCode(borrowed)).toBe('DELEGATION_NOT_LIVE');
  expect(callCode(await readAsHelper(w.s, w.helper, mine.credential, mine.work.taskId))).toBe(
    'DELEGATION_NOT_LIVE',
  );
  // A child of the other work reaches only the other work's task.
  const otherChild = await child(w.s, other.parent, w.helper);
  const reached = await readAsHelper(w.s, w.helper, otherChild.credential, mine.work.taskId);
  expect(callCode(reached)).toBe('DELEGATION_OUT_OF_PURPOSE');
  expect(JSON.stringify(reached)).not.toContain(canary);
  // A child drawing on another person's authority is refused at the role.
  const [otherPerson] = await w.s.db.app.withBusiness(
    w.s.business,
    async (tx) =>
      await tx.query<{ readonly id: string }>(
        `insert into public.people (business_id, id, display_name) values ($1, $2, 'Other')
         returning id`,
        [w.s.business, randomUUID()],
      ),
  );
  expect(
    await insertRaw(w.s, mine.parent.id, w.helper, { delegate_person_id: otherPerson?.id }),
  ).toMatch(REFUSED);
  // Controls.
  expect(callCode(await readAsHelper(w.s, w.helper, mineChild.credential, mine.work.taskId))).toBe(
    'applied',
  );
});
