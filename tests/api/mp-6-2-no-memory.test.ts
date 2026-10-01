// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2, CS-16.4: no memory activates in version 1 (RA-10). A run's revised
// knowledge and unknowns are the writer's text, kept on that run and shown;
// nothing reads them into another run. Through the real boundary, the replay
// broker and a fresh Postgres: a first run's state is revised with lists of
// this test's own, then a second run on the same task and a run on another
// task are picked up, pinned, read and make a real model call. Neither starts
// with a revision; the lists are in no pin, read ledger, model-call row or
// body sent to the provider, and in no table but `run_states`; and
// `run.revise_state` is the only write in the source that touches them.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitActivation,
  captureManifest,
  pinBootstrapFile,
  readPinned,
} from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  serverUrl,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { encode, sourceOf } from '../runtime/aw-02-world.ts';
import { asAgent, asPerson, signed, type Signed } from './c54-fixture.ts';

const detailOf = (answer: Answer): Record<string, unknown> =>
  answer.body['detail'] as Record<string, unknown>;

// The lists' own text, so a copy anywhere is theirs.
const KNOWN = `known ${randomUUID()}`;
const UNKNOWN = `unknown ${randomUUID()}`;
const carriesTheLists = (text: string): boolean => text.includes(KNOWN) || text.includes(UNKNOWN);
const ENTRY = 'skills/learned/SKILL.md';
const FILES = new Map([[ENTRY, encode(`# Learned\n${randomUUID()}\n`)]]);

interface Work {
  readonly taskId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

/** Every product source file under `roots`, as `path` and text. */
const sources = (roots: readonly string[]): { readonly path: string; readonly text: string }[] =>
  roots.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(tsx?|sql)$/u.test(file) && !file.includes('node_modules'))
      .map((file) => ({ path: `${root}/${file}`, text: readFileSync(`${root}/${file}`, 'utf8') })),
  );

/** The files whose SQL writes `run_states`: an insert, update or delete naming it. */
const writersOf = (files: readonly { readonly path: string; readonly text: string }[]): string[] =>
  files
    .filter(({ text }) =>
      /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?"?run_states"?\b/iu.test(text),
    )
    .map(({ path }) => path)
    .toSorted();

// eslint-disable-next-line max-lines-per-function -- one world, the three runs and each proof on them
describe.skipIf(serverUrl === undefined)('MP-6-2 no memory activates', () => {
  let world: World;
  let ada: Signed;
  let first: Work;
  let again: Work;
  let other: Work;

  /** A proposal on `taskId` ada approves, picked up by the agent. */
  const pickUp = async (taskId: string): Promise<Work> => {
    const read = await asPerson(world, ada, 'task.read', { recordId: taskId });
    const proposed = await asPerson(world, ada, 'task.propose', {
      recordId: taskId,
      expectedRevision: (read.body['task'] as Record<string, unknown>)['revision'],
      ...PROPOSAL,
    });
    expect(proposed.code, 'propose').toBe('ok');
    const decided = await asPerson(world, ada, 'task.decide', {
      gateId: detailOf(proposed)['gateId'],
      versionId: detailOf(proposed)['versionId'],
      decision: 'approve',
      note: 'approved for a run',
    });
    const picked = await call(
      world.api,
      agentPath('alpha', '/task/pickup'),
      { operationId: randomUUID(), reservationId: detailOf(decided)['reservationId'] },
      bearer(world.agent.token),
    );
    expect(picked.code, 'pickup').toBe('ok');
    const lease = detailOf(picked);
    return {
      taskId,
      runId: String(lease['runId']),
      leaseId: String(lease['leaseId']),
      fence: Number(lease['fence']),
      credential: String(lease['credential']),
    };
  };

  const newTask = async (title: string): Promise<string> =>
    String((await asPerson(world, ada, 'task.create', { fields: { title } })).body['recordId']);

  /** Ada's activation pins the entry on the run; the agent reads it and calls the model. */
  const startWork = async (on: Work): Promise<void> => {
    const activation = admitActivation({
      mode: 'manual',
      activator: { kind: 'person', actorId: ada.actorId },
    });
    if (!activation.ok) throw new Error('activation refused');
    const manifest = await captureManifest(sourceOf(FILES), [...FILES.keys()]);
    if (!manifest.ok) throw new Error('manifest refused');
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const pinned = await pinBootstrapFile(tx, activation.value, {
        runId: on.runId,
        entryPath: ENTRY,
        manifest: manifest.value,
      });
      expect(pinned.ok, 'pin').toBe(true);
      const read = await readPinned(
        tx,
        {
          leaseId: on.leaseId,
          holderActorId: world.agent.actorId,
          runId: on.runId,
          stepId: null,
          path: ENTRY,
        },
        sourceOf(FILES),
        async () => {
          await Promise.resolve();
        },
      );
      expect(read.ok, 'read').toBe(true);
    });
    const called = await asAgent(
      world,
      'model.call',
      {
        leaseId: on.leaseId,
        fence: on.fence,
        operation: 'model.replay_compose',
        fields: [{ name: 'tone', from: { recordId: on.taskId, key: 'title' } }],
      },
      on.credential,
    );
    expect(called.code, 'model.call').toBe('ok');
  };

  /** The run handed back, so the agent's one live delegation is free for the next. */
  const handBack = async (on: Work): Promise<void> => {
    const back = await asAgent(
      world,
      'task.handback',
      { leaseId: on.leaseId, fence: on.fence, outcome: 'completed', report: { wrote: 'done' } },
      on.credential,
    );
    expect(back.code, 'handback').toBe('ok');
  };

  const statesOf = async (taskId: string): Promise<readonly Record<string, unknown>[]> => {
    const read = await asPerson(world, ada, 'task.read', { recordId: taskId });
    expect(read.code, 'task.read').toBe('ok');
    return (read.body['task'] as { ledger: { states: Record<string, unknown>[] } }).ledger.states;
  };

  /** The public tables holding either list's text anywhere in a row, read as admin. */
  const tablesHolding = async (): Promise<string[]> => {
    const tables = await world.db.admin.execute<{ readonly name: string }>(
      `select table_name as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
    );
    const counts = await Promise.all(
      tables.map(async ({ name }) => {
        const [row] = await world.db.admin.execute<{ readonly n: string }>(
          `select count(*)::text as n from public.${JSON.stringify(name)} t
            where strpos(t::text, $1) > 0 or strpos(t::text, $2) > 0`,
          [KNOWN, UNKNOWN],
        );
        return { name, n: row?.n };
      }),
    );
    return counts.filter(({ n }) => n !== '0').map(({ name }) => name);
  };

  beforeAll(async () => {
    world = await createWorld('mp62memory');
    ada = signed(world.ada);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', undefined, false, 'run');
    });
    const learning = await newTask('a task whose first run learns');
    first = await pickUp(learning);
    await startWork(first);
    const revised = await asPerson(world, ada, 'run.revise_state', {
      recordId: first.taskId,
      runId: first.runId,
      expectedVersion: 0,
      knowledge: [KNOWN],
      unknowns: [UNKNOWN],
    });
    expect(revised.code, 'revise').toBe('ok');
    await handBack(first);
    again = await pickUp(learning);
    await startWork(again);
    await handBack(again);
    other = await pickUp(await newTask('another task, run after the first learned'));
    await startWork(other);
    await handBack(other);
  }, 240_000);

  afterAll(async () => await world?.close());

  it('MP-6-2 no memory activates: a second run on the same task and a run on another task start with no revision', async () => {
    expect(again.runId).not.toBe(first.runId);
    const states = await statesOf(first.taskId);
    expect(states.map((s) => [s['runId'], s['version']])).toStrictEqual([[first.runId, 1]]);
    expect(await statesOf(other.taskId)).toStrictEqual([]);
    const kept = await world.db.admin.execute<{ readonly run_id: string }>(
      'select run_id from public.run_states order by run_id',
    );
    expect(kept.map((row) => row.run_id)).toStrictEqual([first.runId]);
  });

  it('MP-6-2 no memory activates: the lists are in no pin, read ledger, model call or provider body, and in no table but run_states', async () => {
    const later = [again.runId, other.runId];
    const tables = ['run_definition_pins', 'bootstrap_reads', 'model_calls'];
    const rowsOf = await Promise.all(
      tables.map(
        async (table) =>
          await world.db.admin.execute<{ readonly row: string }>(
            `select t::text as row from public.${table} t where t.run_id = any($1::uuid[])`,
            [later],
          ),
      ),
    );
    for (const [i, rows] of rowsOf.entries()) {
      expect(rows.length, `${tables[i]} rows on the later runs`).toBeGreaterThan(0);
      expect(
        rows.some(({ row }) => carriesTheLists(row)),
        tables[i],
      ).toBe(false);
    }
    // Bodies only, and a yes or no: a failure never prints a request or its credential.
    const bodies = world.broker.provider.seen.map((request) => request.body);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(
      bodies.some((body) => carriesTheLists(body)),
      'a provider body carries the lists',
    ).toBe(false);
    expect(await tablesHolding()).toStrictEqual(['run_states']);
  });

  it('MP-6-2 no memory activates: run.revise_state is the only write in the source that touches the lists', () => {
    expect(writersOf(sources(['packages', 'apps']))).toStrictEqual([
      'packages/core-commands/src/commands/run-state.ts',
    ]);
    // The migrations create the table and keep it append-only; none writes it.
    expect(writersOf(sources(['migrations']))).toStrictEqual([]);
    const handlers = readFileSync('packages/core-commands/src/commands/handlers.ts', 'utf8');
    expect([...handlers.matchAll(/'([a-z_.]+)':\s*reviseStateOnRun\b/gu)].map((m) => m[1])).toEqual(
      ['run.revise_state'],
    );
    // Its one other caller is the agent's row of the same command.
    const callers = sources(['packages', 'apps'])
      .filter(({ text }) => /\breviseRunState\(/u.test(text))
      .map(({ path }) => path);
    expect(callers).toStrictEqual([
      'packages/core-commands/src/commands/agent-operations.ts',
      'packages/core-commands/src/commands/run-state.ts',
    ]);
    const agentRows = readFileSync(
      'packages/core-commands/src/commands/agent-operations.ts',
      'utf8',
    );
    const before = agentRows.slice(0, agentRows.indexOf('reviseRunState('));
    expect([...before.matchAll(/^ {4}'([a-z_.]+)',$/gmu)].at(-1)?.[1]).toBe('run.revise_state');
    // The check sees a second writer, in any spelling, so it is not blind.
    const planted = [
      { path: 'a.ts', text: 'await tx.query(`UPDATE public.run_states set knowledge = $1`);' },
      { path: 'b.ts', text: "tx.query('delete from run_states where true');" },
      { path: 'c.sql', text: 'insert into "run_states" values (1);' },
      { path: 'd.ts', text: 'select * from public.run_states' },
    ];
    expect(writersOf(planted)).toStrictEqual(['a.ts', 'b.ts', 'c.sql']);
  });
});
