// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Permissions table: `task.assignee changed` is `task:assign`, and an
// agent may hold it "inside its delegation". So an agent whose delegation
// holds assign on its task sets that task's assignee; one whose delegation
// does not (a pickup mints read, comment and write) is refused; the delegate
// is not in its reach; and another person's task gains nothing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { agentWorld, codeOf, type AgentWorld, type Decider } from './agent-fixture.ts';
import { enrol, grantTo } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task-assign-agent: DATABASE_URL is unset, so nothing below ran.');
}

const CANARY = `canary-${randomUUID()}`;
let world: AgentWorld;

beforeAll(async () => {
  if (serverUrl !== undefined)
    world = await agentWorld('aa', `assign-agent-${randomUUID().slice(0, 8)}`);
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

const assigneeOf = async (recordId: string): Promise<string | null | undefined> =>
  (
    await world.db.admin.execute<{ readonly assignee: string | null }>(
      `select uuid_2::text as assignee from public.records where id = $1`,
      [recordId],
    )
  )[0]?.assignee;

const revision = async (recordId: string): Promise<number> =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision ?? '0',
  );

const created = async (by: Decider, title: string): Promise<string> => {
  const answer = await world.asPerson(by, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  });
  return isCommandRefusal(answer) ? '' : (answer.recordId ?? '');
};

/** A delegation holding assign as well as read and write, on one task. */
const assigning = async (by: Decider, taskId: string): Promise<string> =>
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, by, 'assign');
    const minted = await mintDelegation(tx, {
      agentActorId: world.agentActorId,
      delegatePersonId: by.personId,
      mintedByActorId: by.actorId,
      purpose: `assign_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'write', 'assign'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`fixture: the mint was refused ${minted.refusal.code}`);
    return minted.value.credential;
  });

const assign = async (recordId: string, fields: Record<string, unknown>, credential: string) =>
  await world.asAgent(
    {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId,
      expectedRevision: await revision(recordId),
      fields,
    },
    credential,
  );

describe.skipIf(serverUrl === undefined)('MP-4-8 an agent’s assign keeps one kind', () => {
  it('an agent assigning a person clears the prior agent holder', async () => {
    const decider = await world.decider('sol-dual-holder');
    const taskId = await created(decider, 'Sol dual holder');
    const credential = await assigning(decider, taskId);
    const rows = await world.db.admin.execute<{ readonly id: string }>(
      `select id from public.delegations where business_id = $1 and purpose_scope_id = $2`,
      [world.business, taskId],
    );
    const agent = rows[0]?.id;
    if (agent === undefined) throw new Error('Sol proof: no delegation was minted');
    const byPerson = await world.asPerson(decider, {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revision(taskId),
      fields: { agent },
    });
    expect(codeOf(byPerson)).toBe('not-a-refusal');
    expect(codeOf(await assign(taskId, { assignee: decider.personId }, credential))).toBe(
      'not-a-refusal',
    );
    const held = await world.db.admin.execute<{
      readonly agent: string | null;
      readonly person: string | null;
    }>(
      `select data ->> 'agent' as agent, uuid_2::text as person from public.records where id = $1`,
      [taskId],
    );
    expect(held[0]).toStrictEqual({ agent: null, person: decider.personId });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 agent assigns inside its delegation', () => {
  it('a delegation holding assign sets its own task’s assignee, and it reads back', async () => {
    const decider = await world.decider('decider-assign');
    const taskId = await created(decider, 'the agent’s task');
    const credential = await assigning(decider, taskId);
    const answer = await assign(taskId, { assignee: decider.personId }, credential);
    expect(codeOf(answer)).toBe('not-a-refusal');
    expect(await assigneeOf(taskId)).toBe(decider.personId);
    const unassigned = await assign(taskId, { assignee: null }, credential);
    expect(codeOf(unassigned)).toBe('not-a-refusal');
    expect(await assigneeOf(taskId)).toBeNull();
  });

  it('a delegation without assign is refused, and nothing is written', async () => {
    const decider = await world.decider('decider-pickup');
    const picked = await world.pickUp(decider, 'picked up, write only');
    const answer = await assign(picked.taskId, { assignee: decider.personId }, picked.credential);
    expect(codeOf(answer)).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await assigneeOf(picked.taskId)).toBeNull();
  });

  it('the delegate is outside its reach, refused by name, and a mixed body writes nothing', async () => {
    const decider = await world.decider('decider-delegate');
    const taskId = await created(decider, 'delegate stays');
    const credential = await assigning(decider, taskId);
    const answers = [
      await assign(taskId, { delegate: decider.personId }, credential),
      await assign(taskId, { assignee: decider.personId, delegate: decider.personId }, credential),
    ];
    expect(
      answers.map((answer) => (isCommandRefusal(answer) ? [answer.code, answer.names] : 'applied')),
    ).toStrictEqual([
      ['SCOPE_NOT_GRANTED', ['delegate']],
      ['SCOPE_NOT_GRANTED', ['delegate']],
    ]);
    expect(await assigneeOf(taskId)).toBeNull();
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-8 isolation', () => {
  it('agent task.assign, another person’s task under a live delegation: refused, no canary, assignee unchanged', async () => {
    const decider = await world.decider('decider-own');
    const other = await world.decider('decider-other');
    const ownId = await created(decider, 'own task');
    const otherId = await created(other, CANARY);
    const credential = await assigning(decider, ownId);
    const stranger = await enrol(world.db.app, world.business, 'no-assign');
    const foreign = [
      await assign(otherId, { assignee: decider.personId }, credential),
      await assign(otherId, { assignee: stranger.personId }, credential),
    ];
    for (const answer of foreign) expect(codeOf(answer)).not.toBe('not-a-refusal');
    expect(JSON.stringify(foreign)).not.toContain(CANARY);
    expect(await assigneeOf(otherId)).toBeNull();
  });
});
