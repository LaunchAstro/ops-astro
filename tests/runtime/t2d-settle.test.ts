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
// hand-back still refuses actual spend. Data separation, that a settlement
// moves no other business's envelope and the money line reaches only a reader
// holding the task grant, is `t2d-settle-isolation.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import {
  appliedDetail,
  asAgent,
  capCommitted,
  codeOf,
  handbackBody,
  openSchedules,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { OVER, PRICED, t2dHarness } from './t2d-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2d-settle: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('T2d settlement at the observed cost', () => {
  let s: Schedules;

  const { work, dispatched, applied, observeOf, money, receiptOf, auditsOf } = t2dHarness(() => s);

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

  it('a settled failed attempt cannot apply its effect afterwards', async () => {
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
});
