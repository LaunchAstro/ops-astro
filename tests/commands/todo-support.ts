// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the MP-7-1 and MP-7-2 read suites: a command that must apply, a
// task made, put under a client and assigned, and a reader's to-dos.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { TaskTodosResult } from '../../packages/core-wire/src/index.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from './fixture.ts';
import type { TimeWorld } from './time-world.ts';

type Body = Record<string, unknown>;

/** The commands that name the task's revision: the rest are rows beside it. */
const REVISED: ReadonlySet<string> = new Set([
  'task.assign',
  'task.complete',
  'task.comment',
  'task.set_party',
]);

async function revisionOf(w: TimeWorld, recordId: string): Promise<number> {
  const rows = await w.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where id = $1',
    [recordId],
  );
  return Number(rows[0]?.revision);
}

/** A setup command that must apply, at the task's current revision where it names one. */
export async function commandOk(
  w: TimeWorld,
  business: BusinessId,
  member: Member,
  body: Body,
): Promise<{ readonly recordId: string | null; readonly detail?: Readonly<Body> }> {
  const recordId = body['recordId'];
  const revised =
    REVISED.has(String(body['command'])) && typeof recordId === 'string'
      ? { expectedRevision: await revisionOf(w, recordId) }
      : {};
  const answer = await w.as(business, member, { ...body, ...revised });
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer as { readonly recordId: string | null; readonly detail?: Readonly<Body> };
}

const clientMakers = new Set<string>();

/**
 * A real client of `business` (C32), made by `by`, who is first given
 * `record:write` there once; `task.set_party` names only a real client.
 */
export async function madeClient(w: TimeWorld, business: BusinessId, by: Member): Promise<string> {
  if (!clientMakers.has(`${business}/${by.personId}`)) {
    await w.db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, by, 'write', WHOLE_BUSINESS, false, 'record');
    });
    clientMakers.add(`${business}/${by.personId}`);
  }
  const made = await commandOk(w, business, by, {
    command: 'client.create',
    name: `A made-up client ${randomUUID()}`,
  });
  return String(made.detail?.['clientId']);
}

/**
 * A task made by `by` (with any create operands) and assigned to `assignee`;
 * under `client` first when one is named (`by` then needs `task:share`).
 */
export async function assignTo(
  w: TimeWorld,
  business: BusinessId,
  by: Member,
  title: string,
  assignee: Member,
  operands: Body = {},
  client?: string,
): Promise<string> {
  const made = await commandOk(w, business, by, {
    command: 'task.create',
    fields: { title },
    ...operands,
  });
  const recordId = String(made.recordId);
  if (client !== undefined) {
    await commandOk(w, business, by, { command: 'task.set_party', recordId, fields: { client } });
  }
  await commandOk(w, business, by, {
    command: 'task.assign',
    recordId,
    fields: { assignee: assignee.personId },
  });
  return recordId;
}

/** The member's to-dos (or a scope's, MP-7-2), or the refusal thrown. */
export async function todosOf(
  w: TimeWorld,
  business: BusinessId,
  member: Member,
  scope: Body = {},
): Promise<TaskTodosResult> {
  const answer = await executeRead(w.db.app, business, member.presented, {
    read: 'task.todos',
    ...scope,
  } as never);
  if (isCommandRefusal(answer)) throw new Error(`task.todos refused ${answer.code}`);
  return answer as unknown as TaskTodosResult;
}
