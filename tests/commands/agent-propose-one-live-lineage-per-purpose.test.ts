// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent opens at most one live lineage of a purpose on a task while that
// lineage is still waiting: its gate pending and unexpired, or its approved
// work held as a reservation. A second `task.propose` that would open a new
// lineage of the same purpose is refused `TRANSITION_NOT_PERMITTED` and writes
// nothing, so a worker restarted mid-propose, or two worker copies on one
// delegation, cannot open a second gate, and a worker restarted between
// approval and apply finds its approved work instead. Another purpose, a
// lapsed gate, or a person proposing is not held to it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('agent propose, one live lineage per purpose: DATABASE_URL is unset, nothing ran.');
}

let world: AgentWorld;
let decider: Decider;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('aol', `one-lineage-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('delegating');
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

const outcome = (answer: CommandResult) => (isCommandRefusal(answer) ? answer.code : 'applied');

const detail = (answer: CommandResult): Record<string, unknown> => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return answer.detail as Record<string, unknown>;
};

const revision = async (taskId: string): Promise<number> =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [taskId],
      )
    )[0]?.revision ?? '0',
  );

const lineagesOn = async (taskId: string): Promise<number> =>
  (
    await world.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.proposal_lineages where task_id = $1`,
      [taskId],
    )
  )[0]?.n ?? 0;

/** A task of the decider's, and the agent's delegation to work it. */
const delegatedTask = async (title: string) => {
  const made = await world.asPerson(decider, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
  });
  if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
  const taskId = made.recordId ?? '';
  const credential = await world.db.app.withBusiness(world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: world.agentActorId,
      delegatePersonId: decider.personId,
      mintedByActorId: decider.actorId,
      purpose: `work_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`fixture: the mint was refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
  return { taskId, credential };
};

const proposal = async (taskId: string, purpose: string) => ({
  command: 'task.propose',
  operationId: randomUUID(),
  recordId: taskId,
  expectedRevision: await revision(taskId),
  purpose,
  maximumMinor: 1_000,
  currency: 'AUD',
  payload: { instruction: 'draft a reply' },
  step: { kind: 'compose', payload: {} },
});

describe.skipIf(serverUrl === undefined)('an agent opens one live lineage per purpose', () => {
  it('a second new lineage while the first gate waits is refused, and nothing is written', async () => {
    const { taskId, credential } = await delegatedTask('waiting gate');
    const first = await world.asAgent(await proposal(taskId, 'draft'), credential);
    expect(outcome(first)).toBe('applied');
    const second = await world.asAgent(await proposal(taskId, 'draft'), credential);
    expect(outcome(second)).toBe('TRANSITION_NOT_PERMITTED');
    expect(await lineagesOn(taskId)).toBe(1);
  });

  it('a second new lineage once the first is approved and its work held is refused', async () => {
    const { taskId, credential } = await delegatedTask('approved, not applied');
    const first = detail(await world.asAgent(await proposal(taskId, 'draft'), credential));
    const decided = await world.asPerson(decider, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: first['gateId'],
      versionId: first['versionId'],
      decision: 'approve',
      note: 'approved before the worker applied it',
    });
    expect(outcome(decided)).toBe('applied');
    const again = await world.asAgent(await proposal(taskId, 'draft'), credential);
    expect(outcome(again)).toBe('TRANSITION_NOT_PERMITTED');
    expect(await lineagesOn(taskId)).toBe(1);
  });

  it('another purpose, a lapsed gate and a person proposing each open a lineage', async () => {
    const { taskId, credential } = await delegatedTask('not held');
    const first = detail(await world.asAgent(await proposal(taskId, 'draft'), credential));
    const other = await world.asAgent(await proposal(taskId, 'review'), credential);
    expect(outcome(other)).toBe('applied');
    await world.db.admin.execute(
      `update public.gates set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [first['gateId']],
    );
    const lapsed = await world.asAgent(await proposal(taskId, 'draft'), credential);
    expect(outcome(lapsed)).toBe('applied');
    const person = [
      await world.asPerson(decider, await proposal(taskId, 'brief')),
      await world.asPerson(decider, await proposal(taskId, 'brief')),
    ];
    expect(person.map((answer) => outcome(answer))).toStrictEqual(['applied', 'applied']);
    expect(await lineagesOn(taskId)).toBe(5);
  });
});
