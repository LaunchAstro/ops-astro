// SPDX-License-Identifier: AGPL-3.0-only
//
// T2h, the alert record, over a real database through the command and read
// entries.
//
// `alert_on_transition` (split 1.2): each named transition raises exactly one
// alert, visible on the task page (`task.read`) and in the queue read
// (`task.queue`), and a transition that is not a person's move raises none.
// Red until T2c2 and T2d produce a settlement to alert on. The mutation it
// fails under: progress (pickup, dispatch, the effect, an unpriced observe)
// raising one.
//
// The named transitions: settled and failed at T2d's settlement, a cost above
// the hold (a person records the outcome), a hand-back that settles, fails or
// leaves a successor for a person to decide, and a cancellation.
//
// Data separation: business to business (another business reads none of
// them, by the read and by row security), client to client (a client of
// another task is told `NOT_FOUND`, and the task's own client is shown the
// shared view, which carries none), person to person (a member with no grant
// is refused).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { successorBody } from './handback-footprint.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World, type Party } from './cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2h-alerts: DATABASE_URL is unset, so nothing below ran.');
}

const PRICED = { item: 'synthetic_comment', quantity: 1 };
const OVER = { item: 'synthetic_comment_long', quantity: 1 };

interface Work {
  readonly taskId: string;
  readonly proposal: Detail;
  readonly decision: Detail;
  readonly picked: Detail;
  readonly credential: string;
  readonly attemptId: string;
}

interface AlertRow {
  readonly kind: string;
  readonly waiting_reason: string | null;
}

describe.skipIf(serverUrl === undefined)('T2h the alert record', () => {
  let s: Schedules;
  let bravo: Party;

  async function approved(): Promise<Omit<Work, 'picked' | 'credential' | 'attemptId'>> {
    const taskId = await createTask(s, `t2h ${randomUUID()}`);
    const body = {
      ...proposeBody(taskId, await revisionOf(s, taskId), {
        purpose: freshPurpose(),
        maximumMinor: 2_500,
      }),
      step: { kind: 'synthetic_comment', payload: {} },
    };
    const proposal = appliedDetail(await asPerson(s, body), 'task.propose');
    return { taskId, proposal, decision: await approve(s, proposal) };
  }

  async function work(): Promise<Work> {
    const base = await approved();
    const picked = await pickup(s, base.decision['reservationId']);
    return {
      ...base,
      picked,
      credential: String(picked['credential']),
      attemptId: String(picked['attemptId']),
    };
  }

  const held = async (w: Work, body: Readonly<Record<string, unknown>>) =>
    await asAgent(
      s,
      {
        operationId: randomUUID(),
        leaseId: w.picked['leaseId'],
        fence: w.picked['fence'],
        ...body,
      },
      w.credential,
    );

  const dispatched = async (w: Work) => {
    appliedDetail(await held(w, { command: 'task.dispatch' }), 'task.dispatch');
  };

  const applied = async (w: Work) => {
    await dispatched(w);
    appliedDetail(
      await asAgent(
        s,
        {
          command: 'task.comment',
          operationId: effectOperationId(w.attemptId),
          recordId: w.taskId,
          body: 'The synthetic change, applied once. Nothing left the app.',
          audience: 'internal',
        },
        w.credential,
      ),
      'task.comment',
    );
  };

  const observeOf = async (w: Work, extra: Readonly<Record<string, unknown>> = {}) =>
    await held(w, { command: 'task.observe', attemptId: w.attemptId, ...extra });

  const alertsOn = async (taskId: string): Promise<readonly AlertRow[]> =>
    await rows<AlertRow>(
      s,
      `select kind, waiting_reason from public.alerts
        where business_id = $1 and task_id = $2 order by raised_at, id`,
      [s.business, taskId],
    );

  const read = async (who: Member, body: object, business = s.business) =>
    (await executeRead(s.db.app, business, who.presented, body as never)) as Record<
      string,
      unknown
    >;

  const taskAlerts = async (taskId: string, who: Member = s.decider) => {
    const answer = await read(who, { read: 'task.read', recordId: taskId });
    return (answer['task'] as { readonly alerts: readonly Record<string, unknown>[] }).alerts;
  };

  const queueAlerts = async (who: Member = s.decider, business = s.business) => {
    const answer = await read(who, { read: 'task.queue' }, business);
    return answer['alerts'] as readonly Record<string, unknown>[];
  };

  beforeAll(async () => {
    s = await openSchedules('t2h', 1_000_000);
    bravo = await cq8World(s).party('t2h-bravo');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('alert_on_transition: settling raises one alert, shown on the task page and in the queue read; progress raises none', async () => {
    const w = await work();
    await applied(w);
    // Pickup, dispatch and the effect are progress, and so is an unpriced report.
    const unpriced = appliedDetail(await observeOf(w), 'task.observe');
    expect(unpriced['settlement']).toMatchObject({ state: 'unpriced' });
    expect(await alertsOn(w.taskId)).toStrictEqual([]);

    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    expect(await alertsOn(w.taskId)).toStrictEqual([{ kind: 'settled', waiting_reason: null }]);
    // Observing the settled attempt again answers its settlement and raises nothing more.
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    expect(await alertsOn(w.taskId)).toHaveLength(1);

    const onPage = await taskAlerts(w.taskId);
    expect(onPage).toHaveLength(1);
    expect(onPage[0]).toMatchObject({ taskId: w.taskId, kind: 'settled', waitingReason: null });
    const inQueue = (await queueAlerts()).filter((alert) => alert['taskId'] === w.taskId);
    expect(inQueue).toStrictEqual(onPage);
  });

  it('a failed attempt raises one failed alert', async () => {
    const w = await work();
    await dispatched(w);
    appliedDetail(await observeOf(w, { usage: PRICED, outcome: 'failed' }), 'task.observe');
    expect(await alertsOn(w.taskId)).toStrictEqual([{ kind: 'failed', waiting_reason: null }]);
  });

  it('a cost above the hold raises one alert waiting on a person, and a second report raises none', async () => {
    const w = await work();
    await applied(w);
    expect(codeOf(await observeOf(w, { usage: OVER }))).toBe('BUDGET_UNAVAILABLE');
    expect(codeOf(await observeOf(w, { usage: OVER }))).toBe('BUDGET_UNAVAILABLE');
    expect(await alertsOn(w.taskId)).toStrictEqual([
      { kind: 'awaiting_person', waiting_reason: 'liability_unknown' },
    ]);
  });

  it.each([
    ['completed, settles', 'completed', undefined, 'settled', null],
    ['failed, fails', 'failed', undefined, 'failed', null],
    [
      'with a successor, waits on a person to decide it',
      'completed',
      successorBody(100),
      'awaiting_person',
      'needs_approval',
    ],
  ] as const)(
    'a hand-back %s: one alert',
    async (_label, outcome, successor, kind, waitingReason) => {
      const w = await work();
      appliedDetail(
        await asAgent(s, { ...handbackBody(w.picked, successor), outcome }, w.credential),
        'task.handback',
      );
      expect(await alertsOn(w.taskId)).toStrictEqual([{ kind, waiting_reason: waitingReason }]);
    },
  );

  it('a cancellation raises one cancelled alert; cancelling twice raises no second', async () => {
    const w = await approved();
    const cancel = () =>
      asPerson(s, {
        command: 'task.cancel',
        operationId: randomUUID(),
        recordId: w.taskId,
        lineageId: w.proposal['lineageId'],
        reason: 'the client withdrew the request',
      });
    appliedDetail(await cancel(), 'task.cancel');
    expect(codeOf(await cancel())).toBe('LINEAGE_TERMINAL');
    expect(await alertsOn(w.taskId)).toStrictEqual([{ kind: 'cancelled', waiting_reason: null }]);
  });

  it('proposing and approving raise none: a pending gate is the gate engine’s, not touched here', async () => {
    const w = await approved();
    expect(await alertsOn(w.taskId)).toStrictEqual([]);
  });

  it('T2 isolation: another business, a client of another task, the task’s own client and a member with no grant see none of it', async () => {
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    expect(await taskAlerts(w.taskId)).toHaveLength(1);

    // Business to business: bravo's queue carries none of alpha's, and row
    // security shows bravo no alert row at all.
    const theirs = await queueAlerts(bravo.member, bravo.id);
    expect(JSON.stringify(theirs)).not.toContain(w.taskId);
    const seen = await s.db.app.withBusiness(bravo.id, (tx) =>
      tx.query<{ readonly n: string }>(
        'select count(*)::text as n from public.alerts where task_id = $1',
        [w.taskId],
      ),
    );
    expect(seen[0]?.n).toBe('0');
    expect(
      await read(bravo.member, { read: 'task.read', recordId: w.taskId }, bravo.id),
    ).toMatchObject({ code: 'NOT_FOUND' });

    // Client to client, and the task's own client.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const elsewhere = await createTask(s, `t2h elsewhere ${randomUUID()}`);
    const outsider = await cq8World(s).client(s.business, s.decider, 't2h-client', elsewhere);
    expect(await read(outsider, { read: 'task.read', recordId: w.taskId })).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(JSON.stringify(await read(outsider, { read: 'task.queue' }))).not.toContain(w.taskId);
    const own = await cq8World(s).client(s.business, s.decider, 't2h-own', w.taskId);
    const shared = JSON.stringify(await read(own, { read: 'task.read', recordId: w.taskId }));
    expect(shared).toContain('sharedTask');
    expect(shared).not.toMatch(/alerts|settled/u);
    expect(JSON.stringify(await read(own, { read: 'task.queue' }))).not.toContain(w.taskId);

    // Person to person: a member of this business with no grant.
    const idle = await enrol(s.db.app, s.business, 't2h-idle');
    expect(await read(idle, { read: 'task.read', recordId: w.taskId })).toMatchObject({
      code: 'SCOPE_NOT_GRANTED',
    });
    expect(await read(idle, { read: 'task.queue' })).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  });
});
