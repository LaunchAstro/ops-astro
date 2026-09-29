// SPDX-License-Identifier: AGPL-3.0-only
//
// T2d, settlement at the observed cost, over a real database through both
// command entries and the read entry.
//
// `settles_at_observed` (split 1.2): reserve the estimated maximum, observe a
// smaller priced cost, and the hold settles to the observed figure with the
// difference released; settling twice charges once; an unpriced attempt reads
// as unpriced. Red until T2c2 produces an observed attempt; red if `0026` is
// left in place, because its `state <> 'actual'` refuses the settled row.
//
// The rest of T2d's checklist, one case each: the receipt names the settled
// amount; step, reservation and audit event are one transaction; an expired
// lease settles money and moves no work; a cost above the hold is refused,
// audited with the observed amount and held as `liability_unknown` at the
// maximum; a failed attempt settles at its cost and counts against the cap;
// hand-back still refuses actual spend. Data separation: a settlement moves no
// other business's envelope, and the money line reaches only a reader holding
// the task grant.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  capCommitted,
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
import { cq8World } from './cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2d-settle: DATABASE_URL is unset, so nothing below ran.');
}

/** The estimated maximum the proposal asks a person to hold. */
const MAXIMUM = 2_500;
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

describe.skipIf(serverUrl === undefined)('T2d settlement at the observed cost', () => {
  let s: Schedules;

  async function work(): Promise<Work> {
    const taskId = await createTask(s, `t2d ${randomUUID()}`);
    const body = {
      ...proposeBody(taskId, await revisionOf(s, taskId), {
        purpose: freshPurpose(),
        maximumMinor: MAXIMUM,
      }),
      step: { kind: 'synthetic_comment', payload: {} },
    };
    const proposal = appliedDetail(await asPerson(s, body), 'task.propose');
    const decision = await approve(s, proposal);
    const picked = await pickup(s, decision['reservationId']);
    return {
      taskId,
      proposal,
      decision,
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

  const money = async (w: Work) =>
    (
      await rows<Record<string, unknown>>(
        s,
        `select res.state, res.held_minor::text as held, res.actual_minor::text as actual,
                att.state as attempt_state, att.outcome, att.actual_minor::text as attempt_actual,
                att.observed, env.held_minor::text as envelope_held,
                env.actual_minor::text as envelope_actual
           from public.reservations res
           join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
           join public.task_envelopes env on env.business_id = res.business_id and env.id = att.envelope_id
          where res.business_id = $1 and res.id = $2`,
        [s.business, w.decision['reservationId']],
      )
    )[0];

  const receiptOf = async (attemptId: string, who: Member = s.decider) =>
    await executeRead(s.db.app, s.business, who.presented, {
      read: 'task.receipt',
      attemptId,
    } as never);

  const auditsOf = async (outcome: string) =>
    await rows<{ readonly refusal_code: string | null; readonly attempted: unknown }>(
      s,
      `select refusal_code, attempted from public.audit_events
        where business_id = $1 and command = 'task.observe' and outcome = $2
        order by occurred_at`,
      [s.business, outcome],
    );

  beforeAll(async () => {
    s = await openSchedules('t2d', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('settles_at_observed: the hold settles to the observed cost, the rest is released, and settling twice charges once', async () => {
    const w = await work();
    await applied(w);
    const capBefore = await capCommitted(s);
    expect(await money(w)).toMatchObject({ state: 'held', held: '2500', envelope_held: '2500' });

    const observed = appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    expect(observed['settlement']).toStrictEqual({
      state: 'settled',
      heldMinor: 2_500,
      spentMinor: 1_800,
      releasedMinor: 700,
    });
    expect(await money(w)).toStrictEqual({
      state: 'actual',
      held: '2500',
      actual: '1800',
      attempt_state: 'settled',
      outcome: 'completed',
      attempt_actual: '1800',
      observed: true,
      envelope_held: '0',
      envelope_actual: '1800',
    });
    // The non-zero release, by amount: the cap gave back exactly 700.
    expect(capBefore - (await capCommitted(s))).toBe(700);

    // Settling twice charges once, whatever the second report says.
    const again = appliedDetail(await observeOf(w, { usage: OVER }), 'task.observe');
    expect(again['settlement']).toStrictEqual(observed['settlement']);
    expect(await money(w)).toMatchObject({ actual: '1800', envelope_actual: '1800' });
    expect(capBefore - (await capCommitted(s))).toBe(700);
  });

  it('the receipt names the settled amount, and the one invariant fails without its settlement leg', async () => {
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    const receipt = await receiptOf(w.attemptId);
    if (!('receipt' in receipt)) throw new Error(`receipt refused ${JSON.stringify(receipt)}`);
    const read = receipt.receipt;
    // Reservation, dispatch, effect, receipt and now settlement, in one read.
    expect(read.decision).toMatchObject({ id: w.decision['decisionId'] });
    expect(read.effect).toMatchObject({ operationId: effectOperationId(w.attemptId) });
    expect(read.settlement).toStrictEqual({
      state: 'settled',
      heldMinor: 2_500,
      spentMinor: 1_800,
      releasedMinor: 700,
    });
  });

  it('an unpriced attempt or absent spend is neither zero nor success: it reads as unpriced and moves no money', async () => {
    const w = await work();
    await applied(w);
    const before = await money(w);
    // One after the other: the second is asked of an attempt the first observed.
    const absent = appliedDetail(await observeOf(w), 'task.observe');
    const unknown = appliedDetail(
      await observeOf(w, { usage: { item: 'not_in_the_book', quantity: 1 } }),
      'task.observe',
    );
    for (const answer of [absent, unknown]) {
      expect(answer['settlement']).toStrictEqual({ state: 'unpriced', heldMinor: 2_500 });
    }
    expect(await money(w)).toStrictEqual({ ...before, observed: true });
    const receipt = await receiptOf(w.attemptId);
    if (!('receipt' in receipt)) throw new Error('an observed attempt has a receipt');
    expect(receipt.receipt.settlement).toStrictEqual({
      state: 'unpriced',
      heldMinor: 2_500,
    });
  });

  it('a cost above the hold is refused, audited with the observed amount, and held as liability_unknown at the maximum', async () => {
    const w = await work();
    await applied(w);
    const capBefore = await capCommitted(s);
    expect(codeOf(await observeOf(w, { usage: OVER }))).toBe('BUDGET_UNAVAILABLE');
    expect(await money(w)).toMatchObject({
      state: 'held',
      held: '2500',
      actual: null,
      attempt_state: 'liability_unknown',
      attempt_actual: null,
      envelope_held: '2500',
      envelope_actual: '0',
    });
    expect(await capCommitted(s)).toBe(capBefore);
    const refusals = await auditsOf('refused');
    expect(refusals.at(-1)).toMatchObject({
      refusal_code: 'BUDGET_UNAVAILABLE',
      attempted: { observedMinor: 3_200 },
    });
    // No machine path leaves it: a smaller report later settles nothing.
    expect(codeOf(await observeOf(w, { usage: PRICED }))).toBe('BUDGET_UNAVAILABLE');
    expect(await money(w)).toMatchObject({ state: 'held', attempt_state: 'liability_unknown' });
  });

  it('a failed attempt settles at its observed cost and counts against the ceiling', async () => {
    const w = await work();
    await dispatched(w);
    const capBefore = await capCommitted(s);
    const answer = appliedDetail(
      await observeOf(w, { usage: PRICED, outcome: 'failed' }),
      'task.observe',
    );
    expect(answer['settlement']).toMatchObject({ state: 'settled', spentMinor: 1_800 });
    expect(await money(w)).toMatchObject({
      state: 'actual',
      attempt_state: 'settled',
      outcome: 'failed',
      observed: false,
      envelope_actual: '1800',
    });
    expect(capBefore - (await capCommitted(s))).toBe(700);
    // Nothing was applied, so there is no receipt to read.
    expect(await receiptOf(w.attemptId)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('Sol proof, criterion 2: a settled failed attempt cannot apply its effect afterwards', async () => {
    const w = await work();
    await dispatched(w);
    appliedDetail(await observeOf(w, { usage: PRICED, outcome: 'failed' }), 'task.observe');
    expect(await money(w)).toMatchObject({ attempt_state: 'settled', outcome: 'failed' });

    const effect = await asAgent(
      s,
      {
        command: 'task.comment',
        operationId: effectOperationId(w.attemptId),
        recordId: w.taskId,
        body: 'This effect arrived after the attempt failed.',
        audience: 'internal',
      },
      w.credential,
    );
    expect(codeOf(effect)).not.toBe('applied');
    expect(await receiptOf(w.attemptId)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an expired lease settles the money and moves no work', async () => {
    const w = await work();
    await applied(w);
    await s.db.admin.execute(
      `update public.leases set expires_at = now() - interval '1 minute' where id = $1`,
      [w.picked['leaseId']],
    );
    const workState = `select l.state as lease, t.revision::text as revision, t.data ->> 'status' as status
                     from public.leases l join public.records t on t.id = l.task_id where l.id = $1`;
    const before = await rows(s, workState, [w.picked['leaseId']]);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    expect(await money(w)).toMatchObject({ state: 'actual', actual: '1800' });
    expect(await rows(s, workState, [w.picked['leaseId']])).toStrictEqual(before);
  });

  it.each([
    ['the step', 'attempts', 'update'],
    ['the reservation', 'reservations', 'update'],
    ['the audit event', 'audit_events', 'insert'],
  ] as const)(
    'step, reservation and audit event commit together: a failure in %s rolls back all three',
    async (_label, table, event) => {
      const w = await work();
      await applied(w);
      const before = await money(w);
      const applies = (await auditsOf('applied')).length;
      const name = `t2d_fail_${table}`;
      await s.db.admin.execute(
        `create function public.${name}() returns trigger language plpgsql as $$
         begin raise exception 't2d injected failure'; end $$`,
      );
      await s.db.admin.execute(
        `create trigger ${name} before ${event} on public.${table} for each row
           when (${event === 'insert' ? `new.command = 'task.observe'` : `new.state in ('settled', 'actual')`})
           execute function public.${name}()`,
      );
      try {
        await expect(observeOf(w, { usage: PRICED })).rejects.toThrow();
      } finally {
        await s.db.admin.execute(`drop trigger ${name} on public.${table}`);
        await s.db.admin.execute(`drop function public.${name}()`);
      }
      expect(await money(w)).toStrictEqual({ ...before, observed: false });
      expect((await auditsOf('applied')).length).toBe(applies);
    },
  );

  it('hand-back keeps refusing actual spend, settled or not', async () => {
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    const answer = await asAgent(
      s,
      { ...handbackBody(w.picked), actualMinor: 1_800 },
      w.credential,
    );
    expect(codeOf(answer)).toBe('ACTUAL_EXPENDITURE_UNSUPPORTED');
    expect(await money(w)).toMatchObject({ actual: '1800', envelope_actual: '1800' });
  });

  it('Sol proof, criterion 3: a populated foreign envelope and a wrong client stay isolated', async () => {
    const bravo = await cq8World(s).party('t2d-bravo');
    const others = async () =>
      await rows(
        s,
        `select business_id, id, held_minor::text, actual_minor::text from public.task_envelopes
          where business_id = $1 order by id`,
        [bravo.id],
      );
    const before = await others();
    expect(before.length).toBeGreaterThan(0);
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    expect(await others()).toStrictEqual(before);
    // Another business's member reads no receipt and no money for it.
    const foreign = await executeRead(s.db.app, bravo.id, bravo.member.presented, {
      read: 'task.receipt',
      attemptId: w.attemptId,
    } as never);
    expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(foreign)).not.toContain('1800');

    const otherTask = await createTask(s, `t2d other client ${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const ownClient = await cq8World(s).client(s.business, s.decider, 't2d-own', w.taskId);
    const wrongClient = await cq8World(s).client(s.business, s.decider, 't2d-wrong', otherTask);
    const own = await executeRead(s.db.app, s.business, ownClient.presented, {
      read: 'task.read',
      recordId: w.taskId,
    } as never);
    expect(own).toHaveProperty('sharedTask');
    expect(JSON.stringify(own)).not.toContain('1800');
    const crossed = await executeRead(s.db.app, s.business, wrongClient.presented, {
      read: 'task.read',
      recordId: w.taskId,
    } as never);
    expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(crossed)).not.toContain('1800');
  });

  it('the money line reaches only a reader holding the task grant', async () => {
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    const readAs = async (who: Member) =>
      await executeRead(s.db.app, s.business, who.presented, {
        read: 'task.read',
        recordId: w.taskId,
      } as never);
    const granted = JSON.stringify(await readAs(s.decider));
    expect(granted).toContain('"actualMinor":1800');
    expect(granted).toContain('"releasedMinor":700');

    const idle = await enrol(s.db.app, s.business, 't2d-idle');
    const refused = await readAs(idle);
    expect(refused).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const client = await cq8World(s).client(s.business, s.decider, 't2d-own', w.taskId);
    const shared = JSON.stringify(await readAs(client));
    expect(shared).not.toMatch(/actualMinor|releasedMinor|heldMinor/u);
  });
});
