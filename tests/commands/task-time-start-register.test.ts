// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from './fixture.ts';
import { entryIdOf, timeWorld, withTimerCleanup, type TimeWorld } from './time-world.ts';
import { pendingPair, registered } from './task-time-start-register-support.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: TimeWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('timerfoundationregister');
}, 180_000);
afterAll(async () => {
  await w?.db.drop();
});

async function readable(): Promise<{ readonly taskId: string; readonly grantId: string }> {
  const taskId = await w.fresh(w.alpha, w.ada, 'Original Start register canary');
  const grantId = await w.db.app.withBusiness(
    w.alpha,
    async (tx) => await grantTo(tx, w.clientA, 'read', { kind: 'record', id: taskId }),
  );
  return { taskId, grantId };
}

async function provePair(rollback: boolean): Promise<void> {
  const { taskId } = await readable();
  const pair = await pendingPair(w, taskId, rollback);
  expect(await registered(w, pair.request.operationId)).toEqual([1, 1]);
  const kept = await w.entries(taskId);
  expect(kept.map((row) => row.id)).toEqual([entryIdOf(pair.result)]);
  if (rollback) {
    expect(pair.original.error).toBeInstanceOf(Error);
    expect(entryIdOf(pair.result)).not.toBe(pair.tentative);
  } else {
    expect(pair.original.error).toBeNull();
    expect(pair.result).toEqual(pair.original.result);
    expect(entryIdOf(pair.result)).toBe(pair.tentative);
  }
  const unchanged = await w.as(w.alpha, w.clientA, pair.request);
  expect(unchanged).toEqual(pair.result);
  const changed = await w.as(w.alpha, w.clientA, { ...pair.request, taskId: randomUUID() });
  expect(changed).toMatchObject({ refused: true, code: 'OPERATION_ID_REUSED' });
  expect(await registered(w, pair.request.operationId)).toEqual([1, 1]);
}

it.skipIf(serverUrl === undefined)(
  'an exact Start retry waits for the original transaction and replays once after commit',
  withTimerCleanup(
    () => w,
    async () => {
      await provePair(false);
    },
  ),
);

it.skipIf(serverUrl === undefined)(
  'an exact Start retry waits for the original transaction and executes once after rollback',
  withTimerCleanup(
    () => w,
    async () => {
      await provePair(true);
    },
  ),
);

it.skipIf(serverUrl === undefined)(
  'a Start lost before delivery cannot bypass task-read denial and its refused retry retains unknown custody',
  withTimerCleanup(
    () => w,
    async () => {
      const { taskId, grantId } = await readable();
      const writes: Record<string, unknown>[] = [];
      let lost = true;
      const client = new OperationsClient({
        origin: '',
        businessKey: 'alpha',
        signedIn: true,
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          writes.push(body);
          if (lost) {
            lost = false;
            throw new TypeError('Start lost before delivery');
          }
          const answer = await w.as(w.alpha, w.clientA, { ...body, command: 'time.start' });
          return new Response(JSON.stringify(answer), {
            status: isCommandRefusal(answer) ? 404 : 200,
          });
        },
      });
      const timer = new TaskTimer(client, () => true);
      timer.start({ id: taskId });
      await expect.poll(() => timer.snapshot().attempt?.status).toBe('unknown');
      expect(await registered(w, String(writes[0]?.['operationId']))).toEqual([0, 0]);
      await w.db.app.withBusiness(w.alpha, async (tx) => {
        await revokeGrant(tx, grantId);
      });
      timer.retry();
      await expect.poll(() => writes.length).toBe(2);
      await expect.poll(() => timer.snapshot().attempt?.because).toContain('NOT_FOUND');
      expect(timer.snapshot().attempt?.status).toBe('unknown');
      expect(timer.snapshot().binding).toBeNull();
      expect(writes[1]).toEqual(writes[0]);
      expect(await w.entries(taskId)).toEqual([]);
      expect(await registered(w, String(writes[0]?.['operationId']))).toEqual([1, 0]);
    },
  ),
);
