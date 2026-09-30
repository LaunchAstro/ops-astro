// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent tick (MP-4-15, BOARDS P-30): `task.complete` is the one completion
// transition, and a task an agent holds goes to review first. Ticked while it
// is anywhere but the unstarted state (Needs review, where a person confirms
// the agent's work), it moves there: no completion stamp, no step archived.
// Ticked in review, it completes. The board tick, the status select and the
// Projects panel's tick all send `task.complete`, so all three agree.
//
// Whoever ticks, the answer names only the state: another person's agent is
// never named, and the tick does not let them skip that person's review.
// Three real crossings, statuses checked: another business, another client in
// the same business, another person.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { codeOf, detailOf, type Decider } from './agent-fixture.ts';
import { enrol, grantTo, installSpine } from './fixture.ts';
import {
  CANARY,
  aiWorld,
  assign,
  created,
  minted,
  onClient,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('task-complete-agent: DATABASE_URL is unset.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('aitick');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

const lifecycle = async (
  by: Decider,
  command: 'task.start' | 'task.complete',
  taskId: string,
  expectedRevision?: number,
): Promise<CommandResult> =>
  await w.world.asPerson(by, {
    command,
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: expectedRevision ?? (await revisionOf(w, taskId)),
  });

/** The task's state key and completion stamp, as stored. */
const stored = async (
  taskId: string,
): Promise<{ readonly key: string | null; readonly completedAt: string | null } | undefined> =>
  (
    await w.world.db.admin.execute<{
      readonly key: string | null;
      readonly completedAt: string | null;
    }>(
      `select s.txt_1 as key, r.ts_2::text as "completedAt"
         from public.records r
         left join public.records s on s.business_id = r.business_id and s.id = r.uuid_1
        where r.id = $1`,
      [taskId],
    )
  )[0];

/** A started task of `by`'s, held by `by`'s own agent. */
const agentTask = async (by: Decider, title: string): Promise<{ task: string; agent: string }> => {
  const task = await created(w, by, title);
  expect(codeOf(await lifecycle(by, 'task.start', task))).toBe('not-a-refusal');
  const agent = await minted(w, by, task);
  expect(codeOf(await assign(w, by, task, { agent }))).toBe('not-a-refusal');
  return { task, agent };
};

describe.skipIf(serverUrl === undefined)('the agent tick (MP-4-15)', () => {
  it('an agent’s task, ticked, goes to Needs review first; ticked again, it completes', async () => {
    const { task } = await agentTask(w.p, 'agent work');
    const first = await lifecycle(w.p, 'task.complete', task);
    expect(codeOf(first)).toBe('not-a-refusal');
    expect(detailOf(first)).toMatchObject({ state: 'needs_review', completedAt: null });
    expect(await stored(task)).toStrictEqual({ key: 'needs_review', completedAt: null });

    const second = await lifecycle(w.p, 'task.complete', task);
    expect(detailOf(second)).toMatchObject({ state: 'complete' });
    expect((await stored(task))?.key).toBe('complete');
    expect((await stored(task))?.completedAt).not.toBeNull();
  });

  it('a person’s task, ticked, completes at once', async () => {
    const task = await created(w, w.p, 'person work');
    expect(codeOf(await lifecycle(w.p, 'task.start', task))).toBe('not-a-refusal');
    expect(codeOf(await assign(w, w.p, task, { assignee: w.p.personId }))).toBe('not-a-refusal');
    expect(detailOf(await lifecycle(w.p, 'task.complete', task))).toMatchObject({
      state: 'complete',
    });
  });

  it('two ticks at one revision: one sends it to review, the other is stale, and it is not completed', async () => {
    const { task } = await agentTask(w.p, 'two ticks');
    const at = await revisionOf(w, task);
    const answers = await Promise.all([
      lifecycle(w.p, 'task.complete', task, at),
      lifecycle(w.q, 'task.complete', task, at),
    ]);
    expect(answers.map((answer) => codeOf(answer)).toSorted()).toStrictEqual([
      'VERSION_STALE',
      'not-a-refusal',
    ]);
    expect(await stored(task)).toStrictEqual({ key: 'needs_review', completedAt: null });
  });
});

describe.skipIf(serverUrl === undefined)('the agent tick: three crossings', () => {
  it('person to person: P’s tick on Q’s agent task goes to Q’s review and names nothing of Q’s agent', async () => {
    const { task, agent } = await agentTask(w.q, `Q's ${CANARY}`);
    const answer = await lifecycle(w.p, 'task.complete', task);
    expect(codeOf(answer)).toBe('not-a-refusal');
    expect(await stored(task)).toStrictEqual({ key: 'needs_review', completedAt: null });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(agent);
    expect(text).not.toContain(w.q.personId);
    expect(text).not.toContain(CANARY);
  });

  it('client to client: a writer held to client X’s task is refused client Y’s agent task, unchanged', async () => {
    const { task: y } = await agentTask(w.p, `Client Y ${CANARY}`);
    const x = await created(w, w.p, 'Client X');
    await onClient(w, x, randomUUID());
    await onClient(w, y, randomUUID());
    const held = await enrol(w.world.db.app, w.world.business, `x-${randomUUID().slice(0, 6)}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, held, 'read', { kind: 'record', id: x });
      await grantTo(tx, held, 'write', { kind: 'record', id: x });
    });
    const answer = await w.world.asPerson(held, {
      command: 'task.complete',
      operationId: randomUUID(),
      recordId: y,
      expectedRevision: await revisionOf(w, y),
    });
    expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(await stored(y)).toStrictEqual({ key: 'active', completedAt: null });
  });

  it('business to business: a person of business B holding every task grant there is not found A’s agent task, unchanged', async () => {
    const { task } = await agentTask(w.p, `Home ${CANARY}`);
    const bravo = await insertBusiness(w.world.db.app, `tick-b-${randomUUID().slice(0, 8)}`);
    await installSpine(w.world.db.app, bravo);
    const there = await enrol(w.world.db.app, bravo, 'there');
    await w.world.db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'assign'] as const) {
        // eslint-disable-next-line no-await-in-loop -- three grants
        await grantTo(tx, there, action);
      }
    });
    const answer = await executeCommand(w.world.db.app, bravo, there.presented, 'api', {
      command: 'task.complete',
      operationId: randomUUID(),
      recordId: task,
      expectedRevision: await revisionOf(w, task),
    } as never);
    expect(codeOf(answer)).toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain(CANARY);
    expect(await stored(task)).toStrictEqual({ key: 'active', completedAt: null });
  });
});
