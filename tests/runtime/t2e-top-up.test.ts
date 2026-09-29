// SPDX-License-Identifier: AGPL-3.0-only
//
// T2e, the top-up, over a real database through both command entries.
//
// `top_up_is_a_persons` (split 1.2): a top-up under a delegation is refused
// and the same person's own credential succeeds. Red until T2d gives a settled
// envelope to top up; the surface half of the invariant is
// `tests/cli/t2e-top-up-surfaces.test.ts`.
//
// T2e's checklist, one case each: the four-eyes threshold is read from the
// business setting (default 500, "off" permitted) and a second approver is
// needed above it; an ordinary top-up is the plan approver's when they hold
// budget permission, otherwise any holder's; no standing pre-authorisation;
// the cap stays the hard ceiling.
//
// Separations proved: business to business (a top-up moves only its own
// business's envelope), client to client (an external client sharing one
// task, with a billing grant on it, tops up neither that task nor another
// client's), task to task (a member's grant on one task reaches no other),
// person to person
// (the second approver is a different person holding the grant in that
// business, and a first approval whose holder lost the grant pairs with no
// one).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { topUp as applyTopUp } from '../../packages/core-runtime/src/budget.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  proposeBody,
  racer,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2e-top-up: DATABASE_URL is unset, so nothing below ran.');
}

/** The plan's estimated maximum, which opens the envelope at this figure. */
const MAXIMUM = 2_500;
/** Under the shipped band of 500 (50 000 minor units). */
const SMALL = 10_000;
/** Above it. */
const LARGE = 60_000;

const topUpBody = (taskId: string, amountMinor: number, fromMaximumMinor: number) => ({
  command: 'budget.top_up',
  operationId: randomUUID(),
  recordId: taskId,
  amountMinor,
  fromMaximumMinor,
});

describe.skipIf(serverUrl === undefined)('T2e the top-up', () => {
  let s: Schedules;
  let second: Member;
  let planner: Member;
  let nobody: Member;
  let clientA: Member;
  let taskScoped: Member;
  /** The task shared with `clientA`, whose plan the planner approved. */
  let clientTask: string;

  const as = async (who: Member, body: Readonly<Record<string, unknown>>) =>
    await executeCommand(s.db.app, s.business, who.presented, 'api', body as never);

  const topUp = async (
    who: Member,
    taskId: string,
    amountMinor: number,
    fromMaximumMinor: number,
  ): Promise<CommandResult> => await as(who, topUpBody(taskId, amountMinor, fromMaximumMinor));

  const maximumOf = async (taskId: string, business: string = s.business): Promise<number> =>
    Number(
      (
        await rows<{ readonly maximum: string }>(
          s,
          `select maximum_minor::text as maximum from public.task_envelopes
            where business_id = $1 and task_id = $2 and state = 'open'`,
          [business, taskId],
        )
      )[0]?.maximum,
    );

  /** A task with an approved plan, so an envelope to top up, approved by `by`. */
  async function planned(by: Member = s.decider): Promise<{ taskId: string; decision: Detail }> {
    const taskId = await createTask(s, `t2e ${randomUUID()}`);
    const proposal = appliedDetail(
      await asPerson(
        s,
        proposeBody(taskId, await revisionOf(s, taskId), {
          purpose: freshPurpose(),
          maximumMinor: MAXIMUM,
        }),
      ),
      'task.propose',
    );
    const decision = appliedDetail(await as(by, approveBody(proposal)), 'task.decide');
    return { taskId, decision };
  }

  const setBand = async (value: string): Promise<void> => {
    await s.db.admin.execute(
      `update public.business_settings set value = $2::text::jsonb
        where business_id = $1 and key = 'four_eyes_threshold'`,
      [s.business, value],
    );
  };

  beforeAll(async () => {
    s = await openSchedules('t2e', 1_000_000);
    second = await enrol(s.db.app, s.business, 'second');
    planner = await enrol(s.db.app, s.business, 'planner');
    nobody = await enrol(s.db.app, s.business, 'nobody');
    taskScoped = await enrol(s.db.app, s.business, 'task-scoped-billing');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await installBusinessSettings(tx);
      await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
      await grantTo(tx, second, 'decide', undefined, false, 'billing');
      // The planner decides plans and holds no budget permission.
      for (const action of ['read', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, planner, action);
      }
    });
    // Sol, #130: an external client, no membership, sharing one task, and
    // holding a billing grant on it that R4 must never let it use.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    clientTask = (await planned(planner)).taskId;
    clientA = await cq8World(s).client(s.business, s.decider, 'client-a', clientTask);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, clientA, 'decide', { kind: 'record', id: clientTask }, false, 'billing');
    });
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it("top_up_is_a_persons: refused under a delegation, and the same person's own credential succeeds", async () => {
    const { taskId, decision } = await planned();
    const picked = await pickup(s, decision['reservationId']);
    const credential = String(picked['credential']);

    const delegated = await asAgent(s, topUpBody(taskId, SMALL, MAXIMUM), credential);
    expect(codeOf(delegated)).toBe('DELEGATION_EXCLUDES_OPERATION');
    const bare = await asAgent(s, topUpBody(taskId, SMALL, MAXIMUM));
    expect(codeOf(bare)).not.toBe('applied');
    expect(await maximumOf(taskId)).toBe(MAXIMUM);

    // The person the agent's delegation came from, on their own credential.
    const own = appliedDetail(await topUp(s.decider, taskId, SMALL, MAXIMUM), 'budget.top_up');
    expect(own).toMatchObject({
      state: 'applied',
      fromMaximumMinor: MAXIMUM,
      amountMinor: SMALL,
      maximumMinor: MAXIMUM + SMALL,
      approvers: [s.decider.personId],
    });
    expect(await maximumOf(taskId)).toBe(MAXIMUM + SMALL);
    const audited = await rows<{ readonly outcome: string }>(
      s,
      `select outcome from public.audit_events
        where business_id = $1 and command = 'budget.top_up' and subject_record_id = $2
        order by seq`,
      [s.business, taskId],
    );
    expect(audited.map((row) => row.outcome)).toContain('applied');
  });

  it('above the band a second approver is needed, a different person holding the grant', async () => {
    const { taskId } = await planned();
    const first = appliedDetail(await topUp(s.decider, taskId, LARGE, MAXIMUM), 'budget.top_up');
    expect(first).toMatchObject({
      state: 'awaiting_second_approver',
      firstApproverPersonId: s.decider.personId,
    });
    expect(await maximumOf(taskId)).toBe(MAXIMUM);

    // Person to person: the same person twice is still one pair of eyes.
    expect(codeOf(await topUp(s.decider, taskId, LARGE, MAXIMUM))).toBe('FOUR_EYES_REQUIRED');
    // A person without the grant is not a second approver.
    expect(codeOf(await topUp(nobody, taskId, LARGE, MAXIMUM))).toBe('SCOPE_NOT_GRANTED');
    expect(await maximumOf(taskId)).toBe(MAXIMUM);

    const paired = appliedDetail(await topUp(second, taskId, LARGE, MAXIMUM), 'budget.top_up');
    expect(paired).toMatchObject({
      state: 'applied',
      maximumMinor: MAXIMUM + LARGE,
      approvers: [s.decider.personId, second.personId],
    });
    expect(await maximumOf(taskId)).toBe(MAXIMUM + LARGE);
    // The pair is spent: the envelope has moved, so the old figure is stale.
    expect(codeOf(await topUp(second, taskId, LARGE, MAXIMUM))).toBe('VERSION_STALE');
  });

  it('reads the band from the business setting: off means one person at any amount, and a lower band bites sooner', async () => {
    try {
      await setBand('null');
      const off = await planned();
      expect(
        appliedDetail(await topUp(s.decider, off.taskId, LARGE, MAXIMUM), 'budget.top_up'),
      ).toMatchObject({ state: 'applied', maximumMinor: MAXIMUM + LARGE });

      await setBand('50');
      const low = await planned();
      expect(
        appliedDetail(await topUp(s.decider, low.taskId, SMALL, MAXIMUM), 'budget.top_up'),
      ).toMatchObject({ state: 'awaiting_second_approver' });
      expect(await maximumOf(low.taskId)).toBe(MAXIMUM);
    } finally {
      await setBand('500');
    }
  });

  it("an ordinary top-up is the plan approver's when they hold budget permission, otherwise any holder's", async () => {
    const theirs = await planned(s.decider);
    expect(codeOf(await topUp(second, theirs.taskId, SMALL, MAXIMUM))).toBe('SCOPE_NOT_GRANTED');
    expect(await maximumOf(theirs.taskId)).toBe(MAXIMUM);
    appliedDetail(await topUp(s.decider, theirs.taskId, SMALL, MAXIMUM), 'budget.top_up');

    const plannersPlan = await planned(planner);
    expect(codeOf(await topUp(planner, plannersPlan.taskId, SMALL, MAXIMUM))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect(
      appliedDetail(await topUp(second, plannersPlan.taskId, SMALL, MAXIMUM), 'budget.top_up'),
    ).toMatchObject({ state: 'applied', approvers: [second.personId] });
  });

  it('no standing pre-authorisation: a first approval binds its amount and figure, and a ceiling operand is refused', async () => {
    // The planner holds no budget permission, so any holder gives either approval.
    const { taskId } = await planned(planner);
    appliedDetail(await topUp(s.decider, taskId, LARGE, MAXIMUM), 'budget.top_up');
    // A different amount is its own first approval, not the other half of this one.
    expect(
      appliedDetail(await topUp(second, taskId, LARGE + 1, MAXIMUM), 'budget.top_up'),
    ).toMatchObject({ state: 'awaiting_second_approver' });
    expect(await maximumOf(taskId)).toBe(MAXIMUM);
    const standing = await as(s.decider, { ...topUpBody(taskId, SMALL, MAXIMUM), upToMinor: 1e6 });
    expect(codeOf(standing)).not.toBe('applied');
    expect(await maximumOf(taskId)).toBe(MAXIMUM);
  });

  it('the cap is the hard ceiling, and a stale figure or a task with no envelope is refused', async () => {
    const { taskId } = await planned();
    expect(codeOf(await topUp(s.decider, taskId, SMALL, MAXIMUM - 1))).toBe('VERSION_STALE');
    await setBand('null');
    try {
      expect(codeOf(await topUp(s.decider, taskId, 2_000_000, MAXIMUM))).toBe('BUDGET_EXHAUSTED');
    } finally {
      await setBand('500');
    }
    expect(await maximumOf(taskId)).toBe(MAXIMUM);
    const bare = await createTask(s, `t2e bare ${randomUUID()}`);
    expect(codeOf(await topUp(s.decider, bare, SMALL, 0))).toBe('BUDGET_UNAVAILABLE');
    expect(codeOf(await topUp(s.decider, taskId, 0, MAXIMUM))).toBe('FIELD_VALUE_INVALID');
  });

  it('person to person: a first approval whose holder lost the grant pairs with no one', async () => {
    const extra = await enrol(s.db.app, s.business, 'lapsing');
    const grantId = await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, extra, 'decide', undefined, false, 'billing'),
    );
    const plan = await planned(planner);
    appliedDetail(await topUp(extra, plan.taskId, LARGE, MAXIMUM), 'budget.top_up');
    await s.db.admin.execute('update public.grants set revoked_at = now() where id = $1', [
      grantId,
    ]);
    expect(
      appliedDetail(await topUp(second, plan.taskId, LARGE, MAXIMUM), 'budget.top_up'),
    ).toMatchObject({ state: 'awaiting_second_approver', firstApproverPersonId: second.personId });
    expect(await maximumOf(plan.taskId)).toBe(MAXIMUM);
  });

  it('Sol proof, criterion 2: a first approval revoked before the second decision commits cannot be counted', async () => {
    const first = await enrol(s.db.app, s.business, 'sol-first');
    const grantId = await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, first, 'decide', undefined, false, 'billing'),
    );
    const plan = await planned(planner);
    appliedDetail(await topUp(first, plan.taskId, LARGE, MAXIMUM), 'budget.top_up');

    let unblock!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let decisionFinished = false;
    const decision = s.db.app
      .withBusiness(s.business, async (tx) => {
        const intercepted: TenantQuery = {
          businessId: tx.businessId,
          query: async <Row>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<readonly Row[]> => {
            const answer = await tx.query<Row>(sql, parameters);
            const ids = parameters?.[1];
            if (
              sql.includes('select id from public.grants') &&
              Array.isArray(ids) &&
              ids.includes(grantId)
            ) {
              signal();
              await blocked;
            }
            return answer;
          },
        };
        return await applyTopUp(intercepted, {
          taskId: plan.taskId,
          amountMinor: BigInt(LARGE),
          fromMaximumMinor: BigInt(MAXIMUM),
          personId: second.personId,
          subjects: [
            { kind: 'person', id: second.personId },
            { kind: 'actor', id: second.actorId },
          ],
          collection: 'billing',
        });
      })
      .then((result) => {
        decisionFinished = true;
        return result;
      });
    await reached;
    let revokeFinished = false;
    let revokedBeforeDecision = false;
    const revoker = racer(s);
    const revocation = revoker
      .withBusiness(s.business, async (tx) => {
        await tx.query('update public.grants set revoked_at = now() where id = $1', [grantId]);
      })
      .then(() => {
        revokeFinished = true;
        revokedBeforeDecision = !decisionFinished;
        return undefined;
      });
    let parked = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (revokeFinished) break;
      // Poll the exact revocation, rather than assuming a blocked write finished.
      // eslint-disable-next-line no-await-in-loop
      const waiting = await s.db.admin.execute<{ readonly parked: boolean }>(
        `select exists(select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like 'update public.grants set revoked_at = now()%') as parked`,
      );
      if (waiting[0]?.parked === true) {
        parked = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    if (!revokeFinished && !parked)
      throw new Error('revocation did not finish or wait for its grant');
    unblock();
    const outcome = await decision;
    await revocation;
    await revoker.close();
    const applied = outcome.ok && outcome.value.state === 'applied';
    expect({ revokedBeforeDecision, applied }).not.toStrictEqual({
      revokedBeforeDecision: true,
      applied: true,
    });
    if (revokedBeforeDecision) expect(await maximumOf(plan.taskId)).toBe(MAXIMUM);
  });

  it('Sol proof, criterion 2: a first approval committed before the second takes task locks counts as the first eye', async () => {
    const plan = await planned(planner);
    let release!: () => void;
    let signal!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstsRead = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const secondDecision = s.db.app.withBusiness(s.business, async (tx) => {
      const intercepted: TenantQuery = {
        businessId: tx.businessId,
        query: async <Row>(
          sql: string,
          parameters?: readonly unknown[],
        ): Promise<readonly Row[]> => {
          const answer = await tx.query<Row>(sql, parameters);
          if (
            sql.includes('from public.operations o') &&
            sql.includes("o.command = 'budget.top_up'")
          ) {
            expect(answer).toHaveLength(0);
            signal();
            await waiting;
          }
          return answer;
        },
      };
      return await applyTopUp(intercepted, {
        taskId: plan.taskId,
        amountMinor: BigInt(LARGE),
        fromMaximumMinor: BigInt(MAXIMUM),
        personId: second.personId,
        subjects: [
          { kind: 'person', id: second.personId },
          { kind: 'actor', id: second.actorId },
        ],
        collection: 'billing',
      });
    });
    await firstsRead;
    const firstConnection = racer(s);
    try {
      const first = await executeCommand(
        firstConnection,
        s.business,
        s.decider.presented,
        'api',
        topUpBody(plan.taskId, LARGE, MAXIMUM) as never,
      );
      expect(appliedDetail(first, 'first top-up')).toMatchObject({
        state: 'awaiting_second_approver',
      });
    } finally {
      release();
      await firstConnection.close();
    }
    const outcome = await secondDecision;
    expect(outcome.ok && outcome.value.state).toBe('applied');
    expect(await maximumOf(plan.taskId)).toBe(MAXIMUM + LARGE);
  });

  it("client to client: a client's own task share and billing grant reach no top-up, on theirs or another client's", async () => {
    const theirs = await planned(planner);
    for (const taskId of [clientTask, theirs.taskId]) {
      // eslint-disable-next-line no-await-in-loop
      expect(codeOf(await topUp(clientA, taskId, SMALL, MAXIMUM))).toBe('SCOPE_NOT_GRANTED');
      // eslint-disable-next-line no-await-in-loop
      expect(await maximumOf(taskId)).toBe(MAXIMUM);
    }
  });

  it("task to task: a member's grant on one task does not reach another task", async () => {
    const mine = await planned(planner);
    const theirs = await planned(planner);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(
        tx,
        taskScoped,
        'decide',
        { kind: 'record', id: mine.taskId },
        false,
        'billing',
      );
    });
    expect(codeOf(await topUp(taskScoped, theirs.taskId, SMALL, MAXIMUM))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect(await maximumOf(theirs.taskId)).toBe(MAXIMUM);
    appliedDetail(await topUp(taskScoped, mine.taskId, SMALL, MAXIMUM), 'budget.top_up');
    expect(await maximumOf(mine.taskId)).toBe(MAXIMUM + SMALL);
  });

  it('Sol proof, criterion 3: the client-isolation actor has a task share but no business membership', async () => {
    const memberships = await rows<{ readonly id: string }>(
      s,
      `select id from public.memberships
        where business_id = $1 and person_id = $2 and active`,
      [s.business, clientA.personId],
    );
    const shares = await rows<{ readonly id: string }>(
      s,
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'read' and scope_kind = 'record'
          and revoked_at is null`,
      [s.business, clientA.personId],
    );
    expect({ memberships: memberships.length, taskShares: shares.length }).toStrictEqual({
      memberships: 0,
      taskShares: 1,
    });
  });

  it('Sol proof, criterion 3: two external clients each hold one distinct task share in this business', async () => {
    const clients = await rows<{ readonly person_id: string; readonly task_id: string }>(
      s,
      `select g.subject_id as person_id, g.scope_id as task_id from public.grants g
        where g.business_id = $1 and g.subject_kind = 'person' and g.collection = 'task'
          and g.action = 'read' and g.scope_kind = 'record' and g.revoked_at is null
          and not exists(select 1 from public.memberships m
            where m.business_id = g.business_id and m.person_id = g.subject_id and m.active)`,
      [s.business],
    );
    expect(new Set(clients.map((client) => client.person_id)).size).toBe(2);
    expect(new Set(clients.map((client) => client.task_id)).size).toBe(2);
    expect(clients).toHaveLength(2);
  });

  it("business to business: a top-up moves only its own business's envelope", async () => {
    const other = await insertBusiness(s.db.app, `t2e-other-${randomUUID().slice(0, 8)}`);
    await installSpine(s.db.app, other);
    const outsider = await enrol(s.db.app, other, 'outsider');
    await s.db.app.withBusiness(other, async (tx) => {
      for (const action of ['read', 'write', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, outsider, action);
      }
      await grantTo(tx, outsider, 'decide', undefined, false, 'billing');
      await tx.query(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'local', 1000000, 'AUD')`,
        [other, randomUUID()],
      );
    });
    const inOther = async (body: Readonly<Record<string, unknown>>) =>
      await executeCommand(s.db.app, other, outsider.presented, 'api', body as never);
    const created = await inOther({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'the other business' },
    });
    if (isCommandRefusal(created) || created.recordId === null) throw new Error('no task');
    const otherTaskId = created.recordId;
    const proposal = appliedDetail(
      await inOther({
        ...proposeBody(otherTaskId, created.revision ?? 1, {
          purpose: freshPurpose(),
          maximumMinor: MAXIMUM,
        }),
      }),
      'task.propose',
    );
    appliedDetail(await inOther(approveBody(proposal)), 'task.decide');
    const { taskId } = await planned();

    // Each business names the other's task and finds nothing there.
    expect(codeOf(await inOther(topUpBody(taskId, SMALL, MAXIMUM)))).toBe('NOT_FOUND');
    expect(codeOf(await topUp(s.decider, otherTaskId, SMALL, MAXIMUM))).toBe('NOT_FOUND');
    expect(await maximumOf(taskId)).toBe(MAXIMUM);
    expect(await maximumOf(otherTaskId, other)).toBe(MAXIMUM);

    // Each moves its own, and only its own.
    appliedDetail(await topUp(s.decider, taskId, SMALL, MAXIMUM), 'budget.top_up');
    expect(await maximumOf(otherTaskId, other)).toBe(MAXIMUM);
    appliedDetail(await inOther(topUpBody(otherTaskId, SMALL + 1, MAXIMUM)), 'budget.top_up');
    expect(await maximumOf(taskId)).toBe(MAXIMUM + SMALL);
    expect(await maximumOf(otherTaskId, other)).toBe(MAXIMUM + SMALL + 1);
  });
});
