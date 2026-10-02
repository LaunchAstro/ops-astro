// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-9 marks command, its writes refused and audited: cases kept beside
// task-scores.test.ts, each file under the line limit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  as,
  business,
  db,
  freshTask,
  outcomeOf,
  reader,
  serverUrl,
  setUp,
  taskRow,
  tearDown,
  writer,
} from './scores-world.ts';

if (serverUrl === undefined) {
  console.warn('task-scores: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it.each([
    ['a numeric string', { impact: '7' }, ['impact=numeric']],
    ['a boolean', { confidence: true }, ['confidence=numeric']],
    ['an array', { ease: [7] }, ['ease=numeric']],
    ['an object', { impact: { value: 7 } }, ['impact=numeric']],
    ['negative zero', { ease: -0 }, ['ease']],
    ['just over the top', { confidence: 10.000001 }, ['confidence']],
  ])('refuses %s as a mark and writes nothing', async (_label, fields, names) => {
    const task = await freshTask('hostile');
    const answer = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields,
    });
    expect(outcomeOf(answer)).toStrictEqual({ code: 'FIELD_VALUE_INVALID', names });
    expect(Number((await taskRow(task.recordId))?.revision)).toBe(task.revision);
  });

  it('lets one of two writes at the same revision apply, and refuses the other stale', async () => {
    const task = await freshTask('two at once');
    const [first, second] = await Promise.all(
      [3, 9].map(
        async (impact) =>
          await as(writer, {
            command: 'task.set_scores',
            recordId: task.recordId,
            expectedRevision: task.revision,
            fields: { impact },
          }),
      ),
    );
    const outcomes = [first, second].map((answer) =>
      answer === undefined || isCommandRefusal(answer) ? answer?.code : 'applied',
    );
    expect(outcomes.toSorted()).toStrictEqual(['VERSION_STALE', 'applied']);
    const row = await taskRow(task.recordId);
    expect(row?.revision).toBe(String(task.revision + 1));
    expect(['3', '9']).toContain(row?.impact);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('clears a mark with null, so a mark can go back to absent and never to 0', async () => {
    const task = await freshTask('cleared');
    const set = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { impact: 5, confidence: 7 },
    });
    expect(outcomeOf(set)).toStrictEqual({ applied: true });
    const cleared = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision + 1,
      fields: { impact: null },
    });
    expect(outcomeOf(cleared)).toStrictEqual({ applied: true });
    const row = await taskRow(task.recordId);
    expect([row?.impact, row?.confidence, row?.ease]).toStrictEqual([null, '7', null]);
  });

  it('refuses a caller without task:write and writes nothing', async () => {
    const task = await freshTask('read only');
    const answer = await as(reader, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { impact: 3 },
    });
    expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect((await taskRow(task.recordId))?.impact).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('owns the marks: task.update is refused and names the owning command', async () => {
    const task = await freshTask('generic');
    const answer = await as(writer, {
      command: 'task.update',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { ease: 4 },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['ease=task.set_scores'],
    });
  });

  it('refuses a field it does not own, so a mark change cannot carry another', async () => {
    const task = await freshTask('stray');
    const answer = await as(writer, {
      command: 'task.set_scores',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { impact: 4, title: 'renamed' },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['title=task.update'],
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-9 marks command', () => {
  it('audits the change and the refusal as task.set_scores', async () => {
    const task = await freshTask('audited');
    const [applied, refusal] = [randomUUID(), randomUUID()];
    await as(writer, {
      command: 'task.set_scores',
      operationId: applied,
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { ease: 6 },
    });
    await as(reader, {
      command: 'task.set_scores',
      operationId: refusal,
      recordId: task.recordId,
      expectedRevision: task.revision + 1,
      fields: { ease: 2 },
    });
    const events = await db.admin.execute<{
      readonly actor_id: string;
      readonly outcome: string;
      readonly refusal_code: string | null;
    }>(
      `select actor_id, outcome, refusal_code from public.audit_events
        where business_id = $1 and command = 'task.set_scores' and operation_id = any($2::text[])
        order by seq`,
      [business, [applied, refusal]],
    );
    // `toEqual`: the driver's rows are not plain objects.
    expect(events).toEqual([
      { actor_id: writer.actorId, outcome: 'applied', refusal_code: null },
      { actor_id: reader.actorId, outcome: 'refused', refusal_code: 'SCOPE_NOT_GRANTED' },
    ]);
  });
});
