// SPDX-License-Identifier: AGPL-3.0-only
//
// A client's project holds only that client's work (U112), in the trash too.
// An empty task left on client A's project by an earlier create keeps client A
// while the project is trashed: `task.set_party { client: B }` is refused as
// the board part, so the restored project does not come back holding client
// B's task.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { clientHere } from '../reads/client-rows.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('a-trashed-project-keeps-its-tasks-client: DATABASE_URL is unset, so nothing ran.');
}

type Body = Readonly<Record<string, unknown>>;

let db: FreshDatabase;
let business: string;
let owner: Member;
let ours: string;
let theirs: string;

const send = async (body: Body) =>
  await executeCommand(db.app, business, owner.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

async function applied(body: Body) {
  const answer = await send(body);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
}

async function factsOf(recordId: string) {
  const read = await executeRead(db.app, business, owner.presented, {
    read: 'task.read',
    recordId,
  });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  const task = read.task as unknown as Body & { board: { readable: boolean; id?: string } | null };
  return {
    client: task['client'],
    revision: task['revision'],
    board: task.board?.readable === true ? task.board.id : null,
  };
}

/** A top-level task under `client`, as the draft makes one: created, then its client. */
async function drafted(client: string) {
  const made = await applied({ command: 'task.create', fields: { title: 'Drafted' } });
  const recordId = made.recordId ?? '';
  const party = await applied({
    command: 'task.set_party',
    recordId,
    expectedRevision: made.revision,
    fields: { client },
  });
  return { recordId, revision: party.revision };
}

describe.skipIf(serverUrl === undefined)('a trashed project keeps its tasks’ client', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'trashedproject' });
    business = await insertBusiness(db.app, 'trashed-project-alpha');
    await installSpine(db.app, business);
    owner = await enrol(db.app, business, 'owner');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'share'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, owner, action);
      }
    });
    ours = await clientHere(db.admin, business, randomUUID());
    theirs = await clientHere(db.admin, business, randomUUID());
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('an empty task on a trashed project is refused another client, and is unchanged after restore', async () => {
    const project = await drafted(ours);
    const task = await drafted(ours);
    // The empty placement an earlier create left: no command makes it now.
    await db.admin.execute(
      `update records set data = data || jsonb_build_object('board', $2::text) where id = $1`,
      [task.recordId, project.recordId],
    );
    const before = await factsOf(task.recordId);
    const trashed = await applied({
      command: 'task.trash',
      recordId: project.recordId,
      expectedRevision: project.revision,
    });
    const answer = await send({
      command: 'task.set_party',
      recordId: task.recordId,
      expectedRevision: before.revision,
      fields: { client: theirs },
    });
    await applied({ command: 'task.restore', batchId: trashed.detail['batchId'] });

    expect(isCommandRefusal(answer) ? [answer.code, ...answer.names] : 'applied').toEqual([
      'PLACEMENT_IS_DERIVED',
      'board',
    ]);
    expect((await factsOf(project.recordId)).client).toBe(ours);
    expect(await factsOf(task.recordId)).toEqual(before);
  });
});
