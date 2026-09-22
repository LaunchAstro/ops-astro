// SPDX-License-Identifier: AGPL-3.0-only
//
// What a task command does: the lifecycle, the placement and the board.
//
// One of these discharges something an earlier lane handed on. T1e left
// specification 14.2 point 5 — `board` is generic within a board the caller
// may already write and `task.move` when it changes visibility — to whichever
// part read `escalating_operation`, and that is `task.update` here.
//
// Two companion files carry the rest: `task-fields.test.ts` is what a payload
// may carry, and `task-trash-commands.test.ts` is the trash family and
// revocation. Three files because the per-file cap is 400 hand-written lines
// and no waiver lifts it.

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
import { readRecordAudit } from '../../packages/core-records/src/commands/audit.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task commands: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

describe.skipIf(serverUrl === undefined)(
  'the task commands: lifecycle, placement and trash',
  () => {
    let db: FreshDatabase;
    let business: string;
    let worker: Member;

    const run = async (command: Parameters<typeof executeCommand>[4], who: Member = worker) =>
      await executeCommand(db.app, business, who.presented, 'api', command);

    const create = async (
      fields: Readonly<Record<string, unknown>>,
      extra: Readonly<Record<string, unknown>> = {},
    ) => {
      const made = await run({
        command: 'task.create',
        operationId: randomUUID(),
        fields,
        ...extra,
      } as Parameters<typeof executeCommand>[4]);
      if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
      return made;
    };

    const read = async (recordId: string) =>
      await db.app.withBusiness(business, async (tx) => {
        const rows = await tx.query<{
          readonly data: Record<string, unknown>;
          readonly revision: string;
          readonly ts_2: Date | null;
          readonly uuid_5: string | null;
          readonly uuid_6: string | null;
        }>(
          `select data, revision::text as revision, ts_2, uuid_5, uuid_6 from records
            where business_id = $1 and id = $2`,
          [business, recordId],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('read: gone');
        return row;
      });

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'f' });
      business = await insertBusiness(db.app, 'task-commands');
      await installSpine(db.app, business);
      worker = await enrol(db.app, business, 'worker');
      await db.app.withBusiness(business, async (tx) => {
        await grantTo(tx, worker, 'write');
        await grantTo(tx, worker, 'assign');
        await grantTo(tx, worker, 'share');
        await grantTo(tx, worker, 'manage');
      });
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    describe('a created task has a state', () => {
      it('places a task the caller gave no state into the first unstarted one', async () => {
        const made = await create({ title: 'no state named' });
        const row = await read(made.recordId ?? '');
        const stateId = row.data['state'];
        expect(stateId).toBeTypeOf('string');

        const state = await db.app.withBusiness(business, async (tx) => {
          const rows = await tx.query<{ readonly key: string; readonly category: string }>(
            `select txt_1 as key, txt_2 as category from records
              where business_id = $1 and id = $2`,
            [business, String(stateId)],
          );
          return rows[0];
        });
        expect(state?.category).toBe('unstarted');
        expect(state?.key).toBe('needs_review');
      });

      it('still takes the state the caller names', async () => {
        const made = await create({ title: 'state named' }, { stateKey: 'active' });
        const row = await read(made.recordId ?? '');
        expect(row.data['state']).toBeTypeOf('string');
      });
    });

    describe('completion is a projection of the state', () => {
      it('stamps on completion and clears on reopen, keeping the history', async () => {
        const made = await create({ title: 'lifecycle' }, { stateKey: 'active' });
        const completed = await run({
          command: 'task.complete',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: made.revision ?? 0,
        });
        if (isCommandRefusal(completed)) throw new Error(`complete refused ${completed.code}`);
        const stamped = await read(made.recordId ?? '');
        expect(stamped.ts_2).not.toBeNull();

        const reopened = await run({
          command: 'task.reopen',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: completed.revision ?? 0,
          reason: 'the client came back',
        });
        if (isCommandRefusal(reopened)) throw new Error(`reopen refused ${reopened.code}`);
        const cleared = await read(made.recordId ?? '');
        expect(cleared.ts_2).toBeNull();
        expect('completed_at' in cleared.data).toBe(false);

        // The stamp is a projection of the current state. The evidence that the
        // task was once complete is not, and it is in the chain.
        const history = await db.app.withBusiness(business, async (tx) =>
          readRecordAudit(tx, made.recordId ?? ''),
        );
        expect(history.map((event) => event.command)).toStrictEqual([
          'task.create',
          'task.complete',
          'task.reopen',
        ]);
        expect(history.every((event) => event.actor_id === worker.actorId)).toBe(true);
      });

      it('refuses a reopen of a task that was never completed', async () => {
        const made = await create({ title: 'never completed' }, { stateKey: 'active' });
        const refusal = await run({
          command: 'task.reopen',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: made.revision ?? 0,
          reason: 'no',
        });
        expect(isCommandRefusal(refusal) && refusal.code).toBe('TRANSITION_NOT_PERMITTED');
      });

      it('refuses a second completion of a completed task', async () => {
        const made = await create({ title: 'twice' }, { stateKey: 'active' });
        const completed = await run({
          command: 'task.complete',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: made.revision ?? 0,
        });
        if (isCommandRefusal(completed)) throw new Error('complete refused');
        const refusal = await run({
          command: 'task.complete',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: completed.revision ?? 0,
        });
        expect(isCommandRefusal(refusal) && refusal.code).toBe('TRANSITION_NOT_PERMITTED');
      });
    });

    describe('placement stays the server’s', () => {
      it('derives a subtask’s board and refuses its section', async () => {
        const parent = await create({ title: 'parent' });
        const board = await create({ title: 'a board' });
        await run({
          command: 'task.move',
          operationId: randomUUID(),
          recordId: parent.recordId ?? '',
          expectedRevision: parent.revision ?? 0,
          board: board.recordId,
        });
        const parentRow = await read(parent.recordId ?? '');
        const child = await create({ title: 'child' }, { parentId: parent.recordId });
        const childRow = await read(child.recordId ?? '');
        expect(childRow.uuid_5).toBe(parentRow.uuid_5);
        expect(childRow.uuid_6).toBeNull();
      });

      it('refuses a create that chooses its own rank', async () => {
        const refusal = await run({
          command: 'task.create',
          operationId: randomUUID(),
          fields: { title: 'ranked by hand', board_rank: 5 },
        });
        expect(isCommandRefusal(refusal) && refusal.code).toBe('PLACEMENT_IS_DERIVED');
      });

      it('ranks between neighbours rather than taking a number', async () => {
        const first = await create({ title: 'first' });
        const second = await create({ title: 'second' });
        const third = await create({ title: 'third' });
        const ranked = await run({
          command: 'task.rank',
          operationId: randomUUID(),
          recordId: third.recordId ?? '',
          expectedRevision: third.revision ?? 0,
          afterId: first.recordId,
          beforeId: second.recordId,
        });
        if (isCommandRefusal(ranked)) throw new Error(`rank refused ${ranked.code}`);
        const ranks = await db.app.withBusiness(business, async (tx) =>
          tx.query<{ readonly id: string; readonly rank: string }>(
            `select id, num_2::text as rank from records
            where business_id = $1 and id = any($2::uuid[]) order by num_2`,
            [business, [first.recordId, second.recordId, third.recordId]],
          ),
        );
        expect(ranks.map((row) => row.id)).toStrictEqual([
          first.recordId,
          third.recordId,
          second.recordId,
        ]);
      });

      it('refuses a rank with no neighbours at all', async () => {
        const only = await create({ title: 'alone' });
        const refusal = await run({
          command: 'task.rank',
          operationId: randomUUID(),
          recordId: only.recordId ?? '',
          expectedRevision: only.revision ?? 0,
        });
        expect(isCommandRefusal(refusal) && refusal.code).toBe('PLACEMENT_IS_DERIVED');
      });
    });

    describe('the board is generic inside itself and owned across boards', () => {
      it('refuses a generic write that moves a task to another board', async () => {
        const board = await create({ title: 'destination board' });
        const task = await create({ title: 'moving' });
        const refusal = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: task.recordId ?? '',
          expectedRevision: task.revision ?? 0,
          fields: { board: board.recordId },
        });
        expect(isCommandRefusal(refusal) && refusal.code).toBe('TRANSITION_PROTECTED');
        expect(isCommandRefusal(refusal) && refusal.names).toStrictEqual(['board=task.move']);
      });

      it('allows a section change inside the board the caller already writes', async () => {
        const board = await create({ title: 'one board' });
        const section = await create({ title: 'a section of it' });
        const task = await create({ title: 'sectioned' });
        const moved = await run({
          command: 'task.move',
          operationId: randomUUID(),
          recordId: task.recordId ?? '',
          expectedRevision: task.revision ?? 0,
          board: board.recordId,
          boardSection: section.recordId,
        });
        if (isCommandRefusal(moved)) throw new Error(`move refused ${moved.code}`);
        const generic = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: task.recordId ?? '',
          expectedRevision: moved.revision ?? 0,
          fields: { board_section: board.recordId, board: board.recordId },
        });
        expect(isCommandRefusal(generic)).toBe(false);
      });
    });
    describe('the explicit null the legacy had', () => {
      it('clears a field on an explicit null and leaves an absent one alone', async () => {
        const made = await create({ title: 'dated', due: new Date(0).toISOString(), priority: 3 });
        const cleared = await run({
          command: 'task.update',
          operationId: randomUUID(),
          recordId: made.recordId ?? '',
          expectedRevision: made.revision ?? 0,
          fields: { due: null },
        });
        if (isCommandRefusal(cleared)) throw new Error('update refused');
        const row = await read(made.recordId ?? '');
        expect('due' in row.data).toBe(false);
        expect(row.data['priority']).toBe(3);
      });
    });
  },
);
