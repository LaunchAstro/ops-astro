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
import { agentOf, client, grantOn, refused, tenant, type Seedable, type Tenant } from './cast.ts';
import type { FixtureShape } from './shape.ts';

type Detail = Readonly<Record<string, unknown>>;

export interface FixtureReport {
  readonly board: string;
  readonly recordGrantTask: string;
  readonly slots: { readonly assigned: number; readonly total: number };
  readonly people: { readonly alpha: readonly string[]; readonly bravo: readonly string[] };
  readonly seedMs: number;
  /** SPEC 10.1 rows this base cannot reach through a command (see `shape.ts`). */
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

export async function seedFixture(db: Seedable, shape: FixtureShape): Promise<FixtureReport> {
  const started = performance.now();
  await refuseUnlessEmpty(db);
  process.env['GATE_SIGNING_KEY_ID'] ??= 'fixture/t4a@1';
  process.env['GATE_SIGNING_SECRET'] ??= randomUUID();
  const alpha = await tenant(db, 'alpha', shape.peopleA);
  const bravo = await tenant(db, 'bravo', 1);
  const tree = await seedTasks(db, alpha, shape);
  const bravoTasks: string[] = [];
  for (let i = 0; i < shape.tasksB; i += 1)
    bravoTasks.push(await create(db, bravo, `B ${String(i)}`));
  await seedThreads(db, alpha, shape, tree.rest);
  await seedRuntime(db, alpha, shape, tree.rest);
  await onTask(db, alpha, tree.early, { command: 'task.trash' });
  await onTask(db, alpha, tree.root, { command: 'task.trash' });
  const recordGrantTask = tree.rest.at(-1) ?? refused('grant', 'NO_TASK');
  await grantOn(db, alpha, alpha.members[3] ?? refused('grant', 'NO_R4'), recordGrantTask);
  for (let c = 0; c < shape.clientsPerBusiness; c += 1) {
    await client(db, alpha, c + 1, tree.rest[c] ?? refused('client', 'NO_TASK'));
    await client(db, bravo, c + 1, bravoTasks[c] ?? refused('client', 'NO_TASK'));
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
    seedMs: Math.round(performance.now() - started),
    heldBack: ['1,200 steps', '6,000 run events', 'one run held at 1,500 events'],
  };
}
