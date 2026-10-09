// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { addClient, enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { UncheckedRequest } from '../../packages/core-commands/src/commands/requests.ts';
import type {
  CommandHandle,
  CommandResult,
} from '../../packages/core-commands/src/commands/register-store.ts';
import type { TaskDetail, TaskBoardResult } from '../../packages/core-wire/src/index.ts';

/** The configured scratch server; fresh-database owns each fixture DB and its roles. */
export function ownedRankServer(): string {
  const address = databaseUrlFromEnvironment();
  if (address === undefined)
    throw new Error(
      'Task rank core durable proof needs the normal scratch DATABASE_ADMIN_URL. Nothing is skipped or proved.',
    );
  // The bounded local launcher validates its exact labelled server. Normal DB
  // admission supplies its own scratch server; never use its control basename
  // as a fixture identity. createFreshDatabase creates and drops our own DB.
  return address;
}

export interface RankCoreWorld {
  readonly db: FreshDatabase;
  readonly business: string;
  readonly foreign: string;
  readonly owner: Member;
  readonly otherOwner: Member;
  readonly reader: Member;
  readonly nobody: Member;
  readonly client: string;
}

async function writer(db: FreshDatabase, business: string, name: string): Promise<Member> {
  const member = await enrol(db.app, business, name);
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, member, 'read');
    await grantTo(tx, member, 'write');
    await grantTo(tx, member, 'share');
  });
  return member;
}

export async function rankCoreWorld(): Promise<RankCoreWorld> {
  const db = await createFreshDatabase({
    serverUrl: ownedRankServer(),
    part: 'orch172_rankcore',
    fromEmpty: true,
  });
  try {
    const business = await insertBusiness(db.app, `rankcore-alpha-${randomUUID()}`);
    const foreign = await insertBusiness(db.app, `rankcore-bravo-${randomUUID()}`);
    await installSpine(db.app, business);
    await installSpine(db.app, foreign);
    const owner = await writer(db, business, 'rankcore-owner');
    const otherOwner = await writer(db, foreign, 'rankcore-other-owner');
    const reader = await enrol(db.app, business, 'rankcore-client-reader');
    const nobody = await enrol(db.app, business, 'rankcore-nobody');
    const client = randomUUID();
    await addClient(db.app, business, client, owner);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'party', id: client });
    });
    return { db, business, foreign, owner, otherOwner, reader, nobody, client };
  } catch (error) {
    await db.drop();
    throw error;
  }
}

export async function rankCommand(
  world: RankCoreWorld,
  request: UncheckedRequest,
  by: Member = world.owner,
  business: string = world.business,
): Promise<CommandResult> {
  return await executeCommand(world.db.app, business, by.presented, 'api', {
    operationId: randomUUID(),
    ...request,
  });
}

export function appliedTask(result: CommandResult): {
  readonly id: string;
  readonly revision: number;
} {
  if (isCommandRefusal(result)) throw new Error(`${result.code}: ${result.names.join(', ')}`);
  if (result.recordId === null || result.revision === null)
    throw new Error('Task command returned no durable task handle');
  return { id: result.recordId, revision: result.revision };
}

export async function makeRankTask(
  world: RankCoreWorld,
  marks: readonly [number | null, number | null, number | null] = [7, 9, 8],
  client: string | null = null,
  by: Member = world.owner,
  business: string = world.business,
): Promise<{ readonly id: string; readonly revision: number }> {
  let made = appliedTask(
    await rankCommand(
      world,
      { command: 'task.create', fields: { title: `rankcore-${randomUUID()}` } },
      by,
      business,
    ),
  );
  if (client !== null)
    made = appliedTask(
      await rankCommand(
        world,
        {
          command: 'task.set_party',
          recordId: made.id,
          expectedRevision: made.revision,
          fields: { client },
        },
        by,
        business,
      ),
    );
  return appliedTask(
    await rankCommand(
      world,
      {
        command: 'task.set_scores',
        recordId: made.id,
        expectedRevision: made.revision,
        fields: { impact: marks[0], confidence: marks[1], ease: marks[2] },
      },
      by,
      business,
    ),
  );
}

export async function readRankTask(
  world: RankCoreWorld,
  id: string,
  by: Member = world.owner,
  business: string = world.business,
): Promise<TaskDetail> {
  const answer = await executeRead(world.db.app, business, by.presented, {
    read: 'task.read',
    recordId: id,
  });
  if (isCommandRefusal(answer))
    throw new Error(`Task rank read refused ${answer.code}: ${answer.names.join(', ')}`);
  if (!('task' in answer)) throw new Error('Task rank read did not return the admitted task');
  return answer.task;
}

export async function readRankBoard(
  world: RankCoreWorld,
  by: Member = world.owner,
): Promise<TaskBoardResult> {
  const answer = await executeRead(world.db.app, world.business, by.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer))
    throw new Error('Task rank board did not return the admitted pool');
  return answer;
}

export async function dateRankTask(
  world: RankCoreWorld,
  id: string,
  days: number | null,
): Promise<CommandHandle> {
  const task = await readRankTask(world, id);
  const result = await rankCommand(world, {
    command: 'task.update',
    recordId: id,
    expectedRevision: task.revision,
    fields: {
      started_at: days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString(),
    },
  });
  if (isCommandRefusal(result)) throw new Error(`Date update refused ${result.code}`);
  return result;
}
