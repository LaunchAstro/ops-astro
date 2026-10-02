// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the task category suites (MP-4-8 CS-4.16) over the ad hoc world:
// what a task's row stores, the set and read of its label, and alpha's real
// clients (`client.create`) with tasks placed under them.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { Member } from './fixture.ts';
import { alpha, as, db, fresh, writer } from './adhoc-world.ts';

export type Task = { recordId: string; revision: number };

export const stored = async (
  recordId: string,
): Promise<{ category: unknown; revision: number }> => {
  const rows = await db.admin.execute<{ readonly category: unknown; readonly revision: string }>(
    `select data -> 'category' as category, revision::text as revision
       from public.records where id = $1`,
    [recordId],
  );
  return { category: rows[0]?.category ?? null, revision: Number(rows[0]?.revision) };
};

export const current = async (task: Task): Promise<Task> => ({
  recordId: task.recordId,
  revision: (await stored(task.recordId)).revision,
});

export const setCategory = async (
  business: BusinessId,
  by: Member,
  task: Task,
  category: unknown,
  operationId: string = randomUUID(),
): Promise<CommandResult> =>
  await as(business, by, {
    command: 'task.set_category',
    operationId,
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields: { category },
  });

/** The category `task.read` answers for the task, or the refusal's code. */
export const readCategory = async (
  business: BusinessId,
  by: Member,
  recordId: string,
): Promise<unknown> => {
  const read = await executeRead(db.app, business, by.presented, { read: 'task.read', recordId });
  if (isCommandRefusal(read)) return read.code;
  return 'task' in read ? (read.task as unknown as { category?: unknown }).category : 'no task';
};

/** A client of alpha made through `client.create`: `task.set_party` names only a real one. */
export const realClient = async (): Promise<string> => {
  const made = await as(alpha, writer, {
    command: 'client.create',
    name: `Client ${randomUUID()}`,
  });
  if (isCommandRefusal(made)) throw new Error(`client.create refused ${made.code}`);
  return String(made.detail?.['clientId']);
};

/** A fresh task of alpha's, placed under `client` while it is empty. */
export const underClient = async (client: string, title: string): Promise<Task> => {
  const task = await fresh(alpha, writer, title);
  const placed = await as(alpha, writer, {
    command: 'task.set_party',
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields: { client },
  });
  if (isCommandRefusal(placed)) throw new Error(`task.set_party refused ${placed.code}`);
  return await current(task);
};
