// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- one world per file, its cases in one describe */
//
// C57 part B (#2117): `C57 approval makes the task` and `C57 never auto-applied`, end to end
// through the agent's worker lease. Approval makes no task; the worker's call under its live
// lease on the review's task makes exactly one, a subtask of that task through `task.create`'s
// path, its business, client and source derived, never sent. A proposed or refused request is
// no cause, and a retry answers the task already made.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { c57bWorld, type C57bWorld, type WorkerLease } from './c57b-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)(
  'C57 approval makes the task under the worker lease',
  () => {
    let w: C57bWorld;
    let lease: WorkerLease;

    beforeAll(async () => {
      w = await c57bWorld('c57bmake');
      lease = await w.leaseOn();
    }, 240_000);
    afterAll(async () => await w?.world.db.drop());

    it('C57 never auto-applied: approval makes no task until the worker asks under its lease', async () => {
      const before = await w.tasks(w.world.business);
      const id = await w.filed('approve');
      expect(await w.tasks(w.world.business)).toBe(before);
      const row = (await w.requests(w.world.business)).find((request) => request.id === id);
      expect(row).toMatchObject({ state: 'approved', created_task_id: null });
    });

    it('C57 approval makes the task: one subtask of the review task, its client and source derived', async () => {
      const before = await w.tasks(w.world.business);
      const id = await w.filed('approve', 'Swap the hero photo for the team photo');
      const made = await w.make(lease, id);
      expect(isCommandRefusal(made)).toBe(false);
      const taskId = String(detailOf(made)['taskId']);
      expect(detailOf(made)).toMatchObject({ changeRequestId: id, taskId });
      expect(await w.tasks(w.world.business)).toBe(before + 1);
      const task = await w.taskRow(taskId);
      expect(task?.business_id).toBe(w.world.business);
      expect(task?.data).toMatchObject({
        parent: w.taskA,
        client: w.partyA,
        source: 'agent:api',
        description: 'Swap the hero photo for the team photo',
      });
      const row = (await w.requests(w.world.business)).find((request) => request.id === id);
      expect(row?.created_task_id).toBe(taskId);
    });

    it('a retry with a new operation answers the task already made and makes no second', async () => {
      const id = await w.filed('approve');
      const first = String(detailOf(await w.make(lease, id))['taskId']);
      const before = await w.tasks(w.world.business);
      const again = await w.make(lease, id);
      expect(detailOf(again)).toMatchObject({ changeRequestId: id, taskId: first });
      expect(await w.tasks(w.world.business)).toBe(before);
    });

    it('a proposed or a refused request is no cause: NOT_FOUND, and no task', async () => {
      const proposed = await w.filed();
      const refusedOne = await w.filed('refuse');
      const before = await w.tasks(w.world.business);
      for (const id of [proposed, refusedOne]) {
        // eslint-disable-next-line no-await-in-loop -- one lease, one call at a time
        expect(await w.make(lease, id)).toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(await w.tasks(w.world.business)).toBe(before);
      const rows = (await w.requests(w.world.business)).filter((request) =>
        [proposed, refusedOne].includes(request.id),
      );
      expect(rows.map((row) => row.created_task_id)).toStrictEqual([null, null]);
    });

    it('review.read shows each request proposed, approved and pending, refused, or made', async () => {
      const pending = await w.filed('approve');
      const made = await w.filed('approve');
      const taskId = String(detailOf(await w.make(lease, made))['taskId']);
      const reviewId = (
        await w.world.db.admin.execute<{ readonly review_id: string }>(
          'select review_id from public.review_change_requests where id = $1',
          [made],
        )
      )[0]?.review_id;
      const answer = await w.read(w.ava, reviewId);
      const requests = (
        answer as unknown as { review: { changeRequests: readonly Record<string, unknown>[] } }
      ).review.changeRequests;
      const byId = new Map(requests.map((request) => [request['changeRequestId'], request]));
      expect(byId.get(pending)).toMatchObject({ state: 'approved', createdTaskId: null });
      expect(byId.get(made)).toMatchObject({ state: 'approved', createdTaskId: taskId });
      expect(requests.map((request) => request['state'])).toEqual(
        expect.arrayContaining(['proposed', 'approved', 'refused']),
      );
      expect(byId.get(made)?.['text']).toBe('Move the heading above the photo on the phone layout');
    });
  },
);
