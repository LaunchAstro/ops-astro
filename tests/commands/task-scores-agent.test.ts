// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9 marks command for an agent: cases kept beside task-scores.test.ts,
// each file under the line limit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { codeOf } from './agent-fixture.ts';
import { revisionOf, serverUrl, setUp, tearDown, world } from './scores-agent-world.ts';

if (serverUrl === undefined) {
  console.warn('task-scores: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command for an agent', () => {
  it('sets the marks on its own picked-up task, inside its delegation', async () => {
    const decider = await world.decider('scores-decider');
    const picked = await world.pickUp(decider, 'an agent marks this');
    const revision = await revisionOf(picked.taskId);

    const stale = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: revision - 1,
        fields: { impact: 4 },
      },
      picked.credential,
    );
    expect(codeOf(stale)).toBe('VERSION_STALE');

    const outside = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: revision,
        fields: { impact: 0 },
      },
      picked.credential,
    );
    expect(codeOf(outside)).toBe('FIELD_VALUE_INVALID');

    const applied = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: revision,
        fields: { impact: 4, confidence: 5, ease: 6 },
      },
      picked.credential,
    );
    expect(codeOf(applied)).toBe('not-a-refusal');
    expect(await revisionOf(picked.taskId)).toBe(revision + 1);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command for an agent', () => {
  it('MP-4-9a isolation: person to person, under a live delegation', async () => {
    const ada = await world.decider('scores-ada');
    const bo = await world.decider('scores-bo');
    const picked = await world.pickUp(ada, 'ada delegated this task');
    const canary = `bo-${randomUUID()}`;
    const bos = await world.asPerson(bo, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: canary },
    });
    if (isCommandRefusal(bos)) throw new Error(`create refused ${bos.code}`);
    const before = await revisionOf(bos.recordId ?? '');

    const answer = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: bos.recordId,
        expectedRevision: before,
        fields: { impact: 4 },
      },
      picked.credential,
    );
    expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(JSON.stringify(answer)).not.toContain(canary);
    expect(await revisionOf(bos.recordId ?? '')).toBe(before);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command for an agent', () => {
  it('cannot reach a task outside its delegation', async () => {
    const decider = await world.decider('scores-other');
    const picked = await world.pickUp(decider, 'the delegated task');
    const other = await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'not the agent task' },
    });
    if (isCommandRefusal(other)) throw new Error(`create refused ${other.code}`);
    const answer = await world.asAgent(
      {
        command: 'task.set_scores',
        operationId: randomUUID(),
        recordId: other.recordId,
        expectedRevision: 1,
        fields: { impact: 4 },
      },
      picked.credential,
    );
    expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(await revisionOf(other.recordId ?? '')).toBe(1);
  });
});
