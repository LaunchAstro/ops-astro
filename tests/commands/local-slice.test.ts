// SPDX-License-Identifier: AGPL-3.0-only
//
// The local working slice, end to end against a real Postgres: one person
// makes a task, works it, and reads it back, and the people who should not see
// it are told so.
//
// Every case here is one the acceptance checklist names, and each asserts the
// **observed refusal code** rather than that something went wrong. A test that
// only checks a call failed passes when it fails for the wrong reason, and the
// wrong reason is usually a tenancy leak wearing a different hat.
//
// The positive half is B1 to B4 at the domain boundary: create without a board,
// assign, start, complete, reopen, update, then read the task, the board and
// the people. It is not B1 to B7 -- those are browser cases and are SLICE-WEB's
// to run through the mounted app. What it does establish is that the operations
// underneath them are real: the same `executeCommand` the HTTP boundary calls,
// against the database that survives a restart.
//
// The negative half is the isolation evidence for what this unit exposes:
// N1 (foreign read, real and fabricated identifier), N2 (member with no
// grant), N3 (generic write to a protected field), N4 (system field spoof),
// N5 (stale revision and replay) and B2's foreign-assignee refusal.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { ReadRequest } from '../../packages/core-records/src/reads/requests.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('local slice: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Command = Parameters<typeof executeCommand>[4];

describe.skipIf(serverUrl === undefined)('the local working slice', () => {
  let db: FreshDatabase;
  let alpha: string;
  let bravo: string;
  /** Business A: grants on task and person. The positive control throughout. */
  let mia: Member;
  /** Business A: another permitted person, so there is someone to assign to. */
  let ada: Member;
  /** Business A: a real member with no grant at all (N2). */
  let noah: Member;
  /** Business B: permitted there, and nowhere near A (N1). */
  let bea: Member;

  const run = async (command: Command, who: Member = mia, business = alpha) =>
    await executeCommand(db.app, business, who.presented, 'api', command);

  const read = async (request: ReadRequest, who: Member = mia, business = alpha) =>
    await executeRead(db.app, business, who.presented, request);

  /**
   * A created task, with its handle narrowed.
   *
   * `CommandHandle` types both `recordId` and `revision` as nullable, because
   * the commands that take a batch rather than a record have neither. A create
   * has both, and narrowing once here is better than every case below carrying
   * the same two assertions about a shape it did not choose.
   */
  const create = async (title: string): Promise<{ recordId: string; revision: number }> => {
    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Command);
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    if (made.recordId === null || made.revision === null) {
      throw new Error('create returned no record identity');
    }
    return { recordId: made.recordId, revision: made.revision };
  };

  const detail = async (recordId: string, who: Member = mia, business = alpha) => {
    const result = await read({ read: 'task.read', recordId }, who, business);
    if ('refused' in result) throw new Error(`read refused ${result.code}`);
    if (!('task' in result)) throw new Error('read returned no task');
    return result.task;
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'slice' });
    alpha = await insertBusiness(db.app, 'alpha');
    bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, alpha);
    await installSpine(db.app, bravo);

    mia = await enrol(db.app, alpha, 'mia');
    ada = await enrol(db.app, alpha, 'ada');
    noah = await enrol(db.app, alpha, 'noah');
    bea = await enrol(db.app, bravo, 'bea');

    await db.app.withBusiness(alpha, async (tx) => {
      for (const action of ['read', 'write', 'assign'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, mia, action);
      }
      await issueGrant(tx, [], {
        subject: { kind: 'person', id: mia.personId },
        scope: { kind: 'business', id: null },
        collection: 'person',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: mia.actorId,
      });
    });
    await db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'assign'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bea, action);
      }
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('B1 to B4: the journey, through executeCommand and the reads', () => {
    it('creates a task without a board, and reads it back by identifier', async () => {
      const title = `first slice ${randomUUID().slice(0, 8)}`;
      const made = await create(title);
      const task = await detail(made.recordId);
      expect(task.id).toBe(made.recordId);
      expect(task.title).toBe(title);
      expect(task.key).not.toBe('');
      expect(task.assignee).toBeNull();
      expect(task.completedAt).toBeNull();
      // Created without a board, so it is on the unboarded list and nowhere else.
      const board = await read({ read: 'task.board', board: null });
      expect('tasks' in board && board.tasks.some((row) => row.id === made.recordId)).toBe(true);
    });

    it('assigns, and the task carries the person and a new revision', async () => {
      const made = await create(`assignable ${randomUUID().slice(0, 8)}`);
      const assigned = await run({
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { assignee: ada.personId },
      } as Command);
      expect(isCommandRefusal(assigned)).toBe(false);
      const task = await detail(made.recordId);
      expect(task.assignee?.personId).toBe(ada.personId);
      expect(task.assignee?.name).toBe('ada');
      expect(task.revision).toBeGreaterThan(made.revision);
    });

    it('starts, completes and reopens, stamping and clearing completed_at', async () => {
      const made = await create(`lifecycle ${randomUUID().slice(0, 8)}`);

      const started = await run({
        command: 'task.start',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: made.revision,
      } as Command);
      expect(isCommandRefusal(started)).toBe(false);
      const afterStart = await detail(made.recordId);
      expect(afterStart.state?.machineCategory).toBe('started');
      expect(afterStart.completedAt).toBeNull();

      const completed = await run({
        command: 'task.complete',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: afterStart.revision,
      } as Command);
      expect(isCommandRefusal(completed)).toBe(false);
      const afterComplete = await detail(made.recordId);
      expect(afterComplete.state?.machineCategory).toBe('completed');
      expect(afterComplete.completedAt).not.toBeNull();

      const reopened = await run({
        command: 'task.reopen',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: afterComplete.revision,
        reason: 'the client came back',
      } as Command);
      expect(isCommandRefusal(reopened)).toBe(false);
      const afterReopen = await detail(made.recordId);
      expect(afterReopen.state?.machineCategory).toBe('unstarted');
      expect(afterReopen.completedAt).toBeNull();

      // B3's last clause: the history names the actor of each transition.
      const operations = afterReopen.history.map((entry) => entry.operation);
      expect(operations).toStrictEqual([
        'task.create',
        'task.start',
        'task.complete',
        'task.reopen',
      ]);
      expect(afterReopen.history.every((entry) => entry.actorId === mia.actorId)).toBe(true);
    });

    it('B4: edits title, description, due and priority through task.update', async () => {
      const made = await create(`editable ${randomUUID().slice(0, 8)}`);
      const due = '2026-12-01T09:00:00.000Z';
      const updated = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { title: 'edited title', description: 'the long text', due, priority: 3 },
      } as Command);
      expect(isCommandRefusal(updated)).toBe(false);
      const task = await detail(made.recordId);
      expect(task.title).toBe('edited title');
      expect(task.description).toBe('the long text');
      expect(task.due).toBe(due);
      expect(task.priority).toBe(3);
    });

    it('lists the people who may be assigned to, and no one from elsewhere', async () => {
      const result = await read({ read: 'person.list' });
      if (!('persons' in result)) throw new Error('person.list returned no persons');
      const names = result.persons.map((person) => person.name).toSorted();
      expect(names).toStrictEqual(['ada', 'mia', 'noah']);
    });
  });

  describe('N1: a foreign business reads nothing, and learns nothing from trying', () => {
    it('answers a real foreign identifier and a fabricated one identically', async () => {
      const made = await create(`private to alpha ${randomUUID().slice(0, 8)}`);

      const real = await read({ read: 'task.read', recordId: made.recordId }, bea, bravo);
      const fabricated = await read({ read: 'task.read', recordId: randomUUID() }, bea, bravo);

      expect('refused' in real && real.code).toBe('NOT_FOUND');
      expect('refused' in fabricated && fabricated.code).toBe('NOT_FOUND');
      // The same body, not merely the same code: names and fixes are where a
      // difference would leak which of the two identifiers was real.
      expect(real).toStrictEqual(fabricated);

      // The positive control: A's permitted person still reads it.
      expect((await detail(made.recordId)).id).toBe(made.recordId);
    });

    it('does not show A a task of B on its board', async () => {
      const mine = await create(`alpha board ${randomUUID().slice(0, 8)}`);
      const theirs = await run(
        {
          command: 'task.create',
          operationId: randomUUID(),
          fields: { title: 'bravo task' },
        } as Command,
        bea,
        bravo,
      );
      if (isCommandRefusal(theirs)) throw new Error(`bravo create refused ${theirs.code}`);
      if (theirs.recordId === null) throw new Error('bravo create returned no identity');
      const board = await read({ read: 'task.board', board: null });
      if (!('tasks' in board)) throw new Error('board returned no tasks');
      const ids = board.tasks.map((row) => row.id);
      expect(ids).toContain(mine.recordId);
      expect(ids).not.toContain(theirs.recordId);
    });
  });

  describe('N2: a member with no grant is denied, not shown an empty list', () => {
    it('refuses the detail read SCOPE_NOT_GRANTED', async () => {
      const made = await create(`ungranted ${randomUUID().slice(0, 8)}`);
      const result = await read({ read: 'task.read', recordId: made.recordId }, noah);
      expect('refused' in result && result.code).toBe('SCOPE_NOT_GRANTED');
    });

    it('refuses the board read SCOPE_NOT_GRANTED rather than returning nothing', async () => {
      const result = await read({ read: 'task.board', board: null }, noah);
      expect('refused' in result && result.code).toBe('SCOPE_NOT_GRANTED');
    });

    it('refuses the person list SCOPE_NOT_GRANTED', async () => {
      const result = await read({ read: 'person.list' }, noah);
      expect('refused' in result && result.code).toBe('SCOPE_NOT_GRANTED');
    });
  });

  describe('B2, N3, N4, N5: what a write may not do', () => {
    it('refuses an assignment to a person of another business, unchanged', async () => {
      const made = await create(`foreign assignee ${randomUUID().slice(0, 8)}`);
      const before = await detail(made.recordId);
      const refusal = await run({
        command: 'task.assign',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { assignee: bea.personId },
      } as Command);
      expect(isCommandRefusal(refusal)).toBe(true);
      const after = await detail(made.recordId);
      expect(after.assignee).toBeNull();
      expect(after.revision).toBe(before.revision);
      // NOT_FOUND, and deliberately not a code that says "wrong business":
      // a person of another business and an identifier that was never real are
      // one answer, because the difference between them is the inference.
      expect(isCommandRefusal(refusal) && refusal.code).toBe('NOT_FOUND');
    });

    it('N3: refuses a generic write to state and to assignee, naming the owner', async () => {
      const made = await create(`protected ${randomUUID().slice(0, 8)}`);
      for (const fields of [{ state: randomUUID() }, { assignee: ada.personId }]) {
        // oxlint-disable-next-line no-await-in-loop
        const refusal = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: made.recordId,
          expectedRevision: made.revision,
          fields,
        } as Command);
        expect(isCommandRefusal(refusal) && refusal.code, JSON.stringify(fields)).toBe(
          'TRANSITION_PROTECTED',
        );
        expect(isCommandRefusal(refusal) && refusal.names.length).toBeGreaterThan(0);
      }
      const after = await detail(made.recordId);
      expect(after.assignee).toBeNull();
      expect(after.revision).toBe(made.revision);
    });

    it('N4: refuses source, key and completed_at in a body', async () => {
      const made = await create(`system fields ${randomUUID().slice(0, 8)}`);
      const attempts: readonly [Record<string, unknown>, string][] = [
        [{ source: 'not-from-here' }, 'source'],
        [{ key: 'TASK-9999' }, 'key'],
        [{ completed_at: new Date().toISOString() }, 'completed_at'],
      ];
      for (const [fields, name] of attempts) {
        // oxlint-disable-next-line no-await-in-loop
        const refusal = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: made.recordId,
          expectedRevision: made.revision,
          fields,
        } as Command);
        expect(isCommandRefusal(refusal), name).toBe(true);
        if (!isCommandRefusal(refusal)) continue;
        expect(['SOURCE_SPOOFED', 'FIELD_NOT_WRITABLE', 'TRANSITION_PROTECTED'], name).toContain(
          refusal.code,
        );
        // The attempted value is not echoed back: it goes to the audit event.
        expect(JSON.stringify(refusal), name).not.toContain('not-from-here');
        expect(JSON.stringify(refusal), name).not.toContain('TASK-9999');
      }
      const after = await detail(made.recordId);
      expect(after.completedAt).toBeNull();
      expect(after.revision).toBe(made.revision);
    });

    it('N5: refuses a stale expectedRevision VERSION_STALE', async () => {
      const made = await create(`stale ${randomUUID().slice(0, 8)}`);
      await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { title: 'the first writer won' },
      } as Command);
      const refusal = await run({
        command: 'task.update',
        operationId: randomUUID(),
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { title: 'the second writer should not merge' },
      } as Command);
      expect(isCommandRefusal(refusal) && refusal.code).toBe('VERSION_STALE');
      expect((await detail(made.recordId)).title).toBe('the first writer won');
    });

    it('N5: replaying one operation_id returns the original and writes nothing new', async () => {
      const made = await create(`replayed ${randomUUID().slice(0, 8)}`);
      const operationId = randomUUID();
      const command = {
        command: 'task.update',
        operationId,
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { title: 'written once' },
      } as Command;

      const first = await run(command);
      const second = await run(command);
      expect(second).toStrictEqual(first);

      const task = await detail(made.recordId);
      expect(task.title).toBe('written once');
      // One applied event for the update, not two.
      expect(task.history.filter((entry) => entry.operation === 'task.update').length).toBe(1);
    });

    it('N5: the same identity with a different payload is OPERATION_ID_REUSED', async () => {
      const made = await create(`reused ${randomUUID().slice(0, 8)}`);
      const operationId = randomUUID();
      await run({
        command: 'task.update',
        operationId,
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { title: 'the first payload' },
      } as Command);
      const refusal = await run({
        command: 'task.update',
        operationId,
        recordId: made.recordId,
        expectedRevision: made.revision,
        fields: { title: 'a different payload' },
      } as Command);
      expect(isCommandRefusal(refusal) && refusal.code).toBe('OPERATION_ID_REUSED');
    });
  });
});
