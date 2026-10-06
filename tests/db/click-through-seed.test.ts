// SPDX-License-Identifier: AGPL-3.0-only
//
// SR-1: the click-through seed adds made-up work on top of local-seed's cast.
// Each item is read back the way the product reads it, a second run changes
// nothing, and an unmarked database is refused before anything is written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase } from '../support/fresh-database.ts';
import {
  closeWorld,
  guardState,
  openWorld,
  pendingFor,
  readTask,
  runSeed,
  runsOf,
  SEED,
  serverUrl,
  snapshot,
  taskId,
  type World,
} from './click-through-seed.fixture.ts';

if (serverUrl === undefined) {
  console.warn('click-through-seed: DATABASE_URL is unset, so nothing below ran.');
}

const NORTH = 'Example Client North';
const SOUTH = 'Example Client South';
const EAST = 'Example Client East';
const PLAIN: readonly (readonly [string, string | null, string])[] = [
  ['Draft the spring newsletter', NORTH, 'unstarted'],
  ['Update opening hours on the website', NORTH, 'started'],
  ['Send the welcome pack', NORTH, 'completed'],
  ['Plan the client workshop', SOUTH, 'unstarted'],
  ['Order new business cards', SOUTH, 'completed'],
  ['Check last month invoices', EAST, 'started'],
  ['Write three social posts', EAST, 'completed'],
  ['Review the logo options', EAST, 'unstarted'],
  ['Book the team photo shoot', null, 'unstarted'],
  ['Tidy the shared drive', null, 'started'],
];

let world: World;

describe.skipIf(serverUrl === undefined)('SR-1 click-through seed', () => {
  beforeAll(async () => {
    world = await openWorld();
  }, 600_000);

  afterAll(async () => {
    await closeWorld(world);
  });

  taskCases();
  runCases();
  rerunCases();
});

function taskCases() {
  it('makes ten plain tasks across three made-up clients, each in its stated state', async () => {
    expect(world.first.status, world.first.out).toBe(0);
    for (const [title, client, category] of PLAIN) {
      // One task at a time, each read as Ada reads it.
      // oxlint-disable-next-line no-await-in-loop
      const id = await taskId(world, title);
      // oxlint-disable-next-line no-await-in-loop
      const task = await readTask(world, id);
      expect(task.title).toBe(title);
      expect(task.state?.machineCategory, title).toBe(category);
      // oxlint-disable-next-line no-await-in-loop
      const [held] = await world.db.admin.execute<{ name: string | null }>(
        `select c.name from public.records r left join public.clients c on c.id = r.uuid_7
          where r.id = $1`,
        [id],
      );
      expect(held?.name ?? null, title).toBe(client);
    }
  });

  it('saves one task with no title', async () => {
    const rows = await world.db.admin.execute<{ id: string }>(
      `select r.id from public.records r join public.record_types t on t.id = r.record_type_id
        where t.key = 'task' and r.business_id = $1 and r.txt_4 is null`,
      [world.business],
    );
    expect(rows).toHaveLength(1);
    expect((await readTask(world, rows[0]!.id)).title ?? null).toBeNull();
  });
}

function runCases() {
  it("leaves the worker's version 2 waiting for a person, version 1 approved", async () => {
    const awaiting = await pendingFor(world);
    for (const title of [
      'Demonstration task: draft the client update',
      'Revise the brochure copy',
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const id = await taskId(world, title);
      const versions = awaiting.filter((gate) => gate.taskId === id).map((gate) => gate.version);
      expect(versions, title).toEqual([2]);
      // oxlint-disable-next-line no-await-in-loop
      const approvals = await world.db.admin.execute<{ version: number }>(
        `select v.version from public.gate_decisions d
           join public.proposal_versions v on v.id = d.version_id
           join public.proposal_lineages l on l.id = v.lineage_id
          where l.task_id = $1 and d.decision = 'approve'`,
        [id],
      );
      expect(
        approvals.map((row) => Number(row.version)),
        title,
      ).toEqual([1]);
    }
  });

  it('finishes one run with a completed report', async () => {
    const runs = await runsOf(world, 'Summarise the meeting notes');
    expect(runs.map((run) => run.state)).toEqual(['handed_back']);
    const reports = await world.db.admin.execute<{ outcome: string }>(
      'select outcome from public.handback_reports where run_id = $1',
      [runs[0]!.id],
    );
    expect(reports).toEqual([{ outcome: 'completed' }]);
  });

  it('parks one run at its spending cap, waiting for a person', async () => {
    const runs = await runsOf(world, 'Research venue options');
    expect(runs.map((run) => run.state)).toEqual(['waiting_budget']);
    const asks = await world.db.admin.execute(
      'select 1 from public.budget_asks where run_id = $1',
      [runs[0]!.id],
    );
    expect(asks).toHaveLength(1);
  });

  unknownAndHelperCases();
}

function unknownAndHelperCases() {
  it('leaves two runs whose outcome is unknown, for the three-outcome choice', async () => {
    for (const title of ['Post the event reminder', 'Reply to the supplier']) {
      // oxlint-disable-next-line no-await-in-loop
      const attempts = await world.db.admin.execute<{ state: string; held: string }>(
        `select a.state, res.state as held from public.attempts a
           join public.reservations res on res.id = a.reservation_id
           join public.planned_runs r on r.id = a.run_id
          where r.task_id = $1 and a.state = 'liability_unknown'`,
        // oxlint-disable-next-line no-await-in-loop
        [await taskId(world, title)],
      );
      expect(attempts, title).toEqual([{ state: 'liability_unknown', held: 'held' }]);
    }
  });

  it('hands part of one run to a helper agent', async () => {
    const children = await world.db.admin.execute<{ kind: string; other: boolean }>(
      `select a.kind, parent.agent_actor_id <> child.agent_actor_id as other
         from public.delegations child
         join public.delegations parent on parent.id = child.parent_delegation_id
         join public.leases l on l.delegation_id = parent.id
         join public.planned_runs r on r.id = l.run_id
         join public.actors a on a.id = child.agent_actor_id
        where r.task_id = $1`,
      [await taskId(world, 'Collect quotes for printing')],
    );
    expect(children).toEqual([{ kind: 'agent', other: true }]);
  });
}

function rerunCases() {
  it('a second run makes nothing and changes nothing, history, audit and receipts included', () => {
    expect(world.second.status, world.second.out).toBe(0);
    expect(world.second.out).toContain('already seeded, nothing made');
    expect(world.before['records']!.length).toBeGreaterThan(20);
    expect(world.before['audit_events']!.length).toBeGreaterThan(0);
    expect(world.after).toEqual(world.before);
  });

  it('the first run leaves the made-up guard and mark as local-seed left them', () => {
    expect(world.guards[0]['functions']!.length).toBeGreaterThan(0);
    expect(world.guards[1]).toEqual(world.guards[0]);
  });

  it("the first run leaves bravo's rows untouched", () => {
    expect(world.bravo[0]['actors']!.length).toBeGreaterThan(0);
    expect(world.bravo[1]).toEqual(world.bravo[0]);
  });

  it('refuses an unmarked database and writes nothing to it, guard included', async () => {
    const bare = await createFreshDatabase({ part: 'sr1clickbare' });
    try {
      const was = [await snapshot(bare), await guardState(bare)];
      const refused = runSeed(SEED, { admin: bare, local: world.local });
      expect(refused.status, refused.out).toBe(1);
      expect(refused.out).toMatch(/click-through-seed: REFUSED, .*it carries no made-up mark/u);
      expect([await snapshot(bare), await guardState(bare)]).toEqual(was);
    } finally {
      await bare.drop();
    }
  }, 120_000);
}
