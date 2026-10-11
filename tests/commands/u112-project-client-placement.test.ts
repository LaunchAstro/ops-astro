// SPDX-License-Identifier: AGPL-3.0-only
//
// U112 Core 04 4, against a real database: a client's project holds only that
// client's work. The new-task draft sends its project as `task.move` after the
// client; a project of another client, of another business, or one the person
// cannot reach is refused as that part, and the task stays off it. A project
// with no client (the agency's own) still takes any task. A project holding a
// task on its board has content, so its own client is locked: it cannot leave
// that task under another client's project.

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
  console.warn('u112-project-client-placement: DATABASE_URL is unset, so nothing below ran.');
}

type Body = Readonly<Record<string, unknown>>;
type Drafted = { readonly recordId: string; readonly revision: number | null };

interface World {
  readonly db: FreshDatabase;
  readonly business: string;
  readonly owner: Member;
  readonly narrow: Member;
  readonly ours: string;
  readonly theirs: string;
  readonly projects: { ours: string; theirs: string; agency: string; foreign: string };
}

let world: World;

async function send(who: Member, body: Body, where = world.business) {
  return await executeCommand(world.db.app, where, who.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
}

async function applied(who: Member, body: Body, where = world.business) {
  const answer = await send(who, body, where);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
}

/** A task made as the draft makes one: created, then its client; its project is the test's. */
async function drafted(client: string | null, who = world.owner): Promise<Drafted> {
  const made = await applied(who, { command: 'task.create', fields: { title: 'Drafted' } });
  const recordId = made.recordId ?? '';
  if (client === null) return { recordId, revision: made.revision };
  const party = await applied(who, {
    command: 'task.set_party',
    recordId,
    expectedRevision: made.revision,
    fields: { client },
  });
  return { recordId, revision: party.revision };
}

async function moveOnto(task: Drafted, board: string, who = world.owner) {
  return await send(who, {
    command: 'task.move',
    recordId: task.recordId,
    expectedRevision: task.revision,
    board,
  });
}

async function boardOf(recordId: string): Promise<string | null> {
  const read = await executeRead(world.db.app, world.business, world.owner.presented, {
    read: 'task.read',
    recordId,
  });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  return read.task.board?.readable === true ? read.task.board.id : null;
}

async function factsOf(recordId: string) {
  const read = await executeRead(world.db.app, world.business, world.owner.presented, {
    read: 'task.read',
    recordId,
  });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  const task = read.task as unknown as Body;
  return {
    client: task['client'],
    hasContent: task['hasContent'],
    revision: task['revision'],
    board: await boardOf(recordId),
  };
}

async function member(db: FreshDatabase, business: string, name: string): Promise<Member> {
  const who = await enrol(db.app, business, name);
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write', 'share'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, who, action);
    }
  });
  return who;
}

async function seed(): Promise<void> {
  const db = await createFreshDatabase({ part: 'u112place' });
  const business = await insertBusiness(db.app, 'u112-place-alpha');
  const foreign = await insertBusiness(db.app, 'u112-place-beta');
  await installSpine(db.app, business);
  await installSpine(db.app, foreign);
  const owner = await member(db, business, 'owner');
  const stranger = await member(db, foreign, 'stranger');
  const narrow = await enrol(db.app, business, 'narrow');
  const ours = await clientHere(db.admin, business, randomUUID());
  const theirs = await clientHere(db.admin, business, randomUUID());
  const projects = { ours: '', theirs: '', agency: '', foreign: '' };
  world = { db, business, owner, narrow, ours, theirs, projects };
  projects.ours = (await drafted(ours)).recordId;
  projects.theirs = (await drafted(theirs)).recordId;
  projects.agency = (await drafted(null)).recordId;
  const made = await applied(
    stranger,
    { command: 'task.create', fields: { title: 'Theirs' } },
    foreign,
  );
  projects.foreign = made.recordId ?? '';
}

/** A project holding a task on its board has content: its client change is refused. */
async function heldTaskLocksProjectClient(): Promise<void> {
  const project = await drafted(world.ours);
  const task = await drafted(world.ours);
  expect(isCommandRefusal(await moveOnto(task, project.recordId))).toBe(false);
  const before = await factsOf(project.recordId);
  const held = await factsOf(task.recordId);

  const answer = await send(world.owner, {
    command: 'task.set_party',
    recordId: project.recordId,
    expectedRevision: before.revision,
    fields: { client: world.theirs },
  });
  expect(isCommandRefusal(answer) ? answer.code : 'applied').toBe('CLIENT_LOCKED');
  expect(await factsOf(project.recordId)).toEqual(before);
  expect(await factsOf(task.recordId)).toEqual(held);
  expect(held).toMatchObject({ client: world.ours, board: project.recordId });
}

async function emptyProjectClientChanges(): Promise<void> {
  const project = await drafted(world.ours);
  expect((await factsOf(project.recordId)).hasContent).toBe(false);
  await applied(world.owner, {
    command: 'task.set_party',
    recordId: project.recordId,
    expectedRevision: project.revision,
    fields: { client: world.theirs },
  });
  expect((await factsOf(project.recordId)).client).toBe(world.theirs);
}

describe.skipIf(serverUrl === undefined)(
  'U112 Core 04 4: a project holds its client’s work',
  () => {
    beforeAll(seed, 180_000);

    afterAll(async () => {
      await world?.db.drop();
    });

    it('a task joins its own client’s project and the agency’s project', async () => {
      const own = await drafted(world.ours);
      expect(isCommandRefusal(await moveOnto(own, world.projects.ours))).toBe(false);
      expect(await boardOf(own.recordId)).toBe(world.projects.ours);
      const agency = await drafted(world.ours);
      expect(isCommandRefusal(await moveOnto(agency, world.projects.agency))).toBe(false);
      expect(await boardOf(agency.recordId)).toBe(world.projects.agency);
    });

    it('another client’s project is refused as the project part, and the task stays off it', async () => {
      const task = await drafted(world.ours);
      const answer = await moveOnto(task, world.projects.theirs);
      expect(isCommandRefusal(answer) ? answer.names : 'applied').toEqual(['board']);
      expect(await boardOf(task.recordId)).toBeNull();
    });

    it('a task with no client is refused a client’s project', async () => {
      const task = await drafted(null);
      const answer = await moveOnto(task, world.projects.ours);
      expect(isCommandRefusal(answer) ? answer.names : 'applied').toEqual(['board']);
      expect(await boardOf(task.recordId)).toBeNull();
    });

    it('a project with a task on its board keeps its client', heldTaskLocksProjectClient);

    it('an empty project’s client still changes', emptyProjectClientChanges);

    it('another business’s project and one the person cannot reach are refused, naming nothing of it', async () => {
      const task = await drafted(world.ours);
      const crossed = await moveOnto(task, world.projects.foreign);
      expect(isCommandRefusal(crossed)).toBe(true);
      expect(JSON.stringify(crossed)).not.toContain('Theirs');
      expect(await boardOf(task.recordId)).toBeNull();

      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, world.narrow, 'write', { kind: 'record', id: task.recordId });
      });
      const unreached = await moveOnto(task, world.projects.ours, world.narrow);
      expect(isCommandRefusal(unreached)).toBe(true);
      expect(await boardOf(task.recordId)).toBeNull();
    });
  },
);
