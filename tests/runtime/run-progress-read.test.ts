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
import {
  connect,
  type BusinessId,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  codeOf,
  createTask,
  handbackBody,
  liveWork,
  openSchedules,
  racer,
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

  it('task.execution reports every run present at its event head', async () => {
    const work = await liveWork(s, `sol-t2a-snapshot-${randomUUID()}`, 1_000);
    const otherPool = racer(s);
    let successorRunId: unknown;
    try {
      const interleavedDb: Database = {
        log: s.db.app.log,
        close: async () => {},
        withBusiness: async <T>(
          id: BusinessId,
          run: (tx: TransactionQuery) => Promise<T>,
        ): Promise<T> =>
          await s.db.app.withBusiness(
            id,
            async (tx) =>
              await run({
                businessId: tx.businessId,
                savepoint: tx.savepoint,
                async query<Row>(
                  sql: string,
                  parameters?: readonly unknown[],
                ): Promise<readonly Row[]> {
                  const rows = await tx.query<Row>(sql, parameters);
                  if (successorRunId === undefined && sql.includes('planned_runs')) {
                    const successor: Detail = {
                      purpose: 'draft_the_reply',
                      maximumMinor: 500,
                      currency: 'AUD',
                      payload: { instruction: 'a second pass' },
                      step: { kind: 'compose', payload: { tone: 'plain' } },
                    };
                    const handed = appliedDetail(
                      await asAgent(
                        s,
                        { ...handbackBody(work.picked), successor },
                        String(work.picked['credential']),
                        otherPool,
                      ),
                      'task.handback',
                    );
                    successorRunId = handed['successorRunId'];
                  }
                  return rows;
                },
              }),
          ),
      };
      const execution = executionOf(
        await executeRead(interleavedDb, s.business, s.decider.presented, {
          read: 'task.execution',
          recordId: work.taskId,
        } as never),
        'interleaved read',
      );
      expect(successorRunId).toBeTypeOf('string');
      if (execution.sourceRevision === 2) {
        expect(execution.runs.map((run) => run['runId'])).toContain(successorRunId);
      } else {
        expect(execution).toMatchObject({ sourceRevision: 1, complete: true });
        expect(execution.events.map((event) => event['kind'])).toEqual(['claimed']);
      }
    } finally {
      await otherPool.close();
    }
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

  it('T2 isolation (T2a): another business, each client and a person without the grant each get denied, never []', async () => {
    const work = await liveWork(s, `t2a-isolation-${randomUUID()}`, 1_000);
    const sibling = await liveWork(s, `t2a-sibling-${randomUUID()}`, 1_000);
    const world = cq8World(s);

    // Another business with two clients, one shared task each; its member
    // holds read on its own tasks and names this business's task.
    const other = await world.party('t2a-other');
    const [otherFirst, otherSecond] = other.tasks;
    if (otherFirst === undefined || otherSecond === undefined) throw new Error('party: two tasks');
    const foreign = await readAs(other.member, { recordId: work.taskId }, other.id);

    // Two clients here, one grant each: the execution is internal work, so a
    // client is answered neither on its own task nor on the other client's.
    await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
    const first = await world.client(s.business, s.decider, 't2a-client-1', work.taskId);
    const second = await world.client(s.business, s.decider, 't2a-client-2', sibling.taskId);

    // A person whose read is on the sibling only.
    const narrow = await enrol(s.db.app, s.business, 't2a-narrow');
    await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, narrow, 'read', { kind: 'record', id: sibling.taskId }),
    );
    expect(
      executionOf(await readAs(narrow, { recordId: sibling.taskId }), 'narrow own').outcome,
    ).toBe('ready');

    const here = (who: Member, recordId: string) => readAs(who, { recordId });
    const there = (who: Member, recordId: string) => readAs(who, { recordId }, other.id);
    const cases = [
      ['another business', foreign, 'NOT_FOUND', work.taskId],
      ['fabricated task', await here(s.decider, randomUUID()), 'NOT_FOUND', work.taskId],
      ['client on its shared task', await here(first, work.taskId), 'NOT_FOUND', work.taskId],
      ['client to client', await here(first, sibling.taskId), 'NOT_FOUND', sibling.taskId],
      ['client to client, back', await here(second, work.taskId), 'NOT_FOUND', work.taskId],
      [
        'client to client, other business',
        await there(otherFirst.client, otherSecond.id),
        'NOT_FOUND',
        otherSecond.id,
      ],
      [
        'client to client, other business, back',
        await there(otherSecond.client, otherFirst.id),
        'NOT_FOUND',
        otherFirst.id,
      ],
      ['no grant', await here(stranger, work.taskId), 'SCOPE_NOT_GRANTED', work.taskId],
      ['record grant elsewhere', await here(narrow, work.taskId), 'SCOPE_NOT_GRANTED', work.taskId],
    ] as const;
    for (const [name, answer, code, hidden] of cases) {
      expect(isCommandRefusal(answer), name).toBe(true);
      expect(codeOf(answer as never), name).toBe(code);
      expect(JSON.stringify(answer), name).not.toContain(hidden);
    }
    // The foreign business's own view of run_events holds nothing of this one's.
    const seen = await s.db.app.withBusiness(
      other.id,
      async (tx) =>
        await tx.query<{ readonly n: string }>('select count(*)::text as n from public.run_events'),
    );
    expect(seen[0]?.n).toBe('0');
  });

  it('T2 isolation crosses two clients with one grant each in both businesses', async () => {
    const clients = await s.db.admin.execute<{
      readonly business_id: string;
      readonly subject_id: string;
      readonly grants: number;
      readonly crossed: number;
    }>(
      `select g.business_id, g.subject_id, count(distinct g.id)::int as grants,
              count(distinct e.subject_record_id)::int as crossed
         from public.grants g
         join public.actors a on a.business_id = g.business_id
                             and a.person_id = g.subject_id and a.kind = 'person'
         left join public.memberships m on m.business_id = g.business_id
                                        and m.person_id = g.subject_id and m.active
         left join public.audit_events e on e.business_id = g.business_id
                                        and e.actor_id = a.id
                                        and e.command = 'task.execution'
                                        and e.outcome = 'refused'
                                        and e.refusal_code = 'NOT_FOUND'
                                        and e.subject_record_id in (
                                          select peer.scope_id from public.grants peer
                                           where peer.business_id = g.business_id
                                             and peer.subject_id <> g.subject_id
                                             and peer.collection = 'task' and peer.action = 'read'
                                             and peer.scope_kind = 'record'
                                        )
        where g.subject_kind = 'person' and g.collection = 'task' and g.action = 'read'
          and g.scope_kind = 'record' and g.revoked_at is null and m.id is null
        group by g.business_id, g.subject_id`,
    );
    const businesses = new Set(clients.map((client) => client.business_id));
    expect(businesses.size).toBe(2);
    for (const business of businesses) {
      const pair = clients.filter((client) => client.business_id === business);
      expect(pair).toHaveLength(2);
      for (const client of pair) {
        expect(client.grants).toBe(1);
        expect(client.crossed).toBe(1);
      }
    }
  });
});
