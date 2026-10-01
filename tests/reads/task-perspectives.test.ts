// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-3 isolation: the Team and Agent counts are worked out from one task's
// own `task.read`, against a real database. A gate open on another task, on
// another client's task or in another business is never counted, and each
// crossing reads every body for a canary title planted where the reader may
// not look.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { ProposalView } from '../../packages/core-wire/src/index.ts';
import { perspectiveCounts } from '../../apps/web/src/screens/task/perspective-counts.ts';
import { agentWorld, detailOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-perspectives: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const CANARY = `canary-${randomUUID()}`;

type Body = Readonly<Record<string, unknown>>;

const recordOf = (answer: unknown): string =>
  isCommandRefusal(answer as never)
    ? ''
    : String((answer as { readonly recordId?: unknown }).recordId ?? '');

const agentOf = (proposals: readonly ProposalView[]): number =>
  perspectiveCounts({ steps: [], proposals, stagedOutput: false }).agent;

let world: AgentWorld;
let decider: Decider;
let viewer: Member;
let bravoTask = '';
const ids: Record<string, string> = {};

const revision = async (recordId: string): Promise<number> => {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return Number(rows[0]?.revision);
};

const person = async (body: Body): Promise<Record<string, unknown>> => {
  const answer = await world.asPerson(decider, { operationId: randomUUID(), ...body });
  if (isCommandRefusal(answer))
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  return { ...detailOf(answer), recordId: answer.recordId };
};

/** A task under `client`, with one open gate when `gated` whose instruction is the title. */
const make = async (title: string, client: string, gated: boolean): Promise<string> => {
  const recordId = recordOf(await person({ command: 'task.create', fields: { title } }));
  await person({
    command: 'task.set_party',
    recordId,
    expectedRevision: await revision(recordId),
    fields: { client },
  });
  if (gated) {
    await person({
      command: 'task.propose',
      recordId,
      expectedRevision: await revision(recordId),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 1_000,
      currency: 'AUD',
      payload: { instruction: title },
      step: { kind: 'compose', payload: {} },
    });
  }
  return recordId;
};

const read = async (member: Member, recordId: string) =>
  await executeRead(world.db.app, world.business, member.presented, {
    read: 'task.read',
    recordId,
  });

const agentCount = async (member: Member, recordId: string): Promise<number> => {
  const answer = await read(member, recordId);
  if (isCommandRefusal(answer) || !('task' in answer)) {
    throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
  }
  return agentOf(answer.task.proposals ?? []);
};

/** One business with three tasks and a client A viewer, and a second business. */
async function seed(): Promise<void> {
  world = await agentWorld('tpv', `perspectives-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('decider');
  // `task.set_party` moves who may see the task, so it is a share.
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'share');
  });
  ids['clientA'] = await make('client A task', randomUUID(), true);
  ids['clientB'] = await make(CANARY, randomUUID(), true);
  ids['quiet'] = await make('a task with nothing open', randomUUID(), false);
  viewer = await enrol(world.db.app, world.business, 'client-a-viewer');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, viewer, 'read', { kind: 'record', id: ids['clientA'] ?? '' });
  });
  const bravo = (await insertBusiness(
    world.db.app,
    `bravo-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  const bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoOwner, 'read');
    await grantTo(tx, bravoOwner, 'write');
  });
  const made = await executeCommand(world.db.app, bravo, bravoOwner.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: CANARY },
  } as never);
  bravoTask = recordOf(made);
}

// One world for both suites below: seeded once, dropped once.
beforeAll(async () => {
  if (serverUrl !== undefined) await seed();
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-3 isolation', () => {
  it('the count is the task’s own: an open gate on another task is not counted', async () => {
    expect(await agentCount(decider, ids['clientA'] ?? '')).toBe(1);
    expect(await agentCount(decider, ids['quiet'] ?? '')).toBe(0);
  });

  it('another business: its task is not found and its title never appears', async () => {
    expect(bravoTask).not.toBe('');
    const answer = await read(decider, bravoTask);
    expect(isCommandRefusal(answer) ? answer.code : 'answered').toBe('NOT_FOUND');
    expect(JSON.stringify(answer)).not.toContain(CANARY);
  });

  it('another client in the same business: its task and its gate are refused, never counted', async () => {
    const own = await read(viewer, ids['clientA'] ?? '');
    if (isCommandRefusal(own) || !('task' in own)) throw new Error('client A task not answered');
    expect(agentOf(own.task.proposals ?? [])).toBe(1);
    expect(JSON.stringify(own)).not.toContain(CANARY);
    const across = await read(viewer, ids['clientB'] ?? '');
    expect(isCommandRefusal(across) ? across.code : 'answered').toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(across)).not.toContain(CANARY);
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-3 isolation: an agent under a live delegation',
  () => {
    it('an agent under a live delegation counts its own task and reads nothing of another', async () => {
      const picked = await world.pickUp(decider, 'the agent’s task');
      const own = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
        picked.credential,
      );
      const task = detailOf(own)['task'] as { readonly proposals?: readonly ProposalView[] };
      // Its one gate was approved so it could pick the task up: nothing is open.
      expect(agentOf(task.proposals ?? [])).toBe(0);
      expect(JSON.stringify(own)).not.toContain(CANARY);
      const across = await world.asAgent(
        { command: 'task.read', operationId: randomUUID(), recordId: ids['clientB'] ?? '' },
        picked.credential,
      );
      expect(isCommandRefusal(across) ? across.code : 'answered').not.toBe('answered');
      expect(JSON.stringify(across)).not.toContain(CANARY);
    });
  },
);
