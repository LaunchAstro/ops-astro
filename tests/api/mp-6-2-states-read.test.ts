// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's state revision lists, read: each run of the task with its kept
// versions, newest first, on the task read's ledger (the internal reader's,
// as the token ledger is). Through the real boundary and a fresh Postgres;
// the versions are written by `run.revise_state` and read back as a person.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import {
  agentOnWork,
  asAgent,
  asPerson,
  billingHolder,
  contextOf,
  externalClient,
  signed,
  type Signed,
} from './c54-fixture.ts';

interface Run {
  readonly recordId: string;
  readonly runId: string;
}

type State = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one world, each read on it
describe.skipIf(serverUrl === undefined)('MP-6-2 state revision lists on Postgres', () => {
  let world: World;
  let ada: Signed;
  let one: Run;
  let two: Run;

  async function proposedRun(): Promise<Run> {
    const task = await contextOf(world, ada).freshTask('a run whose states are read');
    const proposed = await asPerson(world, ada, 'task.propose', {
      recordId: task.id,
      expectedRevision: task.revision,
      ...PROPOSAL,
    });
    if (proposed.code !== 'ok') throw new Error(`mp-6-2: propose refused ${proposed.code}`);
    const detail = proposed.body['detail'] as Record<string, unknown>;
    return { recordId: task.id, runId: String(detail['runId']) };
  }

  const revise = async (run: Run, expectedVersion: number, knowledge: readonly string[]) => {
    const answer = await asPerson(world, ada, 'run.revise_state', {
      recordId: run.recordId,
      runId: run.runId,
      expectedVersion,
      knowledge,
      unknowns: [`unknown at ${expectedVersion + 1}`],
    });
    if (answer.code !== 'ok') throw new Error(`mp-6-2: revise refused ${answer.code}`);
  };

  async function statesOf(who: Signed, taskId: string): Promise<readonly State[] | null> {
    const read = await asPerson(world, who, 'task.read', { recordId: taskId });
    expect(read.code, 'task.read').toBe('ok');
    const task = read.body['task'] as {
      readonly ledger: { readonly states: readonly State[] } | null;
    };
    return task.ledger === null ? null : task.ledger.states;
  }

  beforeAll(async () => {
    world = await createWorld('mp62states');
    ada = signed(world.ada);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', undefined, false, 'run');
    });
    one = await proposedRun();
    two = await proposedRun();
    await revise(one, 0, ['first knowledge']);
    await revise(one, 1, ['first knowledge', 'second knowledge']);
    await revise(two, 0, ['secret of task two']);
  }, 180_000);

  afterAll(async () => await world?.close());

  it('MP-6-2 revisions read: each kept version of the task’s runs, newest first, with its actor and time, and none before a revision', async () => {
    const states = await statesOf(ada, one.recordId);
    expect(
      states?.map((s) => [s['runId'], s['version'], s['knowledge'], s['unknowns']]),
    ).toStrictEqual([
      [one.runId, 2, ['first knowledge', 'second knowledge'], ['unknown at 2']],
      [one.runId, 1, ['first knowledge'], ['unknown at 1']],
    ]);
    expect(states?.[0]?.['revisedBy']).toStrictEqual({ actorId: ada.actorId });
    expect(Number.isNaN(Date.parse(String(states?.[0]?.['revisedAt'])))).toBe(false);
    const fresh = await proposedRun();
    expect(await statesOf(ada, fresh.recordId)).toStrictEqual([]);
  });

  it('MP-6-2 isolation read: a task reads only its own runs’ states; another business, another client and another person’s agent read none of them', async () => {
    const secret = 'secret of task two';
    expect(JSON.stringify(await statesOf(ada, one.recordId))).not.toContain(secret);
    // Another business: bravo's member names alpha's task.
    const bravo = await billingHolder(world, world.bravo, 'bravo', 'mp62-states-bravo');
    const foreign = await asPerson(world, bravo, 'task.read', { recordId: two.recordId });
    const madeUp = await asPerson(world, bravo, 'task.read', { recordId: randomUUID() });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toStrictEqual(madeUp.body);
    // Another client, on the one task shared with them: no ledger, so no states.
    const client = await externalClient(world, ada, one.recordId);
    const shared = await asPerson(world, client, 'task.read', { recordId: one.recordId });
    expect(shared.code).toBe('ok');
    expect(JSON.stringify(shared.body)).not.toContain('"states"');
    expect(JSON.stringify(shared.body)).not.toContain('first knowledge');
    const theirs = await asPerson(world, client, 'task.read', { recordId: two.recordId });
    expect(theirs.status).toBeGreaterThanOrEqual(403);
    // Another person under a live delegation: the agent on ada's other work.
    const agent = await agentOnWork(world, ada);
    const delegated = await asAgent(
      world,
      'task.read',
      { recordId: two.recordId },
      agent.credential,
    );
    expect(delegated.status).toBe(403);
    for (const answer of [foreign, theirs, delegated]) {
      expect(JSON.stringify(answer.body)).not.toContain(secret);
      expect(JSON.stringify(answer.body)).not.toContain(two.runId);
    }
  });
});
