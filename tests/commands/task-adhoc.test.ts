// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-10a: the Ad hoc mark (CS-4.9).
//
// A task marked ad hoc drives billing and is the default for its new time
// entries. The mark is a task field owned by `task.set_adhoc` under
// `task:write`, audited as `task.adhoc changed`, reached by an agent only
// inside its delegation. The default a new time entry takes is read through
// `adHocDefault`, the one value the timer reads (owner question 36's
// recommendation: this part proves the default, MP-4-6 proves the entry).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from './fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import {
  CANARY,
  alpha,
  as,
  bravo,
  bravoWriter,
  clientAWriter,
  db,
  defaultOf,
  fresh,
  outcomeOf,
  reader,
  row,
  serverUrl,
  setAdHoc,
  setUp,
  tearDown,
  writer,
} from './adhoc-world.ts';

if (serverUrl === undefined) {
  console.warn('task-adhoc: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-10 CS-4.9 ad hoc', () => {
  it('is declared as a task write an agent reaches only inside its delegation', () => {
    const declared = COMMAND_SURFACE.find((each) => String(each.name) === 'task.set_adhoc');
    expect([
      declared?.kind,
      declared?.collection,
      declared?.action,
      declared?.authorisedOn,
      declared?.agent,
    ]).toStrictEqual(['write', 'task', 'write', 'record', 'delegated']);
  });

  it('marks the task ad hoc and back, each in its own slot, and the read shows it', async () => {
    const task = await fresh(alpha, writer, 'ad hoc work');
    expect(outcomeOf(await setAdHoc(alpha, writer, task, true))).toStrictEqual({ applied: true });
    expect((await row(task.recordId))?.ad_hoc).toBe(true);
    const read = await executeRead(db.app, alpha, writer.presented, {
      read: 'task.read',
      recordId: task.recordId,
    });
    expect(isCommandRefusal(read) || !('task' in read) ? null : read.task.adHoc).toBe(true);
    const off = await setAdHoc(alpha, writer, { ...task, revision: task.revision + 1 }, false);
    expect(outcomeOf(off)).toStrictEqual({ applied: true });
    expect((await row(task.recordId))?.ad_hoc).toBe(false);
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
    ['an object', { on: true }],
  ])('refuses %s as the mark and writes nothing', async (_label, value) => {
    const task = await fresh(alpha, writer, 'hostile');
    const answer = await setAdHoc(alpha, writer, task, value);
    expect(outcomeOf(answer)).toMatchObject({ code: 'FIELD_VALUE_INVALID' });
    expect(Number((await row(task.recordId))?.revision)).toBe(task.revision);
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 CS-4.9 ad hoc', () => {
  it('owns the mark: task.update is refused and names the owning command', async () => {
    const task = await fresh(alpha, writer, 'generic');
    const answer = await as(alpha, writer, {
      command: 'task.update',
      recordId: task.recordId,
      expectedRevision: task.revision,
      fields: { ad_hoc: true },
    });
    expect(outcomeOf(answer)).toStrictEqual({
      code: 'TRANSITION_PROTECTED',
      names: ['ad_hoc=task.set_adhoc'],
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 CS-4.9 ad hoc', () => {
  describe('MP-4-10 audited changes: task.adhoc changed', () => {
    it('writes the change and the refusal to the audit chain as task.set_adhoc', async () => {
      const task = await fresh(alpha, writer, 'audited');
      const [applied, refusal] = [randomUUID(), randomUUID()];
      await setAdHoc(alpha, writer, task, true, applied);
      await setAdHoc(alpha, reader, { ...task, revision: task.revision + 1 }, false, refusal);
      const events = await db.admin.execute<{
        readonly actor_id: string;
        readonly outcome: string;
        readonly refusal_code: string | null;
        readonly subject_record_id: string | null;
      }>(
        `select actor_id, outcome, refusal_code, subject_record_id from public.audit_events
          where business_id = $1 and command = 'task.set_adhoc' and operation_id = any($2::text[])
          order by seq`,
        [alpha, [applied, refusal]],
      );
      // `toEqual`: the driver's rows are not plain objects.
      expect(events).toEqual([
        {
          actor_id: writer.actorId,
          outcome: 'applied',
          refusal_code: null,
          subject_record_id: task.recordId,
        },
        {
          actor_id: reader.actorId,
          outcome: 'refused',
          refusal_code: 'SCOPE_NOT_GRANTED',
          // A refusal before authority names no record, as every refused write does.
          subject_record_id: null,
        },
      ]);
      // The change and its record committed together: the mark is what the audit says.
      expect((await row(task.recordId))?.ad_hoc).toBe(true);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 CS-4.9 ad hoc', () => {
  describe('MP-4-10 ad hoc time default', () => {
    it('a new time entry on an ad hoc task defaults to ad hoc; otherwise it does not', async () => {
      const task = await fresh(alpha, writer, 'timed');
      expect(await defaultOf(alpha, task.recordId)).toBe(false);
      await setAdHoc(alpha, writer, task, true);
      expect(await defaultOf(alpha, task.recordId)).toBe(true);
      await setAdHoc(alpha, writer, { ...task, revision: task.revision + 1 }, false);
      expect(await defaultOf(alpha, task.recordId)).toBe(false);
    });

    it('never reads another business’s task: its mark is not this business’s default', async () => {
      const foreign = await fresh(bravo, bravoWriter, CANARY);
      await setAdHoc(bravo, bravoWriter, foreign, true);
      expect(await defaultOf(alpha, foreign.recordId)).toBe(false);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 CS-4.9 ad hoc', () => {
  describe('MP-4-10 permission refusals: task:write', () => {
    it('refuses a caller without task:write and writes nothing', async () => {
      const task = await fresh(alpha, writer, 'read only');
      const answer = await setAdHoc(alpha, reader, task, true);
      expect(outcomeOf(answer)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect((await row(task.recordId))?.ad_hoc).toBeNull();
      expect(JSON.stringify(answer)).not.toContain(task.recordId);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 CS-4.9 ad hoc', () => {
  describe('MP-4-10 isolation: ad hoc', () => {
    it('another business: its task is not found and keeps its mark', async () => {
      const foreign = await fresh(bravo, bravoWriter, CANARY);
      const answer = await setAdHoc(alpha, writer, foreign, true);
      expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect((await row(foreign.recordId))?.ad_hoc).toBeNull();
    });

    it('another client in the same business: a writer on client A’s task cannot mark client B’s', async () => {
      const taskA = await fresh(alpha, writer, 'client A');
      const taskB = await fresh(alpha, writer, CANARY);
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, clientAWriter, 'write', { kind: 'record', id: taskA.recordId });
      });
      expect(outcomeOf(await setAdHoc(alpha, clientAWriter, taskA, true))).toStrictEqual({
        applied: true,
      });
      const refused = await setAdHoc(alpha, clientAWriter, taskB, true);
      expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      expect((await row(taskB.recordId))?.ad_hoc).toBeNull();
    });
  });
});
