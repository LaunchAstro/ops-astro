// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-1's filter chips need two facts on each to-do (XC 7, XC 10): the
// task's category as `task.set_category` stored it, and whose move it is.
// Whose move is derived as the task page derives it (DP-14): Review while a
// gate on the task waits on a person, Agent while an agent holds a live
// lease on it, Team otherwise. Read through `task.todos` against a real
// database.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { agentWorld, type AgentWorld, type Decider } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { TaskTodosResult, TodoView } from '../../packages/core-wire/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-todos-move-and-category: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Body = Readonly<Record<string, unknown>>;

let world: AgentWorld;
let reader: Decider;
/** A second person: four eyes keep the reader from deciding a gate on their own task. */
let other: Decider;
const ids: Record<string, string> = {};

async function revisionOf(recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where id = $1',
    [recordId],
  );
  return Number(rows[0]?.revision);
}

async function applied(
  body: Body,
  what: string,
  by: Decider = reader,
): Promise<Record<string, unknown>> {
  const result = await world.asPerson(by, { operationId: randomUUID(), ...body });
  if (isCommandRefusal(result)) throw new Error(`${what} refused ${result.code}`);
  return { ...(result.detail as Record<string, unknown>), recordId: result.recordId };
}

async function created(title: string): Promise<string> {
  const made = await applied({ command: 'task.create', fields: { title } }, 'task.create');
  return String(made['recordId']);
}

async function assigned(recordId: string): Promise<void> {
  await applied(
    {
      command: 'task.assign',
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: { assignee: reader.personId },
    },
    'task.assign',
  );
}

/** Opens a gate on the task: its run waits for a person's decision. */
async function proposeOn(recordId: string | undefined): Promise<void> {
  await applied(
    {
      command: 'task.propose',
      recordId,
      expectedRevision: await revisionOf(recordId ?? ''),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    },
    'task.propose',
  );
}

async function todos(): Promise<ReadonlyMap<string, TodoView>> {
  const answer = await executeRead(world.db.app, world.business, reader.presented, {
    read: 'task.todos',
  } as never);
  if (isCommandRefusal(answer)) throw new Error(`task.todos refused ${answer.code}`);
  const rows = (answer as unknown as TaskTodosResult).todos;
  return new Map(rows.map((row) => [row.id, row]));
}

const live = describe.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await agentWorld('b9', `todos-move-${randomUUID().slice(0, 8)}`);
  reader = await world.decider('reader');
  other = await world.decider('other');
  await world.db.app.withBusiness(world.business, async (tx) => {
    await grantTo(tx, reader, 'assign');
  });
  ids['gated'] = await created('waits on a person');
  await proposeOn(ids['gated']);
  ids['leased'] = (await world.pickUp(reader, 'an agent holds it')).taskId;
  // A gate waiting beside a live lease: the person's move comes first.
  ids['both'] = (await world.pickUp(reader, 'held, and a new gate waits')).taskId;
  await proposeOn(ids['both']);
  // A pending gate past its expiry waits on nobody.
  ids['lapsed'] = await created('its gate expired');
  await proposeOn(ids['lapsed']);
  await world.db.admin.execute(
    `update public.gates g set expires_at = now() - interval '1 minute'
       from public.planned_runs run
      where run.business_id = g.business_id and run.id = g.run_id and run.task_id = $1`,
    [ids['lapsed']],
  );
  // A lease no longer live holds nothing.
  ids['released'] = (await world.pickUp(reader, 'its agent let go')).taskId;
  await world.db.admin.execute(
    `update public.leases set state = 'released', released_at = now() where task_id = $1`,
    [ids['released']],
  );
  ids['plain'] = await created('nobody else holds it');
  await applied(
    {
      command: 'task.set_category',
      recordId: ids['plain'],
      expectedRevision: await revisionOf(ids['plain']),
      fields: { category: 'seo' },
    },
    'task.set_category',
  );
  for (const name of ['gated', 'leased', 'both', 'lapsed', 'released', 'plain']) {
    // eslint-disable-next-line no-await-in-loop -- each assign reads the revision it writes at
    await assigned(ids[name] ?? '');
  }
}, 180_000);

afterAll(async () => {
  await world?.drop();
});

live('task.todos whose move (DP-14)', () => {
  it('Review while a gate waits, Agent while a lease is live, Team otherwise', async () => {
    const rows = await todos();
    expect(
      ['gated', 'leased', 'plain'].map((name) => rows.get(ids[name] ?? '')?.whoseMove),
    ).toStrictEqual(['Review', 'Agent', 'Team']);
  });

  it('a gate waiting beside a live lease is the person’s move', async () => {
    expect((await todos()).get(ids['both'] ?? '')?.whoseMove).toBe('Review');
  });

  it('an expired gate and a released lease leave the move with the team', async () => {
    const rows = await todos();
    expect(
      ['lapsed', 'released'].map((name) => rows.get(ids[name] ?? '')?.whoseMove),
    ).toStrictEqual(['Team', 'Team']);
  });

  it('a decided gate leaves the move with the team', async () => {
    const gate = await world.db.admin.execute<{ readonly id: string; readonly version_id: string }>(
      `select g.id, g.version_id from public.gates g
         join public.planned_runs run on run.business_id = g.business_id and run.id = g.run_id
        where run.task_id = $1 and g.state = 'pending'`,
      [ids['gated']],
    );
    await applied(
      {
        command: 'task.decide',
        gateId: gate[0]?.id,
        versionId: gate[0]?.version_id,
        decision: 'reject',
        note: 'not this one',
      },
      'task.decide',
      other,
    );
    expect((await todos()).get(ids['gated'] ?? '')?.whoseMove).toBe('Team');
  });
});

live('task.todos category (CS-4.16)', () => {
  it('carries the stored category, and null for none', async () => {
    const rows = await todos();
    expect(rows.get(ids['plain'] ?? '')?.category).toBe('seo');
    expect(rows.get(ids['leased'] ?? '')?.category).toBeNull();
  });
});
