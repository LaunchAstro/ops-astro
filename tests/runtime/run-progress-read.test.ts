// SPDX-License-Identifier: AGPL-3.0-only
//
// T2a, the run's progress record, against a real database: `run_events` is
// written by pickup and hand-back inside their own transactions, and
// `task.execution` reads it back per run, after the grant check, so a caller
// without the grant is refused rather than handed an empty graph.
//
// The invariant is `run_progress_read` (T2-T4 split, section 1.2). It is red
// until the writer is wired into pickup and hand-back, and red if the read
// answers a refusal with `[]`. Every other case is named after its line in
// T2's supporting checklist, or after its security line.
//
// Every operation goes through the production command entry or read entry.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { executeRead, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  codeOf,
  createTask,
  handbackBody,
  liveWork,
  openSchedules,
  revisionOf,
  scalar,
  type Detail,
  type Schedules,
  type Work,
} from './schedules-harness.ts';
import { cq8World } from './cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/run-progress-read: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Answer = Awaited<ReturnType<typeof executeRead>>;
type Execution = {
  readonly outcome: string;
  readonly taskId: string;
  readonly sourceRevision: number;
  readonly complete: boolean;
  readonly next: number | null;
  readonly runs: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
};

/** The execution an applied read carries, or a throw naming what came back instead. */
function executionOf(answer: Answer, what: string): Execution {
  if (isCommandRefusal(answer)) throw new Error(`${what}: refused ${answer.code}`);
  const execution = (answer as { readonly execution?: Execution }).execution;
  if (execution === undefined)
    throw new Error(`${what}: no execution in ${JSON.stringify(answer)}`);
  return execution;
}

describe.skipIf(serverUrl === undefined)('T2a run progress on a real database', () => {
  let s: Schedules;
  let stranger: Member;

  const readAs = async (
    who: Member,
    body: Record<string, unknown>,
    business: BusinessId = s.business,
  ): Promise<Answer> =>
    await executeRead(s.db.app, business, who.presented, {
      read: 'task.execution',
      ...body,
    } as never);

  const giveBack = async (work: Work, extra: Record<string, unknown> = {}) =>
    await asAgent(s, { ...handbackBody(work.picked), ...extra }, String(work.picked['credential']));

  const runEvents = async (taskId: string): Promise<number> =>
    await scalar(
      s,
      `select count(*)::text as n from public.run_events ev
         join public.planned_runs run on run.business_id = ev.business_id and run.id = ev.run_id
        where ev.business_id = $1 and run.task_id = $2`,
      [s.business, taskId],
    );

  const audited = async (command: string, outcome: string): Promise<number> =>
    await scalar(
      s,
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and command = $2 and outcome = $3`,
      [s.business, command, outcome],
    );

  beforeAll(async () => {
    s = await openSchedules('t2a', 1_000_000);
    stranger = await enrol(s.db.app, s.business, 't2a-no-grant');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('run_progress_read: a pickup and a hand-back appear as ordered events through task.execution, and a caller without the grant gets denied, never an empty graph', async () => {
    const work = await liveWork(s, `t2a-invariant-${randomUUID()}`, 1_000);

    const midRun = executionOf(await readAs(s.decider, { recordId: work.taskId }), 'mid-run');
    expect(midRun.outcome).toBe('ready');
    expect(midRun.events.map((event) => event['kind'])).toEqual(['claimed']);

    appliedDetail(await giveBack(work), 'task.handback');
    const after = executionOf(await readAs(s.decider, { recordId: work.taskId }), 'after');
    expect(after.events.map((event) => [event['kind'], event['position']])).toEqual([
      ['claimed', 1],
      ['handed_back', 2],
    ]);
    expect(after.events.map((event) => event['runId'])).toEqual([
      work.picked['runId'],
      work.picked['runId'],
    ]);
    expect(after.events[0]?.['leaseId']).toBe(work.picked['leaseId']);
    expect(after).toMatchObject({ sourceRevision: 2, complete: true, next: null });

    const denied = await readAs(stranger, { recordId: work.taskId });
    expect(isCommandRefusal(denied)).toBe(true);
    expect(codeOf(denied as never)).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(denied)).not.toContain('"events"');
  });

  it('T2a run lineage: a run carries its lineage, proposal version and the task revision at request time', async () => {
    const work = await liveWork(s, `t2a-lineage-${randomUUID()}`, 1_000);
    const run = executionOf(await readAs(s.decider, { recordId: work.taskId }), 'lineage').runs[0];
    expect(run).toMatchObject({
      runId: work.picked['runId'],
      lineageId: work.proposal['lineageId'],
      versionId: work.proposal['versionId'],
      // Nothing edited the task between the proposal and now, so the revision
      // the request was made against is the task's own.
      taskRevisionAtRequest: await revisionOf(s, work.taskId),
    });
  });

  it('T2a no run pointer: the task carries no current-run or agent-state column', async () => {
    const columns = await s.db.admin.execute<{ readonly column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'records'`,
    );
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.map((c) => c.column_name).filter((name) => /run|agent/u.test(name))).toEqual([]);
  });

  it('T2a runs per run: more than one run on a task is reported per run, never merged or picked', async () => {
    const work = await liveWork(s, `t2a-two-runs-${randomUUID()}`, 1_000);
    const successor: Detail = {
      purpose: 'draft_the_reply',
      maximumMinor: 500,
      currency: 'AUD',
      payload: { instruction: 'a second pass' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    };
    const handed = appliedDetail(await giveBack(work, { successor }), 'task.handback');
    const execution = executionOf(await readAs(s.decider, { recordId: work.taskId }), 'two runs');
    expect(execution.runs.map((run) => run['runId'])).toEqual([
      work.picked['runId'],
      handed['successorRunId'],
    ]);
    // Each event names its own run; the successor has none yet and is still listed.
    expect(new Set(execution.events.map((event) => event['runId']))).toEqual(
      new Set([work.picked['runId']]),
    );
    expect(execution.runs[1]).toMatchObject({ state: 'planned' });
  });

  it('T2a durable events: progress is readable mid-run and identical after an API restart', async () => {
    const work = await liveWork(s, `t2a-restart-${randomUUID()}`, 1_000);
    const before = await readAs(s.decider, { recordId: work.taskId });
    expect(executionOf(before, 'before').events).toHaveLength(1);
    // A second connection pool shares nothing with the first but the database.
    const restarted = connect(s.db.appUrl, { source: 't2a-restart' });
    try {
      const again = await executeRead(restarted, s.business, s.decider.presented, {
        read: 'task.execution',
        recordId: work.taskId,
      } as never);
      expect(again).toEqual(before);
    } finally {
      await restarted.close();
    }
  });

  it('T2a refusals audited: every attempt, refusals included, writes an audit event, and a refusal writes no run event', async () => {
    const work = await liveWork(s, `t2a-refusals-${randomUUID()}`, 1_000);
    const events = await runEvents(work.taskId);
    const pickupsRefused = await audited('task.pickup', 'refused');
    const handbacksRefused = await audited('task.handback', 'refused');

    const second = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: work.decision['reservationId'],
      leaseSeconds: 600,
    });
    expect(codeOf(second)).toBe('RESERVATION_NOT_CLAIMABLE');
    const stale = await giveBack(work, { fence: Number(work.picked['fence']) + 7 });
    expect(isCommandRefusal(stale)).toBe(true);

    expect(await audited('task.pickup', 'refused')).toBe(pickupsRefused + 1);
    expect(await audited('task.handback', 'refused')).toBe(handbacksRefused + 1);
    expect(await runEvents(work.taskId)).toBe(events);
    expect(await audited('task.execution', 'applied')).toBeGreaterThan(0);
  });

  it('T2a cursor: events after the cursor only, and a cursor past the stream is stale rather than an empty ready', async () => {
    const work = await liveWork(s, `t2a-cursor-${randomUUID()}`, 1_000);
    appliedDetail(await giveBack(work), 'task.handback');
    const page = executionOf(await readAs(s.decider, { recordId: work.taskId, cursor: 1 }), 'page');
    expect(page.events.map((event) => event['kind'])).toEqual(['handed_back']);
    expect(page).toMatchObject({ outcome: 'ready', sourceRevision: 2, complete: true });
    const ahead = executionOf(
      await readAs(s.decider, { recordId: work.taskId, cursor: 9 }),
      'ahead',
    );
    expect(ahead).toMatchObject({ outcome: 'stale', events: [], sourceRevision: 2 });
    for (const cursor of [-1, 1.5, '1']) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf((await readAs(s.decider, { recordId: work.taskId, cursor })) as never)).toBe(
        'FIELD_VALUE_INVALID',
      );
    }
    const idle = await createTask(s, `t2a-idle-${randomUUID()}`);
    const none = executionOf(await readAs(s.decider, { recordId: idle }), 'no run');
    expect(none).toMatchObject({ outcome: 'no-run', runs: [], events: [], sourceRevision: 0 });
  });

  it('T2 isolation (T2a): another business, an unseen client and a person without the grant each get denied, never []', async () => {
    const work = await liveWork(s, `t2a-isolation-${randomUUID()}`, 1_000);
    const sibling = await liveWork(s, `t2a-sibling-${randomUUID()}`, 1_000);

    // Another business, holding read on its own tasks, naming this one.
    const other = (await insertBusiness(s.db.app, `t2a-other-${randomUUID()}`)) as BusinessId;
    await installSpine(s.db.app, other);
    const outsider = await enrol(s.db.app, other, 't2a-other-reader');
    await s.db.app.withBusiness(other, async (tx) => await grantTo(tx, outsider, 'read'));
    const foreign = await readAs(outsider, { recordId: work.taskId }, other);

    // A client shared on this task only: the execution is internal work, so
    // neither this task nor the sibling it never saw is answered.
    await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
    const client = await cq8World(s).client(s.business, s.decider, 't2a-client', work.taskId);
    const ownShared = await readAs(client, { recordId: work.taskId });
    const unseen = await readAs(client, { recordId: sibling.taskId });

    // A person whose read is on the sibling only.
    const narrow = await enrol(s.db.app, s.business, 't2a-narrow');
    await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, narrow, 'read', { kind: 'record', id: sibling.taskId }),
    );
    const narrowed = await readAs(narrow, { recordId: work.taskId });
    expect(
      executionOf(await readAs(narrow, { recordId: sibling.taskId }), 'narrow own').outcome,
    ).toBe('ready');

    const cases = [
      ['another business', foreign, 'NOT_FOUND'],
      ['fabricated task', await readAs(s.decider, { recordId: randomUUID() }), 'NOT_FOUND'],
      ['client on its shared task', ownShared, 'NOT_FOUND'],
      ['unseen client', unseen, 'NOT_FOUND'],
      ['no grant', await readAs(stranger, { recordId: work.taskId }), 'SCOPE_NOT_GRANTED'],
      ['record grant elsewhere', narrowed, 'SCOPE_NOT_GRANTED'],
    ] as const;
    for (const [name, answer, code] of cases) {
      expect(isCommandRefusal(answer), name).toBe(true);
      expect(codeOf(answer as never), name).toBe(code);
      expect(JSON.stringify(answer), name).not.toContain(work.taskId);
    }
    // The foreign business's own view of run_events holds nothing of this one's.
    const seen = await s.db.app.withBusiness(
      other,
      async (tx) =>
        await tx.query<{ readonly n: string }>('select count(*)::text as n from public.run_events'),
    );
    expect(seen[0]?.n).toBe('0');
  });
});
