// SPDX-License-Identifier: AGPL-3.0-only
//
// T3c, the write-off (`budget.write_off`), against a real database.
//
// `write_off_needs_a_person` (T3-N8): a write-off with no person, no amount
// or no reason is refused and moves nothing; one by a person holding budget
// permission closes the unknown liability at the amount they gave (the
// reserved maximum, a lesser figure, or nothing), and the money tables gain
// no row. Red until T3b produces a liability to write off. Beside it: the
// four-eyes band is T2e's stored setting, read and not restated; a lost
// response replays by operation identity; absence proved resumes the work
// while the first hold stays unknown until a person writes it off (O6); two
// people writing off at once, and a write-off racing a recorded outcome, have
// exactly one winner.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  codeOf,
  openSchedules,
  racer,
  settle,
  type Schedules,
} from './schedules-harness.ts';
import { MAXIMUM, type Work } from './t2d-harness.ts';
import { CANNOT_ANSWER, openBilling, t3d1Harness } from './t3d1-harness.ts';
import { holdOf, ledgerRows, REASON, setBand, writeOffBody } from './t3c-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn('runtime/t3c-write-off: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(url === undefined)('T3c the write-off', { timeout: 60_000 }, () => {
  let s: Schedules;
  let second: Member;
  let gateOnly: Member;
  const h = t3d1Harness(() => s);

  const as = async (who: Member, body: object, db = s.db.app) =>
    await executeCommand(db, s.business, who.presented, 'api', body as never);
  const unknownHeld = {
    attempt_state: 'liability_unknown',
    reservation_state: 'held',
    classified_cause: null,
  };

  beforeAll(async () => {
    s = await openSchedules('t3c', 1_000_000);
    await openBilling(s);
    second = await enrol(s.db.app, s.business, 'second');
    gateOnly = await enrol(s.db.app, s.business, 'gate-only');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, second, 'decide', undefined, false, 'billing');
      // Decides plans on every task, and holds no budget permission.
      for (const action of ['read', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, gateOnly, action);
      }
    });
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('write_off_needs_a_person: no person, no amount or no reason is refused; a person closes it; no ledger row', async () => {
    const w = await h.unknownStep({ applied: false });
    const before = await holdOf(s, w);
    expect(before).toMatchObject({ ...unknownHeld, envelope_held: String(MAXIMUM) });
    const ledger = await ledgerRows(s);

    // No person: the agent under the delegation its pickup gave it.
    expect(codeOf(await asAgent(s, writeOffBody(w, 0), w.credential))).toBe(
      'DELEGATION_EXCLUDES_OPERATION',
    );
    // A person who decides plans but holds no budget permission.
    expect(codeOf(await as(gateOnly, writeOffBody(w, 0)))).toBe('SCOPE_NOT_GRANTED');
    // No amount (the wire's exact operand refuses it), and amounts that are not one.
    const { amountMinor: _none, ...noAmount } = writeOffBody(w, 0);
    expect(codeOf(await as(s.decider, noAmount))).toBe('FIELD_VALUE_INVALID');
    for (const amount of [-1, 1.5, '1000', null, MAXIMUM + 1]) {
      // eslint-disable-next-line no-await-in-loop
      const code = codeOf(await as(s.decider, writeOffBody(w, amount)));
      expect(code, String(amount)).toBe('FIELD_VALUE_INVALID');
    }
    // No written reason.
    for (const reason of [undefined, '', '   ', 42]) {
      // eslint-disable-next-line no-await-in-loop
      const code = codeOf(await as(s.decider, writeOffBody(w, 1_000, { reason })));
      expect(code, String(reason)).toMatch(/^(COMMAND_BODY_INVALID|FIELD_VALUE_INVALID)$/u);
    }
    expect(await holdOf(s, w)).toStrictEqual(before);

    const written = appliedDetail(await as(s.decider, writeOffBody(w, 1_000)), 'budget.write_off');
    expect(written).toMatchObject({
      state: 'applied',
      attemptId: w.attemptId,
      amountMinor: 1_000,
      reason: REASON,
      approvers: [s.decider.personId],
    });
    expect(await holdOf(s, w)).toStrictEqual({
      attempt_state: 'settled',
      outcome: 'unknown',
      attempt_actual: '1000',
      reservation_state: 'actual',
      reservation_actual: '1000',
      classified_cause: null,
      envelope_held: '0',
      envelope_actual: '1000',
    });
    expect(await ledgerRows(s)).toStrictEqual(ledger);
  });

  it('nothing charged gives the whole hold back under the write-off; the reserved maximum spends it all', async () => {
    const nothing = await h.unknownStep({ applied: true });
    appliedDetail(await as(s.decider, writeOffBody(nothing, 0)), 'budget.write_off');
    expect(await holdOf(s, nothing)).toMatchObject({
      attempt_state: 'abandoned',
      outcome: 'abandoned',
      attempt_actual: null,
      reservation_state: 'abandoned',
      classified_cause: 'written_off',
      envelope_held: '0',
      envelope_actual: '0',
    });
    const whole = await h.unknownStep({ applied: true });
    appliedDetail(await as(s.decider, writeOffBody(whole, MAXIMUM)), 'budget.write_off');
    expect(await holdOf(s, whole)).toMatchObject({
      attempt_state: 'settled',
      reservation_actual: String(MAXIMUM),
      envelope_held: '0',
      envelope_actual: String(MAXIMUM),
    });
  });

  it('a lost response replays by operation identity; a second write-off finds nothing unknown', async () => {
    const w = await h.unknownStep({ applied: false });
    const body = writeOffBody(w, 700);
    const first = appliedDetail(await as(s.decider, body), 'budget.write_off');
    const after = await holdOf(s, w);
    expect(appliedDetail(await as(s.decider, body), 'budget.write_off')).toStrictEqual(first);
    expect(await holdOf(s, w)).toStrictEqual(after);
    expect(codeOf(await as(second, writeOffBody(w, 700)))).toBe('LIABILITY_NOT_UNKNOWN');
    expect(await holdOf(s, w)).toStrictEqual(after);
  });

  it('O6: absence proved resumes the work, and the first hold stays unknown until a person writes it off', async () => {
    const w = await h.unknownStep({ applied: false, room: true });
    const answered = (await h.reconcile()).find((one) => one.attemptId === w.attemptId);
    expect(answered?.answer).toBe('absent');
    const replacement = await h.replacement(w);
    expect(replacement).toBeDefined();
    // The pass again, and again with no answer: no machine path releases it.
    await h.reconcile();
    await h.reconcile(CANNOT_ANSWER);
    expect(await holdOf(s, w)).toMatchObject(unknownHeld);
    const holds = await h.holds(w);

    appliedDetail(await as(s.decider, writeOffBody(w, 0)), 'budget.write_off');
    expect(await holdOf(s, w)).toMatchObject({ reservation_state: 'abandoned' });
    // The write-off resumes nothing: the replacement is the one hold left.
    const now = await h.holds(w);
    expect(now).toHaveLength(holds.length);
    expect(now.find((hold) => hold['id'] === replacement)).toMatchObject({
      state: 'held',
      attempt_state: 'reserved',
    });
  });

  it('above the four-eyes band a second person names the same figure; the band is the stored setting', async () => {
    // 10.00 is below the hold of 25.00, so the band bites.
    await setBand(s, '10');
    try {
      const w = await h.unknownStep({ applied: false });
      const before = await holdOf(s, w);
      expect(
        appliedDetail(await as(s.decider, writeOffBody(w, 900)), 'budget.write_off'),
      ).toMatchObject({
        state: 'awaiting_second_approver',
        firstApproverPersonId: s.decider.personId,
      });
      expect(codeOf(await as(s.decider, writeOffBody(w, 900)))).toBe('FOUR_EYES_REQUIRED');
      // A different figure is a first approval of its own, not a pair.
      expect(
        appliedDetail(await as(second, writeOffBody(w, 800)), 'budget.write_off'),
      ).toMatchObject({ state: 'awaiting_second_approver' });
      expect(await holdOf(s, w)).toStrictEqual(before);
      expect(
        appliedDetail(await as(second, writeOffBody(w, 900)), 'budget.write_off'),
      ).toMatchObject({ state: 'applied', approvers: [s.decider.personId, second.personId] });
      expect(await holdOf(s, w)).toMatchObject({ reservation_actual: '900' });

      // Off: one person at any amount.
      await setBand(s, 'null');
      const off = await h.unknownStep({ applied: false });
      expect(
        appliedDetail(await as(s.decider, writeOffBody(off, 900)), 'budget.write_off'),
      ).toMatchObject({ state: 'applied' });
    } finally {
      await setBand(s, '100000');
    }
  });

  it('person to person: a first approval whose holder lost the grant pairs with no one', async () => {
    await setBand(s, '10');
    try {
      const lapsing = await enrol(s.db.app, s.business, 'lapsing');
      const grantId = await s.db.app.withBusiness(
        s.business,
        async (tx) => await grantTo(tx, lapsing, 'decide', undefined, false, 'billing'),
      );
      const w = await h.unknownStep({ applied: false });
      appliedDetail(await as(lapsing, writeOffBody(w, 900)), 'budget.write_off');
      await s.db.admin.execute('update public.grants set revoked_at = now() where id = $1', [
        grantId,
      ]);
      expect(
        appliedDetail(await as(second, writeOffBody(w, 900)), 'budget.write_off'),
      ).toMatchObject({
        state: 'awaiting_second_approver',
        firstApproverPersonId: second.personId,
      });
      expect(await holdOf(s, w)).toMatchObject(unknownHeld);
    } finally {
      await setBand(s, '100000');
    }
  });

  it('two people writing off at once, and a write-off racing a recorded outcome: exactly one winner', async () => {
    const other = racer(s);
    try {
      const w = await h.unknownStep({ applied: false });
      const both = await settle([
        as(s.decider, writeOffBody(w, 600)),
        as(second, writeOffBody(w, 400), other),
      ]);
      const codes = both.map((one) => (one.status === 'fulfilled' ? codeOf(one.value) : 'threw'));
      expect(codes.toSorted()).toStrictEqual(['LIABILITY_NOT_UNKNOWN', 'applied']);
      const won = (await holdOf(s, w)) as Record<string, unknown>;
      expect(['600', '400']).toContain(won['reservation_actual']);
      expect(won['envelope_actual']).toBe(won['reservation_actual']);

      const raced: Work = await h.unknownStep({ applied: false });
      const pair = await settle([
        as(s.decider, writeOffBody(raced, 500)),
        h.outcome(raced, 'happened_differently'),
      ]);
      const answers = pair.map((one) => (one.status === 'fulfilled' ? codeOf(one.value) : 'threw'));
      expect(answers.toSorted()).toStrictEqual(['LIABILITY_NOT_UNKNOWN', 'applied']);
      expect(await holdOf(s, raced)).toMatchObject({ reservation_state: 'actual' });
    } finally {
      await other.close();
    }
  });

  it('refuses an operation id reused with another figure', async () => {
    const w = await h.unknownStep({ applied: false });
    const operationId = randomUUID();
    appliedDetail(
      await as(s.decider, { ...writeOffBody(w, 300), operationId }),
      'budget.write_off',
    );
    expect(codeOf(await as(s.decider, { ...writeOffBody(w, 301), operationId }))).toBe(
      'OPERATION_ID_REUSED',
    );
    expect(await holdOf(s, w)).toMatchObject({ reservation_actual: '300' });
  });
});
