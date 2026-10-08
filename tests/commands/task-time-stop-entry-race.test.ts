// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { entryIdOf, timeWorld, withTimerCleanup, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: TimeWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('stopentryrace');
}, 180_000);
afterAll(async () => {
  await w?.db.drop();
});

async function isRunning(entryId: string): Promise<boolean> {
  const rows = await w.db.admin.execute<{
    readonly running: boolean;
    readonly minutes: number | null;
  }>(`select ended_at is null as running, minutes from public.time_entries where id = $1`, [
    entryId,
  ]);
  expect(rows).toHaveLength(1);
  if (rows[0]?.running === true) expect(rows[0].minutes).toBeNull();
  return rows[0]?.running === true;
}

async function audit(operationId: string): Promise<string[]> {
  const rows = await w.db.admin.execute<{ readonly outcome: string }>(
    `select outcome from public.audit_events where business_id = $1 and operation_id = $2 order by seq`,
    [w.alpha, operationId],
  );
  return rows.map((row) => row.outcome);
}

function transport(loss: 'before' | 'after') {
  const writes: { readonly command: string; readonly body: Record<string, unknown> }[] = [];
  const stops: CommandResult[] = [];
  let lose = true;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url, init) => {
      const command = String(url).endsWith('/start') ? 'time.start' : 'time.stop';
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push({ command, body });
      if (command === 'time.stop' && lose && loss === 'before') {
        lose = false;
        throw new Error('request lost before registration');
      }
      const result = await w.as(w.alpha, w.ada, { ...body, command });
      if (command === 'time.stop') {
        stops.push(result);
        if (lose) {
          lose = false;
          throw new Error('answer lost after commit');
        }
      }
      return new Response(JSON.stringify(result), { status: isCommandRefusal(result) ? 404 : 200 });
    },
  });
  return { timer: new TaskTimer(client, () => true), writes, stops };
}

async function lostStop(loss: 'before' | 'after') {
  const taskId = await w.fresh(w.alpha, w.ada, `Stop lost ${loss}`);
  const test = transport(loss);
  test.timer.start({ id: taskId });
  await expect.poll(() => test.timer.snapshot().binding?.running?.entryId).toBeTruthy();
  const entryA = test.timer.snapshot().binding?.running?.entryId ?? '';
  test.timer.stop();
  await expect.poll(() => test.timer.snapshot().attempt?.status).toBe('unknown');
  const sent = test.writes.find((one) => one.command === 'time.stop')?.body;
  expect(sent).toBeDefined();
  const operationId = String(sent?.['operationId']);
  return { ...test, taskId, entryA, sent, operationId };
}

async function startB(taskId: string): Promise<string> {
  return entryIdOf(await w.as(w.alpha, w.ada, { command: 'time.start', taskId }));
}

async function finish(taskId: string, expectedEntryId: string) {
  const answer = await w.as(w.alpha, w.ada, { command: 'time.stop', taskId, expectedEntryId });
  expect(entryIdOf(answer)).toBe(expectedEntryId);
}

it.skipIf(serverUrl === undefined)(
  'a Stop lost before registration cannot stop a newer entry on the same task',
  withTimerCleanup(
    () => w,
    async () => {
      const test = await lostStop('before');
      expect(await audit(test.operationId)).toEqual([]);
      const registered = await w.db.admin.execute<{ readonly operation_id: string }>(
        `select operation_id from public.operations where business_id = $1 and operation_id = $2`,
        [w.alpha, test.operationId],
      );
      expect(registered).toEqual([]);
      expect(await isRunning(test.entryA)).toBe(true);
      // This competing window uses the legacy contract too, so the baseline race reaches the store.
      await w.as(w.alpha, w.ada, { command: 'time.stop', taskId: test.taskId });
      const entryB = await startB(test.taskId);
      expect(entryB).not.toBe(test.entryA);
      test.timer.retry();
      await expect.poll(() => test.stops.length).toBe(1);
      await expect.poll(() => test.timer.snapshot().attempt?.status).not.toBe('pending');
      expect(await isRunning(entryB), 'retained Stop must leave the newer entry running').toBe(
        true,
      );
      expect(test.stops[0]).toMatchObject({ refused: true, code: 'NOT_FOUND' });
      expect(test.timer.snapshot().attempt?.status).toBe('unknown');
      expect(
        test.writes.filter((one) => one.command === 'time.stop').map((one) => one.body),
      ).toEqual([test.sent, test.sent]);
      expect(test.sent?.['expectedEntryId']).toBe(test.entryA);
      expect(await audit(test.operationId)).toEqual(['refused']);
      expect(await w.entries(test.taskId)).toHaveLength(2);
      await finish(test.taskId, entryB);
    },
  ),
);

it.skipIf(serverUrl === undefined)(
  'a committed Stop replays its original receipt while the newer entry stays running',
  withTimerCleanup(
    () => w,
    async () => {
      const test = await lostStop('after');
      expect(await audit(test.operationId)).toEqual(['applied']);
      expect(await isRunning(test.entryA)).toBe(false);
      const original = test.stops[0];
      const entryB = await startB(test.taskId);
      test.timer.retry();
      await expect.poll(() => test.timer.snapshot().attempt).toBeNull();
      expect(test.stops[1]).toEqual(original);
      const replay = test.stops[1];
      if (replay === undefined) throw new Error('retry returned no receipt');
      expect(entryIdOf(replay)).toBe(test.entryA);
      expect(await isRunning(entryB)).toBe(true);
      expect(await audit(test.operationId)).toEqual(['applied', 'replayed']);
      expect(
        test.writes.filter((one) => one.command === 'time.stop').map((one) => one.body),
      ).toEqual([test.sent, test.sent]);
      expect(test.sent?.['expectedEntryId']).toBe(test.entryA);
      expect(await w.entries(test.taskId)).toHaveLength(2);
      await finish(test.taskId, entryB);
    },
  ),
);
