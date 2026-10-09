// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, addClient, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';
import type { TaskDetail, BoardTask } from '../../packages/core-wire/src/index.ts';

export interface IceWorld {
  readonly db: FreshDatabase;
  readonly business: string;
  readonly foreign: string;
  readonly owner: Member;
  readonly reader: Member;
  readonly nobody: Member;
  readonly clients: readonly string[];
}
interface IceHandle {
  readonly id: string;
  readonly revision: number;
}

export async function iceWorld(): Promise<IceWorld> {
  if (databaseUrlFromEnvironment() === undefined)
    throw new Error('ICE proof requires normal scratch server; no cases skipped');
  const db = await createFreshDatabase({ part: 'orch172_ice_editor' });
  try {
    const business = await insertBusiness(db.app, `ice-alpha-${randomUUID()}`);
    const foreign = await insertBusiness(db.app, `ice-bravo-${randomUUID()}`);
    await installSpine(db.app, business);
    await installSpine(db.app, foreign);
    const owner = await enrol(db.app, business, 'ice-owner');
    const reader = await enrol(db.app, business, 'ice-one-task-reader');
    const nobody = await enrol(db.app, business, 'ice-ungranted');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, owner, 'read');
      await grantTo(tx, owner, 'write');
      await grantTo(tx, owner, 'share');
    });
    const clients = [randomUUID(), randomUUID()];
    await Promise.all(clients.map((id) => addClient(db.app, business, id, owner)));
    return { db, business, foreign, owner, reader, nobody, clients };
  } catch (error) {
    await db.drop();
    throw error;
  }
}
export const iceCommand = async (
  w: IceWorld,
  body: UncheckedRequest,
  by: Member = w.owner,
): Promise<CommandResult> =>
  await executeCommand(w.db.app, w.business, by.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  });

export function handle(answer: CommandResult): IceHandle {
  if (isCommandRefusal(answer)) throw new Error(`ICE setup refused ${answer.code}`);
  if (answer.recordId === null || answer.revision === null)
    throw new Error('ICE write has no durable handle');
  return { id: answer.recordId, revision: answer.revision };
}
export const newIceTask = async (w: IceWorld): Promise<IceHandle> =>
  handle(
    await iceCommand(w, {
      command: 'task.create',
      fields: { title: `Synthetic ICE ${randomUUID()}` },
    }),
  );

export async function icePage(w: IceWorld, id: string, by: Member = w.owner): Promise<TaskDetail> {
  const answer = await executeRead(w.db.app, w.business, by.presented, {
    read: 'task.read',
    recordId: id,
  });
  if (isCommandRefusal(answer) || !('task' in answer))
    throw new Error('Expected granted internal task read');
  return answer.task;
}
export async function iceBoard(w: IceWorld): Promise<readonly BoardTask[]> {
  const answer = await executeRead(w.db.app, w.business, w.owner.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer))
    throw new Error('Expected granted board read');
  return answer.tasks;
}
