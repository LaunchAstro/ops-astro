// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04 isolation on the accept command: `task.accept_plan` across the three
// crossings. Another business's gate, a same-business task outside a client's
// own grant, and another person (their agent under a live delegation, and
// the person naming a conversation that is not theirs): each is refused with
// its status, binds and pins nothing, and never carries the crossed task's
// canary title or ids out in its body.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { fingerprint } from './aw-02-world.ts';
import {
  acceptBody,
  conversationOf,
  gateOf,
  noDatabase,
  pinsOf,
  planRecordsOf,
  proposed,
  useAw04World,
  useInstructionRoot,
  w,
  type Proposed,
} from './aw-04-world.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  liveWork,
  propose,
} from './schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useAw04World('aw04_cmd_iso');
useInstructionRoot();

const canary = (): string => `aw04-canary-${randomUUID()}`;

function carriesNothing(result: unknown, title: string, plan: Proposed): void {
  const body = JSON.stringify(result);
  for (const foreign of [
    title,
    plan.taskId,
    String(plan.proposal['runId']),
    String(plan.proposal['gateId']),
  ]) {
    expect(body).not.toContain(foreign);
  }
}

async function untouched(plan: Proposed): Promise<void> {
  expect(await gateOf(w.alpha, plan.proposal['gateId'])).toEqual({
    state: 'pending',
    decisions: '0',
  });
  expect(await pinsOf(w.alpha, plan.proposal['runId'])).toEqual([]);
  expect(await planRecordsOf(w.alpha, plan.proposal['gateId'])).toEqual([]);
}

it("AW-04 isolation: another business's decider naming this gate on the command is NOT_FOUND and binds nothing", async () => {
  const title = canary();
  const plan = await proposed(w.alpha, title);
  const before = await fingerprint(w.alpha);
  const crossed = await asPerson(w.bravo, acceptBody(plan));
  expect(codeOf(crossed)).toBe('NOT_FOUND');
  carriesNothing(crossed, title, plan);
  expect(await fingerprint(w.alpha)).toBe(before);
  await untouched(plan);
  // Control: alpha's own decider accepts it.
  appliedDetail(await asPerson(w.alpha, acceptBody(plan)), 'task.accept_plan');
});

it("AW-04 isolation: another client in the same business accepts on its own task only, never the other client's", async () => {
  const ownTask = await createTask(w.alpha, 'aw04 cmd client X task');
  const title = canary();
  const other = await proposed(w.alpha, title);
  const client = await enrol(w.alpha.db.app, w.alpha.business, `aw04-cmd-client-${randomUUID()}`);
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    for (const action of ['read', 'decide'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, client, action, { kind: 'record', id: ownTask });
    }
  });
  const asClient = async (body: Readonly<Record<string, unknown>>) =>
    await executeCommand(w.alpha.db.app, w.alpha.business, client.presented, 'api', body as never);
  const crossed = await asClient(acceptBody(other));
  expect(codeOf(crossed)).toBe('SCOPE_NOT_GRANTED');
  carriesNothing(crossed, title, other);
  await untouched(other);
  // Control: the client accepts the plan on its own task.
  const own = {
    taskId: ownTask,
    proposal: await propose(w.alpha, ownTask, { maximumMinor: 1_000, purpose: freshPurpose() }),
  };
  appliedDetail(await asClient(acceptBody(own)), 'task.accept_plan');
  expect(await planRecordsOf(w.alpha, own.proposal['gateId'])).toHaveLength(1);
});

it('AW-04 isolation: another person, by their live delegation or with a conversation not their own, cannot accept this plan', async () => {
  const title = canary();
  const plan = await proposed(w.alpha, title);
  // The decider's agent holds a live delegation on other work; it never reaches the accept.
  const work = await liveWork(w.alpha, 'aw04 cmd delegated work', 1_000);
  const byDelegation = await asAgent(w.alpha, acceptBody(plan), String(work.picked['credential']));
  expect(codeOf(byDelegation)).toBe('DELEGATION_EXCLUDES_OPERATION');
  carriesNothing(byDelegation, title, plan);
  // Another person with every grant names the decider's conversation as the origin.
  const other = await enrol(w.alpha.db.app, w.alpha.business, `aw04-cmd-other-${randomUUID()}`);
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    for (const action of ['read', 'write', 'decide'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, other, action);
    }
  });
  const theirs = await conversationOf(w.alpha, w.alpha.decider);
  const crossed = await executeCommand(
    w.alpha.db.app,
    w.alpha.business,
    other.presented,
    'api',
    acceptBody(plan, { conversationId: theirs }) as never,
  );
  expect(codeOf(crossed)).toBe('NOT_FOUND');
  carriesNothing(crossed, title, plan);
  expect(JSON.stringify(crossed)).not.toContain(theirs);
  await untouched(plan);
  // Control: the conversation's owner accepts with it.
  appliedDetail(
    await asPerson(w.alpha, acceptBody(plan, { conversationId: theirs })),
    'task.accept_plan',
  );
});
