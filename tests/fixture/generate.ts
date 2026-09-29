// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a: the fixture generator. Test tooling, never shipped.
//
// It seeds SPEC 10.1's shape into an **empty** database. Every record,
// comment, proposal, decision, pickup, hand-back and trash batch goes through
// the real command entries, so a row here is a row the product wrote; the
// people and grants no command issues come from `cast.ts`. A database with
// any business in it is refused, never topped up: a fixture on top of a
// previous run's rows is not the fixture.
//
// Every write is sequential on purpose: each command takes the business's
// audit-chain lock (RN-09), so parallel callers only queue.
/* eslint-disable no-await-in-loop */

import { randomUUID } from 'node:crypto';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type {
  CommandHandle,
  CommandResult,
} from '../../packages/core-commands/src/commands/register-store.ts';
import { approveBody, handbackBody, proposeBody } from '../runtime/schedules-harness.ts';
import {
  agentOf,
  client,
  grantOn,
  presetFields,
  refused,
  tenant,
  type Seedable,
  type Tenant,
} from './cast.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import type { FixtureShape } from './shape.ts';

type Detail = Readonly<Record<string, unknown>>;

export interface FixtureReport {
  readonly board: string;
  readonly recordGrantTask: string;
  readonly slots: { readonly assigned: number; readonly total: number };
  readonly people: { readonly alpha: readonly string[]; readonly bravo: readonly string[] };
  readonly seedMs: number;
  /** Who the isolation cases read as: a client sees its own shared task only. */
  readonly callers: {
    readonly alpha: BusinessId;
    readonly bravo: BusinessId;
    readonly bravoLead: VerifiedSubject;
    readonly r4: VerifiedSubject;
    readonly clients: readonly {
      readonly business: BusinessId;
      readonly presented: VerifiedSubject;
      readonly task: string;
    }[];
  };
  /** SPEC 10.1 rows this base cannot hold yet (run events wait on T2a's table). */
  readonly heldBack: readonly string[];
}

function applied(result: CommandResult, what: unknown): CommandHandle {
  return isCommandRefusal(result) ? refused(String(what), result.code) : result;
}

async function command(db: Seedable, t: Tenant, body: Detail): Promise<CommandHandle> {
  const request = { operationId: randomUUID(), ...body };
  const result = await executeCommand(db.app, t.id, t.lead.presented, 'api', request as never);
  return applied(result, body['command']);
}

async function create(db: Seedable, t: Tenant, title: string, place: Detail = {}) {
  const made = await command(db, t, { command: 'task.create', fields: { title }, ...place });
  return made.recordId ?? refused('task.create', 'NO_RECORD');
}

async function revisionOf(db: Seedable, recordId: string): Promise<number> {
  const [found] = await db.admin.execute<{ n: string }>(
    'select revision::text n from public.records where id = $1',
    [recordId],
  );
  return Number(found?.n);
}

/** A command on one task at its current revision. */
async function onTask(db: Seedable, t: Tenant, recordId: string, body: Detail) {
  return await command(db, t, {
    ...body,
    recordId,
    expectedRevision: await revisionOf(db, recordId),
  });
}

async function refuseUnlessEmpty(db: Seedable): Promise<void> {
  const found = await db.admin.execute<{ n: string }>(
    `select case when to_regclass('public.businesses') is null then -1
                 else (select count(*) from public.businesses) end::text n`,
  );
  const n = Number(found[0]?.n);
  if (n < 0) throw new Error('fixture: DATABASE_NOT_MIGRATED, run the migrations first');
  if (n > 0) throw new Error(`fixture: DATABASE_NOT_EMPTY, ${String(n)} business(es) here`);
}

interface Tree {
  readonly board: string;
  /** The subtree the trash takes, and the part of it trashed first. */
  readonly root: string;
  readonly early: string;
  /** Live top-level tasks on the board, for threads, lineages and runs. */
  readonly rest: readonly string[];
}

/** The board, its sections, the three subtask levels and the trash subtree. */
async function seedTasks(db: Seedable, t: Tenant, shape: FixtureShape): Promise<Tree> {
  const { batch, earlier } = shape.trash;
  const spare = shape.withGrandparent - (earlier - 1);
  const plain = shape.withParent - batch - earlier - spare;
  const topLevel = shape.tasksA - shape.withParent;
  if (spare < 0 || plain < 0 || topLevel < 4 + shape.lineages.total + shape.runs) {
    refused('shape', 'SHAPE_INCONSISTENT');
  }
  const board = await create(db, t, 'Fixture board');
  const sections = Array.from({ length: shape.sections }, () => randomUUID());
  const tops: string[] = [];
  for (let i = 0; i < topLevel - 1; i += 1) {
    const boardSection = sections[i % sections.length];
    tops.push(await create(db, t, `A task ${String(i)}`, { board, boardSection }));
  }
  const under = async (parentId: string, title: string) => await create(db, t, title, { parentId });
  const [root, mid, ...rest] = tops as [string, string, ...string[]];
  const early = await under(root, 'Trashed first');
  for (let i = 0; i < earlier - 1; i += 1) await under(early, `Early ${String(i)}`);
  for (let i = 0; i < batch - 1; i += 1) await under(root, `Trashed ${String(i)}`);
  const middle = await under(mid, 'Middle');
  for (let i = 0; i < spare; i += 1) await under(middle, `Grandchild ${String(i)}`);
  for (let i = 0; i < plain; i += 1) await under(rest[i % rest.length] ?? mid, `Sub ${String(i)}`);
  return { board, root, early, rest };
}

/** One hot thread, then threads of the ceiling until the comments run out. */
function threads(shape: FixtureShape, targets: number): number[] {
  const { comments, hotThread, threadCeiling: most } = shape;
  const left = comments - hotThread;
  if (left > (targets - 1) * most) refused('shape', 'COMMENTS_EXCEED_THREADS');
  const rest = Array.from({ length: targets - 1 }, (_, i) => Math.min(most, left - i * most));
  return [hotThread, ...rest.map((n) => Math.max(0, n))];
}

async function seedThreads(db: Seedable, t: Tenant, shape: FixtureShape, rest: readonly string[]) {
  for (const [i, n] of threads(shape, rest.length).entries()) {
    for (let c = 0; c < n; c += 1) {
      const body = { command: 'task.comment', body: `Note ${String(c)}`, audience: 'internal' };
      await onTask(db, t, rest[i] ?? '', body);
    }
  }
}

async function propose(db: Seedable, t: Tenant, recordId: string, options: Detail = {}) {
  const body = proposeBody(recordId, await revisionOf(db, recordId), options);
  return (await command(db, t, body)).detail;
}

/** Lineages of one, two and three versions, then runs picked up and handed back. */
async function seedRuntime(db: Seedable, t: Tenant, shape: FixtureShape, rest: readonly string[]) {
  const { total, twoVersions, threeVersions } = shape.lineages;
  for (let i = 0; i < total; i += 1) {
    const recordId = rest[i] ?? refused('lineage', 'NO_TASK');
    const first = await propose(db, t, recordId);
    const more = i < threeVersions ? 2 : i < threeVersions + twoVersions ? 1 : 0;
    const lineageId = first['lineageId'];
    for (let v = 0; v < more; v += 1) await propose(db, t, recordId, { lineageId });
  }
  const agent = await agentOf(db, t);
  for (let i = 0; i < shape.runs; i += 1) {
    const recordId = rest[total + i] ?? refused('run', 'NO_TASK');
    const proposal = await propose(db, t, recordId, { purpose: `fixture_run_${String(i)}` });
    const decision = (await command(db, t, approveBody(proposal))).detail;
    const reservationId = decision['reservationId'];
    const pickup = {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId,
      leaseSeconds: 600,
    };
    const picked = applied(
      await executeAgentCommand(db.app, t.id, agent, undefined, pickup as never),
      'task.pickup',
    ).detail;
    const credential = String(picked['credential']);
    const back = handbackBody(picked) as never;
    applied(await executeAgentCommand(db.app, t.id, agent, credential, back), 'task.handback');
  }
}

/** Each run's share of the events: one holds `heldRunShare`, the rest split evenly. */
function eventTargets(shape: FixtureShape, runs: number): number[] {
  const held = Math.round(shape.runEvents * shape.heldRunShare);
  const rest = shape.runEvents - held;
  const each = Array.from(
    { length: runs - 1 },
    (_, i) => Math.floor(rest / (runs - 1)) + (i < rest % (runs - 1) ? 1 : 0),
  );
  return [held, ...each];
}

/**
 * The steps past each version's one, planned before the pack is rendered.
 * The command writes a version's step 1, renders its evidence from the steps
 * the run holds, and binds the gate to that pack, all in one transaction; so
 * this fixture-only trigger, on the admin connection and dropped again at
 * once, adds a run's further steps the moment step 1 lands. Every proposal
 * row stays the command's, and nothing is written after a decision.
 */
async function withPlannedSteps(
  db: Seedable,
  shape: FixtureShape,
  runTasks: readonly string[],
  seed: () => Promise<void>,
): Promise<void> {
  const { total, twoVersions, threeVersions } = shape.lineages;
  const extra = shape.steps - (total + twoVersions + 2 * threeVersions + runTasks.length);
  if (extra < 0) refused('shape', 'STEPS_BELOW_THE_COMMANDS');
  const perTask = runTasks.map(
    (_, i) => Math.floor(extra / runTasks.length) + (i < extra % runTasks.length ? 1 : 0),
  );
  for (const statement of [
    'create table public.fixture_steps (task_id uuid primary key, extra int not null)',
    'grant select on public.fixture_steps to ops_astro_app',
    `create function public.fixture_steps() returns trigger language plpgsql as $$ begin
       if new.ordinal = 1 then
         insert into public.planned_steps (business_id, id, run_id, ordinal, kind, payload)
         select new.business_id, gen_random_uuid(), new.run_id, 1 + g, 'compose', '{}'::jsonb
           from public.planned_runs r join public.fixture_steps x on x.task_id = r.task_id
          cross join generate_series(1, x.extra) g
          where r.business_id = new.business_id and r.id = new.run_id;
       end if;
       return new;
     end $$`,
    'grant execute on function public.fixture_steps() to ops_astro_app',
    `create trigger fixture_steps after insert on public.planned_steps
       for each row execute function public.fixture_steps()`,
  ]) {
    await db.admin.execute(statement);
  }
  try {
    await db.admin.execute(
      'insert into public.fixture_steps select * from unnest($1::uuid[], $2::int[])',
      [runTasks, perTask],
    );
    await seed();
  } finally {
    await db.admin.execute('drop trigger if exists fixture_steps on public.planned_steps');
    await db.admin.execute('drop function if exists public.fixture_steps()');
    await db.admin.execute('drop table if exists public.fixture_steps');
  }
  const [steps] = await db.admin.execute<{ n: string }>(
    'select count(*)::text n from public.planned_steps',
  );
  if (Number(steps?.n) !== shape.steps) refused('load', 'STEPS_NOT_AS_ASKED');
}

/**
 * The events past each run's command-written pair, through the records layer
 * on the admin connection (no command writes them; see `shape.ts`), checked
 * against the shape. Returns what it could not seed: without T2a's table on
 * the base, the events.
 */
async function seedEvents(db: Seedable, t: Tenant, shape: FixtureShape): Promise<string[]> {
  const [table] = await db.admin.execute<{ present: boolean }>(
    `select to_regclass('public.run_events') is not null present`,
  );
  if (table?.present !== true) return ['run events: T2a (#97) is not on this base'];
  const runs = (
    await db.admin.execute<{ run: string }>(
      'select run_id::text run from public.attempts where business_id = $1 order by run_id',
      [t.id],
    )
  ).map((row) => row.run);
  const targets = eventTargets(shape, runs.length);
  if (targets.some((n) => n < 2)) refused('shape', 'EVENTS_BELOW_THE_COMMANDS');
  await db.admin.execute(
    `insert into public.run_events
       (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
     select e.business_id, gen_random_uuid(), e.run_id, e.task_id, e.top + g,
            case when g % 2 = 1 then 'claimed' else 'handed_back' end,
            e.lease_id, e.attempt_id, e.actor_id, '{"seeded":"fixture"}'::jsonb
       from (select business_id, run_id, task_id, lease_id, attempt_id, actor_id,
                    max(position) top
               from public.run_events where business_id = $1
              group by business_id, run_id, task_id, lease_id, attempt_id, actor_id) e
       join unnest($2::uuid[], $3::int[]) x(run, extra) on x.run = e.run_id
      cross join lateral generate_series(1, x.extra) g`,
    [t.id, runs, targets.map((n) => n - 2)],
  );
  const perRun = await db.admin.execute<{ run: string; n: string }>(
    `select run_id::text run, count(*)::text n from public.run_events
      where business_id = $1 group by run_id`,
    [t.id],
  );
  const counted = new Map(perRun.map((row) => [row.run, Number(row.n)]));
  if (runs.some((run, i) => counted.get(run) !== targets[i]))
    refused('load', 'EVENTS_NOT_AS_ASKED');
  return [];
}

export async function seedFixture(db: Seedable, shape: FixtureShape): Promise<FixtureReport> {
  const started = performance.now();
  await refuseUnlessEmpty(db);
  process.env['GATE_SIGNING_KEY_ID'] ??= 'fixture/t4a@1';
  process.env['GATE_SIGNING_SECRET'] ??= randomUUID();
  const alpha = await tenant(db, 'alpha', shape.peopleA);
  const bravo = await tenant(db, 'bravo', 1);
  await presetFields(db, alpha, shape.taskSlots);
  const tree = await seedTasks(db, alpha, shape);
  const bravoTasks: string[] = [];
  for (let i = 0; i < shape.tasksB; i += 1)
    bravoTasks.push(await create(db, bravo, `B ${String(i)}`));
  await seedThreads(db, alpha, shape, tree.rest);
  const runTasks = tree.rest.slice(shape.lineages.total, shape.lineages.total + shape.runs);
  await withPlannedSteps(db, shape, runTasks, async () => {
    await seedRuntime(db, alpha, shape, tree.rest);
  });
  const heldBack = await seedEvents(db, alpha, shape);
  await onTask(db, alpha, tree.early, { command: 'task.trash' });
  await onTask(db, alpha, tree.root, { command: 'task.trash' });
  const recordGrantTask = tree.rest.at(-1) ?? refused('grant', 'NO_TASK');
  await grantOn(db, alpha, alpha.members[3] ?? refused('grant', 'NO_R4'), recordGrantTask);
  const clients: FixtureReport['callers']['clients'][number][] = [];
  for (let c = 0; c < shape.clientsPerBusiness; c += 1) {
    for (const [t, tasks] of [
      [alpha, tree.rest],
      [bravo, bravoTasks],
    ] as const) {
      const task = tasks[c] ?? refused('client', 'NO_TASK');
      clients.push({ business: t.id, presented: await client(db, t, c + 1, task), task });
    }
  }
  const [slots] = await db.admin.execute<{ assigned: string; total: string }>(
    `select (select count(distinct f.slot) from public.field_defs f join public.record_types t
               on t.business_id = f.business_id and t.id = f.record_type_id
             where t.business_id = $1 and t.key = 'task' and f.slot is not null)::text assigned,
            (select count(*) from ops.slots)::text total`,
    [alpha.id],
  );
  return {
    board: tree.board,
    recordGrantTask,
    slots: { assigned: Number(slots?.assigned), total: Number(slots?.total) },
    people: { alpha: alpha.people, bravo: bravo.people },
    callers: {
      alpha: alpha.id,
      bravo: bravo.id,
      bravoLead: bravo.lead.presented,
      r4: alpha.members[3]?.presented ?? refused('callers', 'NO_R4'),
      clients,
    },
    seedMs: Math.round(performance.now() - started),
    heldBack,
  };
}
