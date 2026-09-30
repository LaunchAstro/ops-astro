// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4: a gate step has no checkbox, read against a real database.
//
// A step waits at a gate when a gate on its live proposal version is pending
// and not expired (MP-5-11's `awaitingApproval`), so `task.read` marks each
// step it sends with `awaitingApproval`, and the page draws that step with a
// note instead of a tick (`tests/web/mp-4-4-subtasks.test.tsx`). The question
// is asked only of the steps the reader is sent: a gate on a step they cannot
// read is never read, and neither its id nor its gate reaches them
// (`MP-4-4 isolation`, three crossings).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { agentWorld, detailOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import type { StepView } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'mp-4-4-gate-step: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

const CANARY = `canary-${randomUUID()}`;

let world: AgentWorld;
let decider: Decider;
let pair: Member;
let bravo: BusinessId;
let bravoOwner: Member;
const ids: Record<string, string> = {};
const gates: Record<string, string> = {};

const id = (name: string): string => ids[name] ?? `missing-${name}`;

const done = (result: Awaited<ReturnType<AgentWorld['asPerson']>>, what: string): Body => {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
};

const create = async (name: string, title: string, parentId?: string) => {
  const made = await world.asPerson(decider, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title },
    ...(parentId === undefined ? {} : { parentId }),
  });
  ids[name] = String(done(made, 'task.create')['recordId']);
};

/** Opens a gate on the step: its run waits for approval. */
const propose = async (name: string) => {
  const stored = await world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [id(name)],
  );
  const proposed = done(
    await world.asPerson(decider, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: id(name),
      expectedRevision: Number(stored[0]?.revision),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    } as Body),
    'task.propose',
  );
  gates[name] = String(proposed['gateId']);
  return String(proposed['versionId']);
};

const readTask = async (business: BusinessId, member: Member, recordId: string) =>
  await executeRead(world.db.app, business, member.presented, { read: 'task.read', recordId });

const stepsOf = async (member: Member) => {
  const answer = await readTask(world.business, member, id('parent'));
  if (isCommandRefusal(answer) || !('task' in answer)) {
    throw new Error(`task.read did not answer a task: ${JSON.stringify(answer)}`);
  }
  const steps: readonly StepView[] = answer.task.steps;
  return { steps, text: JSON.stringify(answer) };
};

const marks = (steps: readonly StepView[]) =>
  Object.fromEntries(steps.map((step) => [step.id, step.awaitingApproval]));

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('b9', `mp44-gate-${randomUUID().slice(0, 8)}`);
  decider = await world.decider('decider');
  pair = await enrol(world.db.app, world.business, 'pair');
  await create('parent', 'Launch the site');
  await create('gated', 'Send the draft', id('parent'));
  await create('quiet', 'Check the forms', id('parent'));
  await create('decided', 'Old draft', id('parent'));
  await create('lapsed', 'Lapsed draft', id('parent'));
  await create('hidden', CANARY, id('parent'));
  const versions: Record<string, string> = {};
  for (const name of ['gated', 'decided', 'lapsed', 'hidden']) {
    // eslint-disable-next-line no-await-in-loop -- each proposal reads the revision the last one left
    versions[name] = await propose(name);
  }
  done(
    await world.asPerson(decider, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: gates['decided'],
      versionId: versions['decided'],
      decision: 'reject',
      note: 'not this one',
    }),
    'task.decide',
  );
  await world.db.admin.execute(
    `update public.gates set expires_at = now() - interval '1 minute' where id = $1`,
    [gates['lapsed']],
  );
  await world.db.app.withBusiness(world.business, async (tx) => {
    // Reads the parent and two of its steps, one of them at a gate.
    for (const name of ['parent', 'gated', 'quiet']) {
      // eslint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, pair, 'read', { kind: 'record', id: id(name) });
    }
  });
  bravo = (await insertBusiness(
    world.db.app,
    `mp44-gate-bravo-${randomUUID().slice(0, 8)}`,
  )) as BusinessId;
  await installSpine(world.db.app, bravo);
  bravoOwner = await enrol(world.db.app, bravo, 'bravo-owner');
  await world.db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoOwner, 'read');
  });
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('MP-4-4 gate step no checkbox', () => {
  it('task.read marks the step whose gate waits, and no step whose gate is decided, expired or absent', async () => {
    const { steps } = await stepsOf(decider);
    expect(marks(steps)).toStrictEqual({
      [id('gated')]: true,
      [id('quiet')]: false,
      [id('decided')]: false,
      [id('lapsed')]: false,
      [id('hidden')]: true,
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-4 isolation', () => {
  it('another client in the same business: a reader of two steps is marked only on those, shown no other gate', async () => {
    const { steps, text } = await stepsOf(pair);
    expect(marks(steps)).toStrictEqual({ [id('gated')]: true, [id('quiet')]: false });
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(id('hidden'));
    expect(text).not.toContain(gates['hidden'] ?? 'none');
    expect(text).not.toContain(gates['gated'] ?? 'none');
  });

  it('another business: its reader is refused the parent, shown no step, mark or gate', async () => {
    const crossing = await readTask(world.business, bravoOwner, id('parent'));
    expect(isCommandRefusal(crossing) ? crossing.code : 'answered').toBe('AUTH_NO_MEMBERSHIP');
    const across = await readTask(bravo, bravoOwner, id('parent'));
    expect(isCommandRefusal(across) ? across.code : 'answered').toBe('NOT_FOUND');
    const text = JSON.stringify([crossing, across]);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(id('gated'));
    expect(text).not.toContain('awaitingApproval');
  });

  it('another person under a live delegation: the agent is sent no step and no mark of its task', async () => {
    const picked = await world.pickUp(decider, 'the agent’s task');
    await create('agentStep', CANARY, picked.taskId);
    await propose('agentStep');
    const own = await world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: picked.taskId },
      picked.credential,
    );
    const task = detailOf(own)['task'] as { steps: unknown };
    expect(task.steps).toStrictEqual([]);
    const text = JSON.stringify(own);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(id('agentStep'));
    expect(text).not.toContain(gates['agentStep'] ?? 'none');
  });
});
