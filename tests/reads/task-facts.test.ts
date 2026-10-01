// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-2: the facts the task page's band draws from `task.read`, against a
// real database: the stage and whether a client is set, beside the rank,
// marks and board the earlier tickets carry. Each value is the task's own
// record; each crossing plants a canary stage on a task the reader may not
// read and reads every body for it.

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
import { agentWorld, detailOf, type AgentWorld } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-facts: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Body = Readonly<Record<string, unknown>>;

const CANARY = `canary-${randomUUID()}`;

interface World {
  readonly db: FreshDatabase;
  readonly alpha: BusinessId;
  readonly bravo: BusinessId;
  readonly owner: Member;
  readonly clientAViewer: Member;
  readonly ids: Readonly<Record<string, string>>;
}

async function command(db: FreshDatabase, business: BusinessId, member: Member, body: Body) {
  const answer = await executeCommand(db.app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return answer;
}

async function revisionOf(db: FreshDatabase, recordId: string): Promise<number> {
  const rows = await db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return Number(rows[0]?.revision);
}

/** A task with a stage and, when named, a client. */
async function make(
  db: FreshDatabase,
  business: BusinessId,
  by: Member,
  facts: { readonly stage: string; readonly client?: string },
): Promise<string> {
  const made = await command(db, business, by, { command: 'task.create', fields: { title: 't' } });
  const recordId = made.recordId ?? '';
  await command(db, business, by, {
    command: 'task.set_stage',
    recordId,
    expectedRevision: await revisionOf(db, recordId),
    fields: { stage: facts.stage },
  });
  if (facts.client !== undefined) {
    await command(db, business, by, {
      command: 'task.set_party',
      recordId,
      expectedRevision: await revisionOf(db, recordId),
      fields: { client: facts.client },
    });
  }
  return recordId;
}

async function seed(): Promise<World> {
  const db = await createFreshDatabase({ part: 'tf' });
  const alpha = (await insertBusiness(db.app, 'facts-alpha')) as BusinessId;
  const bravo = (await insertBusiness(db.app, 'facts-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  const owner = await enrol(db.app, alpha, 'owner');
  const bravoOwner = await enrol(db.app, bravo, 'bravo-owner');
  const clientAViewer = await enrol(db.app, alpha, 'client-a-viewer');
  for (const [business, member] of [
    [alpha, owner],
    [bravo, bravoOwner],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one business at a time
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'share'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
        await grantTo(tx, member, action);
      }
    });
  }
  const ids = {
    clientA: await make(db, alpha, owner, { stage: 'Awareness', client: randomUUID() }),
    clientB: await make(db, alpha, owner, { stage: CANARY, client: randomUUID() }),
    noClient: await make(db, alpha, owner, { stage: 'Consideration' }),
    bravo: await make(db, bravo, bravoOwner, { stage: CANARY }),
  };
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, clientAViewer, 'read', { kind: 'record', id: ids.clientA });
  });
  return { db, alpha, bravo, owner, clientAViewer, ids };
}

const factsOf = async (world: World, member: Member, recordId: string) => {
  const answer = await executeRead(world.db.app, world.alpha, member.presented, {
    read: 'task.read',
    recordId,
  });
  if (isCommandRefusal(answer) || !('task' in answer)) {
    throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
  }
  return { stage: answer.task.stage, clientSet: answer.task.clientSet };
};

describe.skipIf(serverUrl === undefined)('MP-4-2 facts on the task read', () => {
  let world: World;

  beforeAll(async () => {
    world = await seed();
  }, 180_000);

  afterAll(async () => {
    await world?.db.drop();
  });

  it('MP-4-2 facts content: the stage and the client mark are the task’s own record', async () => {
    expect(await factsOf(world, world.owner, world.ids['clientA'] ?? '')).toStrictEqual({
      stage: 'Awareness',
      clientSet: true,
    });
    expect(await factsOf(world, world.owner, world.ids['noClient'] ?? '')).toStrictEqual({
      stage: 'Consideration',
      clientSet: false,
    });
  });

  describe('MP-4-2 isolation', () => {
    it('another business: its task is not found and its stage never appears', async () => {
      const answer = await executeRead(world.db.app, world.alpha, world.owner.presented, {
        read: 'task.read',
        recordId: world.ids['bravo'] ?? '',
      });
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    });

    it('another client in the same business: its task is refused, its stage never sent', async () => {
      expect(await factsOf(world, world.clientAViewer, world.ids['clientA'] ?? '')).toStrictEqual({
        stage: 'Awareness',
        clientSet: true,
      });
      const answer = await executeRead(world.db.app, world.alpha, world.clientAViewer.presented, {
        read: 'task.read',
        recordId: world.ids['clientB'] ?? '',
      });
      expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    });
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-2 isolation: an agent under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('tfa', `facts-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('reads its own task’s facts and nothing of another task', async () => {
      const decider = await world.decider('decider');
      const revision = async (recordId: string) => await revisionOf(world.db, recordId);
      const other = await world.asPerson(decider, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: 'another task' },
      });
      const otherId = isCommandRefusal(other) ? '' : (other.recordId ?? '');
      await world.asPerson(decider, {
        command: 'task.set_stage',
        operationId: randomUUID(),
        recordId: otherId,
        expectedRevision: await revision(otherId),
        fields: { stage: CANARY },
      });
      const picked = await world.pickUp(decider, 'the agent’s task');
      await world.asPerson(decider, {
        command: 'task.set_stage',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: await revision(picked.taskId),
        fields: { stage: 'Decision' },
      });
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const task = detailOf(own)['task'] as { stage: unknown; clientSet: unknown };
      expect([task.stage, task.clientSet]).toStrictEqual(['Decision', false]);
      expect(JSON.stringify(own)).not.toContain(CANARY);
      const across = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: otherId },
        picked.credential,
      );
      expect(isCommandRefusal(across) ? across.code : 'answered').not.toBe('answered');
      expect(JSON.stringify(across)).not.toContain(CANARY);
    });
  },
);
