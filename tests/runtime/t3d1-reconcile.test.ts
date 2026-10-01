// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d1, the reconciliation pass, over a real database.
//
// `reconcile_never_repeats` (split 2.2): with the team-only comment as the
// effect, the operation register answers "did it happen?" for a step the sweep
// held unknown. Presence proved settles once, by amount, with the effect
// counter at 1; absence proved resumes the step as a new attempt with its own
// hold and identity, the old identity fenced in the same answer, and a worker
// woken after that is refused under the old identity and audited. Red until
// T2c2's derived operation identity exists; an effect count above one fails it.
//
// The rest of T3d1's checklist, one case each: no answer leaves the step for
// a person; a lost-response retry reuses the identity; the pass is the
// production caller of the recorded-transition replay, and a duplicated
// wake-up does nothing; the replacement goes through T2c1's recheck
// (`T3 replacement dispatch gate`); a person records one of three outcomes,
// by operation identity, under `billing:decide` and never as an agent.
// Separations: business to business (one business's pass never replays
// another's effect, and its outcome command cannot name another's attempt),
// client to client (an external client with a money grant on its own task
// records nothing on another) and person to person (a member without the
// grant records nothing).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import { passDeployment, registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  pickup,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World, PRICED } from './t2d-harness.ts';
import { onLease, openSecond } from './t3b-harness.ts';
import { asMember, CANNOT_ANSWER, openBilling, t3d1Harness } from './t3d1-harness.ts';

const url = databaseUrlFromEnvironment();

describe.skipIf(url === undefined)('T3d1: the reconciliation pass', { timeout: 60_000 }, () => {
  let s: Schedules;
  let other: Schedules;
  let nobody: Member;
  const h = t3d1Harness(() => s);
  const away = t3d1Harness(() => other);

  beforeAll(async () => {
    s = await openSchedules('t3d1', 1_000_000);
    other = await openSecond(s, 'away');
    await openBilling(s);
    await openBilling(other);
    nobody = await enrol(s.db.app, s.business, 'nobody');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, nobody, 'read');
    });
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('reconcile_never_repeats: presence proved settles once, by amount, with the effect counter at 1', async () => {
    const w = await h.unknownStep({ applied: true });
    expect(await h.t3b.money(w)).toMatchObject({ attempt_state: 'liability_unknown' });

    const answered = await h.reconcile();
    expect(answered).toMatchObject([{ attemptId: w.attemptId, answer: 'present' }]);
    // Priced by the book for the one comment the register holds: 1 800 of 2 500.
    expect(await h.t3b.money(w)).toMatchObject({
      state: 'actual',
      actual: '1800',
      attempt_state: 'settled',
      envelope_held: '0',
      envelope_actual: '1800',
    });
    expect(await h.effects(w)).toBe(1);
    expect(await h.replacement(w)).toBeUndefined();

    // A second pass, and the woken worker's retry: nothing moves, nothing repeats.
    const settled = await h.t3b.snapshot();
    expect(await h.reconcile()).toStrictEqual([]);
    expect(codeOf(await h.wokenApply(w))).toBe('applied');
    expect(await h.effects(w)).toBe(1);
    expect(await h.t3b.snapshot()).toStrictEqual(settled);
  });

  it('reconcile_never_repeats: absence proved resumes a new attempt; the woken worker is refused, audited, and moves no money', async () => {
    const w = await h.unknownStep({ applied: false, room: true });
    expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'absent' }]);

    const [old, fresh] = await h.holds(w);
    expect(old).toMatchObject({
      attempt_id: w.attemptId,
      state: 'held',
      held: '2500',
      absence_proved: true,
      attempt_state: 'liability_unknown',
    });
    expect(fresh).toMatchObject({ state: 'held', held: '2500', attempt_state: 'reserved' });
    expect(fresh?.['attempt_id']).not.toBe(w.attemptId);
    // The first attempt's maximum plus the new reservation, and no more.
    expect(await h.envelope(w)).toMatchObject({ held: '5000', actual: '0' });

    // Woken after the re-dispatch: the old identity is refused and recorded.
    const before = await h.t3b.snapshot();
    expect(codeOf(await h.wokenApply(w))).toBe('DELEGATION_NOT_LIVE');
    const audited = await rows(
      s,
      `select outcome, refusal_code from public.audit_events
        where business_id = $1 and operation_id = $2`,
      [s.business, effectOperationId(w.attemptId)],
    );
    expect(audited).toEqual([{ outcome: 'refused', refusal_code: 'DELEGATION_NOT_LIVE' }]);
    // Its late observe moves no money.
    const late = await onLease(s, w, {
      command: 'task.observe',
      attemptId: w.attemptId,
      usage: PRICED,
      outcome: 'failed',
    });
    expect(codeOf(late)).not.toBe('applied');
    expect(await h.t3b.snapshot()).toStrictEqual(before);
    expect(await h.effects(w)).toBe(0);

    // The replacement is ordinary work: picked up, dispatched, applied once
    // under its own identity.
    const picked = await pickup(s, fresh?.['id']);
    const next = {
      ...w,
      picked,
      credential: String(picked['credential']),
      attemptId: String(picked['attemptId']),
    };
    expect(next.attemptId).toBe(fresh?.['attempt_id']);
    await h.t2d.applied(next);
    expect(await h.effects(w)).toBe(1);
    expect(await h.reconcile()).toStrictEqual([]);
  });

  it('a lost-response retry of the same attempt reuses its identity', async () => {
    const w = await h.t2d.work();
    await h.t2d.applied(w);
    const retried = appliedDetail(await h.wokenApply(w), 'task.comment');
    const [comment] = await rows<Record<string, unknown>>(
      s,
      `select result -> 'detail' ->> 'commentId' as id from public.operations
        where business_id = $1 and operation_id = $2`,
      [s.business, effectOperationId(w.attemptId)],
    );
    expect(retried['commentId']).toBe(comment?.['id']);
    expect(await h.effects(w)).toBe(1);
  });

  it('no answer leaves the step liability_unknown for a person', async () => {
    const w = await h.unknownStep({ applied: true, room: true });
    const before = await h.t3b.snapshot();
    expect(await h.reconcile(CANNOT_ANSWER)).toMatchObject([
      { attemptId: w.attemptId, answer: 'unanswered' },
    ]);
    expect(await h.t3b.snapshot()).toStrictEqual(before);
    expect(await h.t3b.money(w)).toMatchObject({
      state: 'held',
      attempt_state: 'liability_unknown',
    });
    // The register's answer is still there for the next pass.
    expect(await h.reconcile()).toMatchObject([{ attemptId: w.attemptId, answer: 'present' }]);
  });

  it('the pass replays recorded transitions, resolves a step whose worker is gone, and a duplicated wake-up does nothing', async () => {
    const keys = new Map([['alpha', s.business]]);
    const resolve = async (key: string) => await Promise.resolve(keys.get(key));
    await passDeployment(s.db.app, resolve, ['alpha'], registerEffectLookup);
    // A lease already fenced whose hold nobody classified: a recorded transition.
    const fenced = await h.t2d.work();
    await s.db.admin.execute(
      `update public.leases set state = 'expired', released_at = now()
        where business_id = $1 and id = $2`,
      [s.business, fenced.picked['leaseId']],
    );
    // A worker that applied once and is gone: its lease ran out unswept.
    const gone = await h.t2d.work();
    await h.t2d.applied(gone);
    await h.t3b.expire(gone);

    const [first, second] = await Promise.all([
      passDeployment(s.db.app, resolve, ['alpha'], registerEffectLookup),
      passDeployment(s.db.app, resolve, ['alpha'], registerEffectLookup),
    ]);
    expect(first.ok || second.ok).toBe(true);
    const after = await h.t3b.snapshot();
    expect(await passDeployment(s.db.app, resolve, ['alpha'], registerEffectLookup)).toMatchObject({
      ok: true,
    });
    expect(await h.t3b.snapshot()).toStrictEqual(after);
    expect(await h.t3b.money(fenced)).toMatchObject({ state: 'abandoned', envelope_held: '0' });
    expect(await h.t3b.money(gone)).toMatchObject({ state: 'actual', actual: '1800' });
    expect(await h.effects(gone)).toBe(1);
  });

  /** A replacement picked up, its approval moved by `move`, then dispatched. */
  const replacementGate = async (move: 'superseded' | 'removed'): Promise<void> => {
    const w = await h.unknownStep({ applied: false, room: true });
    await h.reconcile();
    const picked = await pickup(s, await h.replacement(w));
    const next = {
      ...w,
      picked,
      credential: String(picked['credential']),
      attemptId: String(picked['attemptId']),
    };
    // Moved as T2c1's own recheck case moves it: committed without reaching
    // the lease, which is the race the recheck is inside dispatch for.
    await s.db.admin.execute(
      move === 'superseded'
        ? `update public.proposal_versions set superseded_at = now()
            where business_id = $1 and id = $2`
        : `update public.proposal_lineages
              set state = 'rejected', terminal_reason = 'removed', terminal_at = now()
            where business_id = $1 and id = (select lineage_id from public.proposal_versions
                                              where business_id = $1 and id = $2)`,
      [s.business, w.proposal['versionId']],
    );
    const before = await h.t3b.snapshot();
    const dispatched = await h.t2d.held(next, { command: 'task.dispatch' });
    expect(codeOf(dispatched), move).toBe(
      move === 'superseded' ? 'PROPOSAL_SUPERSEDED' : 'LINEAGE_TERMINAL',
    );
    expect(await h.t3b.snapshot(), move).toStrictEqual(before);
    expect(await h.effects(w), move).toBe(0);
    const receipts = await rows(
      s,
      `select 1 from public.operations where business_id = $1 and operation_id = $2`,
      [s.business, effectOperationId(next.attemptId)],
    );
    expect(receipts, move).toHaveLength(0);
  };

  it('T3 replacement dispatch gate: superseded, then removed, before the replacement dispatches', async () => {
    await replacementGate('superseded');
    await replacementGate('removed');
  });

  it('a person records one of three outcomes, once, replayed by operation identity', async () => {
    const nothing = await h.unknownStep({ applied: false, room: true });
    const operationId = randomUUID();
    const recorded = appliedDetail(
      await h.outcome(nothing, 'nothing_happened', operationId),
      'budget.record_outcome',
    );
    expect(recorded).toMatchObject({
      outcome: 'nothing_happened',
      settlement: { spentMinor: 0, releasedMinor: 2500 },
    });
    // Nothing happened: the hold goes back and the work resumes on a new hold.
    expect(await h.t3b.money(nothing)).toMatchObject({
      state: 'abandoned',
      classified_cause: 'outcome_recorded',
      attempt_state: 'abandoned',
    });
    expect(await h.replacement(nothing)).toBeDefined();
    const once = await h.t3b.snapshot();
    expect(
      appliedDetail(await h.outcome(nothing, 'nothing_happened', operationId), 'replay'),
    ).toStrictEqual(recorded);
    expect(await h.t3b.snapshot()).toStrictEqual(once);
    expect(codeOf(await h.outcome(nothing, 'happened'))).toBe('LIABILITY_NOT_UNKNOWN');

    // It happened: settled at the whole hold, the work finished.
    const happened = await h.unknownStep({ applied: false });
    appliedDetail(await h.outcome(happened, 'happened'), 'budget.record_outcome');
    expect(await h.t3b.money(happened)).toMatchObject({ state: 'actual', actual: '2500' });
    expect(await h.replacement(happened)).toBeUndefined();

    // It happened differently: settled at the whole hold, the work reopened.
    const differently = await h.unknownStep({ applied: false, room: true });
    appliedDetail(await h.outcome(differently, 'happened_differently'), 'budget.record_outcome');
    expect(await h.t3b.money(differently)).toMatchObject({ state: 'actual', actual: '2500' });
    expect(await h.replacement(differently)).toBeDefined();

    // Only the three.
    const w = await h.unknownStep({ applied: false });
    const untouched = await h.t3b.snapshot();
    expect(codeOf(await h.outcome(w, 'unknown'))).toBe('FIELD_VALUE_INVALID');
    // An undeclared field is refused, never ignored.
    const extra = await asPerson(s, {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: w.taskId,
      attemptId: w.attemptId,
      outcome: 'happened',
      actualMinor: 1,
    });
    expect(codeOf(extra)).not.toBe('applied');
    expect(await h.t3b.snapshot()).toStrictEqual(untouched);

    // Two people's records at once, on one attempt: exactly one is recorded.
    const raced = await Promise.all([h.outcome(w, 'happened'), h.outcome(w, 'nothing_happened')]);
    const codes = raced.map((one) => codeOf(one)).toSorted();
    expect(codes).toStrictEqual(['LIABILITY_NOT_UNKNOWN', 'applied']);
    expect(await h.t3b.money(w)).toMatchObject({ envelope_held: '0' });
  });

  it('a happened outcome stops an absence-proof replacement before dispatch', async () => {
    const original = await h.unknownStep({ applied: false, room: true });
    expect(await h.reconcile()).toMatchObject([
      { attemptId: original.attemptId, answer: 'absent' },
    ]);
    const picked = await pickup(s, await h.replacement(original));
    const replacement = {
      ...original,
      picked,
      credential: String(picked['credential']),
      attemptId: String(picked['attemptId']),
    };

    appliedDetail(await h.outcome(original, 'happened'), 'budget.record_outcome');
    const before = await h.t3b.snapshot();
    expect(codeOf(await h.t2d.held(replacement, { command: 'task.dispatch' }))).not.toBe('applied');
    expect(await h.t3b.snapshot()).toStrictEqual(before);
    expect(await h.effects(original)).toBe(0);
  });

  it('T3 isolation and authority: an agent, a person without the grant, another client and another business record nothing', async () => {
    // Client to client: an external client on its own shared task, holding a
    // money grant there that R4 never lets it use, records nothing anywhere;
    // a member whose money grant covers only that other task records nothing
    // here, and naming this attempt on the task it does hold is NOT_FOUND.
    const own = await h.t2d.work();
    const client = await cq8World(s).client(s.business, s.decider, 'client-own', own.taskId);
    const scoped = await enrol(s.db.app, s.business, 'scoped-billing');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, client, 'decide', { kind: 'record', id: own.taskId }, false, 'billing');
      await grantTo(tx, scoped, 'decide', { kind: 'record', id: own.taskId }, false, 'billing');
    });
    const w = await h.unknownStep({ applied: true });
    const before = await h.t3b.snapshot();
    const body = {
      command: 'budget.record_outcome',
      operationId: randomUUID(),
      recordId: w.taskId,
      attemptId: w.attemptId,
      outcome: 'happened',
    };
    // Agent: under its own live delegation, on every entry the envelope serves.
    expect(codeOf(await asAgent(s, body, w.credential))).toBe('DELEGATION_EXCLUDES_OPERATION');
    // Person to person: a member who reads the task and holds no money grant.
    expect(codeOf(await asMember(s, nobody, { ...body, operationId: randomUUID() }))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    const again = (extra: object) => ({ ...body, operationId: randomUUID(), ...extra });
    expect(codeOf(await asMember(s, client, again({})))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await asMember(s, client, again({ recordId: own.taskId })))).toBe(
      'SCOPE_NOT_GRANTED',
    );
    expect(codeOf(await asMember(s, scoped, again({})))).toBe('SCOPE_NOT_GRANTED');
    expect(codeOf(await asMember(s, scoped, again({ recordId: own.taskId })))).toBe('NOT_FOUND');
    expect(await h.t3b.snapshot()).toStrictEqual(before);

    // Business to business: the other business's unknown step is not this pass's.
    const there = await away.unknownStep({ applied: true });
    const awayBefore = await away.t3b.snapshot();
    const answered = await h.reconcile();
    const ids = answered.map((one) => one.attemptId);
    expect(ids).toContain(w.attemptId);
    expect(ids).not.toContain(there.attemptId);
    expect(await away.t3b.snapshot()).toStrictEqual(awayBefore);
    expect(await away.t3b.money(there)).toMatchObject({ attempt_state: 'liability_unknown' });
    // Nor can this business's person name that attempt.
    const across = await asPerson(s, {
      ...body,
      operationId: randomUUID(),
      attemptId: there.attemptId,
    });
    expect(codeOf(across)).toBe('NOT_FOUND');
    // The refusal carries nothing of the other business: no id, no title.
    for (const canary of [there.attemptId, there.taskId, other.business]) {
      expect(JSON.stringify(across)).not.toContain(canary);
    }
    expect(await away.t3b.snapshot()).toStrictEqual(awayBefore);
    expect(await away.reconcile()).toMatchObject([
      { attemptId: there.attemptId, answer: 'present' },
    ]);
  });
});
