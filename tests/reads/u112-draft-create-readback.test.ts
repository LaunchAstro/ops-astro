// SPDX-License-Identifier: AGPL-3.0-only
//
// U112 Core 04 6, against a real database: a filled draft from a client's
// project board, sent as its own recipe (`draftRecipe`, `phaseCommand`)
// builds it and in that order, writes every chosen field onto the client's
// project, and `task.read` reads each one back. The client goes first because
// any later write is content and locks it (S0-5), and a client's project
// takes only that client's work.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { clientHere } from './client-rows.ts';
import {
  emptyDraft,
  prefilledDraft,
  type TaskDraft,
} from '../../apps/web/src/screens/task/task-draft.ts';
import { prefillOf } from '../../apps/web/src/screens/task/task-prefill.ts';
import { draftBody, draftRecipe, partLabel } from '../../apps/web/src/screens/task/draft-recipe.ts';
import { command, phaseCommand } from '../../apps/web/src/screens/task/draft-command.ts';
import type { DraftCommand, DraftReceipt } from '../../apps/web/src/screens/task/draft-receipts.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('u112-draft-create-readback: DATABASE_URL is unset, so nothing below ran.');
}

type Body = Readonly<Record<string, unknown>>;

interface World {
  readonly db: FreshDatabase;
  readonly business: BusinessId;
  readonly owner: Member;
  readonly clientId: string;
  /** The client's own project. */
  readonly projectId: string;
  /** The agency's own project, which takes any client's work. */
  readonly agencyProjectId: string;
}

async function send(world: World, body: Body) {
  return await executeCommand(world.db.app, world.business, world.owner.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
}

async function applied(world: World, body: Body) {
  const answer = await send(world, body);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
}

async function seed(): Promise<World> {
  const db = await createFreshDatabase({ part: 'u112' });
  const business = (await insertBusiness(db.app, 'u112-alpha')) as BusinessId;
  await installSpine(db.app, business);
  const owner = await enrol(db.app, business, 'owner');
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write', 'share', 'assign', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, action);
    }
    // The draft's time and new tag are written to their own collections.
    for (const collection of ['time', 'tag']) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, 'write', undefined, false, collection);
    }
  });
  const clientId = await clientHere(db.admin, business, randomUUID());
  const partial = { db, business, owner, clientId, projectId: '', agencyProjectId: '' };
  const project = await applied(partial, {
    command: 'task.create',
    fields: { title: 'Website rebuild' },
  });
  await applied(partial, {
    command: 'task.set_party',
    recordId: project.recordId,
    expectedRevision: project.revision,
    fields: { client: clientId },
  });
  const agency = await applied(partial, {
    command: 'task.create',
    fields: { title: 'Agency site' },
  });
  return { ...partial, projectId: project.recordId ?? '', agencyProjectId: agency.recordId ?? '' };
}

/** The draft as a client's project board's door opens it, every field then filled in. */
const filled = (world: World): TaskDraft => ({
  ...emptyDraft(world.clientId),
  title: 'Rebuild the booking page',
  due: '2026-11-02',
  estimate: 120,
  boardId: world.projectId,
  stage: 'enquiries',
  priority: 2,
  description: 'Mobile users drop off.',
  agentBrief: 'Test on a phone.',
  category: 'seo',
  owner: { id: world.owner.personId, name: 'The owner' },
  note: 'Start with the booking form.',
  tags: ['Launch'],
  steps: ['Audit the form'],
  time: '30m',
});

/** Each field of `filled` as `task.read` reads it back. */
const everyField = (world: World) => ({
  title: 'Rebuild the booking page',
  client: world.clientId,
  board: { readable: true, id: world.projectId, title: 'Website rebuild' },
  stage: 'enquiries',
  priority: 2,
  description: 'Mobile users drop off.',
  agentBrief: 'Test on a phone.',
  category: 'seo',
  estimateMinutes: 120,
  due: '2026-11-02T00:00:00.000Z',
  assignee: { personId: world.owner.personId },
  comments: [{ body: 'Start with the booking form.', comment_type: 'note' }],
  tags: [{ name: 'Launch' }],
  steps: [{ title: 'Audit the form' }],
  time: { totalMinutes: 30 },
});

/** The command as the app sends it: the part's body with its identity and revision. */
async function sendCommand(world: World, sent: DraftCommand) {
  return await send(world, {
    command: sent.command,
    ...sent.body,
    operationId: sent.operationId,
    ...(sent.expectedRevision === null ? {} : { expectedRevision: sent.expectedRevision }),
  });
}

const receiptOf = (answer: {
  recordId: string | null;
  revision: number | null;
  detail?: unknown;
}) => ({
  recordId: answer.recordId,
  revision: answer.revision,
  key: null,
  identifier: (answer.detail as { tagId?: string } | undefined)?.tagId ?? null,
  minutes: null,
});

/** The parts whose answer is the task's next revision, as the draft takes them. */
const REVISES = new Set(['party', 'board', 'stage', 'details', 'category', 'assignment', 'agent']);

/** Create the draft's task with its own recipe, in its order: the labels of the parts not added. */
async function createFromDraft(world: World, draft: TaskDraft) {
  const recipe = draftRecipe(() => randomUUID(), draft);
  const made = await sendCommand(world, command('task.create', randomUUID(), draftBody(draft)));
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  let parent: DraftReceipt = receiptOf(made);
  const missed: string[] = [];
  for (const part of recipe) {
    let tagId: string | null = null;
    if (part.kind === 'tag') {
      // eslint-disable-next-line no-await-in-loop -- the tag is made before it is added
      const tag = await sendCommand(world, phaseCommand(part, parent));
      tagId = isCommandRefusal(tag) ? null : receiptOf(tag).identifier;
    }
    // eslint-disable-next-line no-await-in-loop -- each part names the revision the last one wrote
    const answer = await sendCommand(world, phaseCommand(part, parent, tagId));
    if (isCommandRefusal(answer)) missed.push(`${partLabel(part)} ${answer.code}`);
    else if (REVISES.has(part.kind)) parent = receiptOf(answer);
  }
  return { recordId: made.recordId ?? '', missed };
}

/** The task as `task.read` answers it. */
async function readBack(world: World, recordId: string) {
  const read = await executeRead(world.db.app, world.business, world.owner.presented, {
    read: 'task.read',
    recordId,
  });
  if (isCommandRefusal(read) || !('task' in read)) throw new Error('task.read refused');
  return read.task;
}

describe.skipIf(serverUrl === undefined)('U112 Core 04 6: every draft field reads back', () => {
  let world: World;

  beforeAll(async () => {
    world = await seed();
  }, 180_000);

  afterAll(async () => {
    await world?.db.drop();
  });

  it('a project door’s filled draft, sent as its recipe builds it, reads back every field', async () => {
    const created = await createFromDraft(world, filled(world));
    expect(created.missed).toStrictEqual([]);
    expect(await readBack(world, created.recordId)).toMatchObject(everyField(world));
  });

  it('a project door’s draft with no client is refused the client’s project', async () => {
    const created = await createFromDraft(world, { ...filled(world), clientId: null });
    expect(created.missed[0]).toBe('the project PLACEMENT_IS_DERIVED');
  });

  it('a client sent after the project would be refused, which is why the draft sends it first', async () => {
    const made = await applied(world, {
      command: 'task.create',
      fields: { title: 'Out of order' },
    });
    const recordId = made.recordId ?? '';
    const moved = await applied(world, {
      command: 'task.move',
      recordId,
      board: world.agencyProjectId,
      expectedRevision: made.revision,
    });
    const late = await send(world, {
      command: 'task.set_party',
      recordId,
      expectedRevision: moved.revision,
      fields: { client: world.clientId },
    });
    expect(isCommandRefusal(late) ? late.code : 'applied').toBe('CLIENT_LOCKED');
  });
});

describe.skipIf(serverUrl === undefined)('a plain board’s draft and its client', () => {
  let world: World;

  beforeAll(async () => {
    world = await seed();
  }, 180_000);

  afterAll(async () => {
    await world?.db.drop();
  });

  it('a plain board’s draft, its client chosen on the draft, is stored under that client and reads back', async () => {
    const chosen: TaskDraft = {
      ...prefilledDraft(prefillOf({ from: 'Projects' }, new Date())),
      title: 'Draft the bakery newsletter',
      clientId: world.clientId,
    };
    const created = await createFromDraft(world, chosen);
    expect(created.missed).toStrictEqual([]);
    expect(await readBack(world, created.recordId)).toMatchObject({
      client: world.clientId,
      category: 'admin',
      hasContent: true,
    });
  });

  it('a plain board’s draft sent with no client keeps its client locked, as before', async () => {
    const draft: TaskDraft = {
      ...prefilledDraft(prefillOf({ from: 'Projects' }, new Date())),
      title: 'Internal tidy-up',
    };
    const created = await createFromDraft(world, draft);
    const task = await readBack(world, created.recordId);
    expect(task).toMatchObject({ client: null, hasContent: true });
    const late = await send(world, {
      command: 'task.set_party',
      recordId: created.recordId,
      expectedRevision: task.revision,
      fields: { client: world.clientId },
    });
    expect(isCommandRefusal(late) ? late.code : 'applied').toBe('CLIENT_LOCKED');
  });
});
