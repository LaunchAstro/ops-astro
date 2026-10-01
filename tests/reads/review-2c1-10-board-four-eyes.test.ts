// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-10, red proof, against a real database: task.board's
// `awaitingDecision` is `gated && (decides === null || decides.has(id))`
// (reads/tasks.ts), so a reader holding decide on the whole business is told
// every pending gate waits on them, including the gate on a task assigned to
// them. `task.decide` refuses that reader FOUR_EYES_REQUIRED (T2g, decide.ts),
// so the Review mode lists a gate they cannot decide. Fixed when the board
// asks the four-eyes rule too: the assignee's own gated task is not awaiting
// their decision, while another's gated task still is.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { agentWorld, codeOf, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'review-2c1-10-board-four-eyes: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

interface BoardRow {
  readonly id: string;
  readonly awaitingDecision: boolean;
}

let world: AgentWorld;
let decider: Decider;
const ids: Record<string, string> = {};
const proposals: Record<string, Readonly<Record<string, unknown>>> = {};

const revisionOf = async (recordId: string) =>
  Number(
    (
      await world.db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

const done = (
  result: Awaited<ReturnType<AgentWorld['asPerson']>>,
  what: string,
): Readonly<Record<string, unknown>> => {
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
};

const create = async (name: string) => {
  const made = done(
    await world.asPerson(decider, {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: `review 2c1 10 ${name}` },
    }),
    'task.create',
  );
  ids[name] = String(made['recordId']);
};

const propose = async (name: string) => {
  const taskId = ids[name] ?? '';
  proposals[name] = done(
    await world.asPerson(decider, {
      command: 'task.propose',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    } as Body),
    'task.propose',
  );
};

const flags = async (): Promise<Readonly<Record<string, boolean>>> => {
  const answer = await executeRead(world.db.app, world.business, decider.presented, {
    read: 'task.board',
    board: null,
  });
  if (isCommandRefusal(answer) || !('tasks' in answer)) {
    throw new Error(`task.board did not answer: ${JSON.stringify(answer)}`);
  }
  const rows = answer.tasks as unknown as readonly BoardRow[];
  return Object.fromEntries(rows.map((row) => [row.id, row.awaitingDecision]));
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('b8', `rb2c1-10-${randomUUID().slice(0, 8)}`);
  // read, write, decide and comment, each on the whole business.
  decider = await world.decider('decider');
  // And assign, so the task can be assigned to the decider through task.assign.
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, decider, 'assign');
  });
  await create('assigned');
  await create('unassigned');
  const taskId = ids['assigned'] ?? '';
  done(
    await world.asPerson(decider, {
      command: 'task.assign',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(taskId),
      fields: { assignee: decider.personId },
    }),
    'task.assign',
  );
  await propose('assigned');
  await propose('unassigned');
}, 240_000);

afterAll(async () => {
  await world?.drop();
});

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-10 awaitingDecision and four eyes', () => {
  it('REVIEW-2C1-10: a business-decide holder is not shown awaitingDecision on a pending gate of a task assigned to them, which task.decide refuses them', async () => {
    // The premise: task.decide refuses the assignee (T2g).
    const own = proposals['assigned'] ?? {};
    const refused = await world.asPerson(decider, {
      command: 'task.decide',
      operationId: randomUUID(),
      gateId: own['gateId'],
      versionId: own['versionId'],
      decision: 'reject',
      note: 'four eyes premise',
    });
    expect(codeOf(refused)).toBe('FOUR_EYES_REQUIRED');

    const seen = await flags();
    // Another's gated task still waits on this decider.
    expect(seen[ids['unassigned'] ?? '']).toBe(true);
    expect(
      seen[ids['assigned'] ?? ''],
      'awaitingDecision on a gate the reader cannot decide (four eyes)',
    ).toBe(false);
  });
});
