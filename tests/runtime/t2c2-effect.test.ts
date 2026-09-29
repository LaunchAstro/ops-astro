// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c2, the local effect, its observation and its receipt, over a real
// database through both command entries and the read entry.
//
// `effect_once_with_receipt` (split 1.2): approve, dispatch, apply the one
// team-only comment under the operation identity derived from the attempt,
// observe it, and read a receipt citing that decision, its bound version and
// the effect. A second worker pass replays every step and adds nothing. A
// staged intent (dispatched, no effect applied) satisfies no observed-effect
// assertion: observe refuses it and no receipt reads. Red until T2c1 can
// dispatch; red if observe accepts an attempt whose effect is not in the
// operation register.
//
// Observe is the lease holder's alone, with its own token: a non-holder, a
// foreign, unknown or fenced token, or a released hold is refused, audited
// and moves no money. Data separation: another business's receipt reads as a
// made-up one, and a person outside the task's client is refused.

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
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  scalar,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World, type Party } from './cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2c2-effect: DATABASE_URL is unset, so nothing below ran.');
}

interface Work {
  readonly taskId: string;
  readonly proposal: Detail;
  readonly decision: Detail;
  readonly picked: Detail;
  readonly credential: string;
  readonly attemptId: string;
}

describe.skipIf(serverUrl === undefined)('T2c2 the effect, its observation and receipt', () => {
  let s: Schedules;
  let bravo: Party;

  /** Proposed as the synthetic comment step, approved by the decider, picked up by the agent. */
  async function work(): Promise<Work> {
    const taskId = await createTask(s, `t2c2 ${randomUUID()}`);
    const body = {
      ...proposeBody(taskId, await revisionOf(s, taskId), { purpose: freshPurpose() }),
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

  const dispatchOf = async (w: Work, operationId = randomUUID()) =>
    await asAgent(
      s,
      {
        command: 'task.dispatch',
        operationId,
        leaseId: w.picked['leaseId'],
        fence: w.picked['fence'],
      },
      w.credential,
    );

  const effectOf = async (w: Work) =>
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
    );

  const observeOf = async (w: Work, change: Readonly<Record<string, unknown>> = {}) =>
    await asAgent(
      s,
      {
        command: 'task.observe',
        operationId: randomUUID(),
        leaseId: w.picked['leaseId'],
        fence: w.picked['fence'],
        attemptId: w.attemptId,
        ...change,
      },
      w.credential,
    );

  const receiptOf = async (attemptId: string, who: Member = s.decider, business = s.business) =>
    await executeRead(s.db.app, business, who.presented, {
      read: 'task.receipt',
      attemptId,
    } as never);

  const comments = async (taskId: string): Promise<number> =>
    await scalar(
      s,
      `select count(*)::text as n from public.records r
         join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        where r.business_id = $1 and t.key = 'task_comment' and r.data ->> 'task' = $2`,
      [s.business, taskId],
    );

  const money = async (w: Work) =>
    await rows<Record<string, unknown>>(
      s,
      `select res.state, res.held_minor::text, res.lease_id, env.held_minor::text as envelope_held,
              att.state as attempt_state, att.actual_minor, att.observed
         from public.reservations res
         join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
         join public.task_envelopes env on env.business_id = res.business_id and env.id = att.envelope_id
        where res.business_id = $1 and res.id = $2`,
      [s.business, w.decision['reservationId']],
    );

  beforeAll(async () => {
    s = await openSchedules('t2c2', 1_000_000);
    bravo = await cq8World(s).party('t2c2-bravo');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('effect_once_with_receipt: reservation, dispatch, one effect and a receipt citing the decision; a second pass adds nothing', async () => {
    const w = await work();
    expect((await money(w))[0]).toMatchObject({ state: 'held', attempt_state: 'dispatched' });
    const dispatched = appliedDetail(await dispatchOf(w), 'task.dispatch');
    expect(dispatched['attemptId']).toBe(w.attemptId);
    const effect = appliedDetail(await effectOf(w), 'task.comment');
    const observed = appliedDetail(await observeOf(w), 'task.observe');
    expect(observed).toMatchObject({
      attemptId: w.attemptId,
      effect: { operationId: effectOperationId(w.attemptId), commentId: effect['commentId'] },
    });

    const receipt = await receiptOf(w.attemptId);
    if (!('receipt' in receipt)) throw new Error(`receipt refused ${JSON.stringify(receipt)}`);
    expect(receipt.receipt).toStrictEqual({
      attemptId: w.attemptId,
      taskId: w.taskId,
      decision: {
        id: w.decision['decisionId'],
        gateId: w.proposal['gateId'],
        decidedByPersonId: s.decider.personId,
        decidedAt: expect.any(String),
      },
      version: { id: w.proposal['versionId'], number: w.proposal['version'] },
      effect: {
        kind: 'synthetic_comment',
        operationId: effectOperationId(w.attemptId),
        commentId: effect['commentId'],
        audience: 'internal',
      },
    });
    // No undo control: nothing on the receipt names an operation to reverse it.
    expect(JSON.stringify(receipt)).not.toMatch(/undo|revert|reverse|command/iu);

    // A second worker pass: the mark, the effect and the observation replay.
    const again = appliedDetail(await dispatchOf(w), 'task.dispatch');
    expect(again['dispatchedAt']).toBe(dispatched['dispatchedAt']);
    expect(appliedDetail(await effectOf(w), 'task.comment')).toStrictEqual(effect);
    expect(appliedDetail(await observeOf(w), 'task.observe')).toStrictEqual(observed);
    expect(await comments(w.taskId)).toBe(1);
    expect(
      await scalar(s, 'select count(*)::text as n from public.attempts where reservation_id = $1', [
        w.decision['reservationId'],
      ]),
    ).toBe(1);
    expect((await money(w))[0]).toMatchObject({ state: 'held', observed: true });
  });

  it('a staged intent satisfies no observed-effect assertion: observe refuses it and no receipt reads', async () => {
    const w = await work();
    appliedDetail(await dispatchOf(w), 'task.dispatch');
    expect(codeOf(await observeOf(w))).toBe('EFFECT_NOT_OBSERVED');
    expect(await receiptOf(w.attemptId)).toMatchObject({ code: 'NOT_FOUND' });
    expect((await money(w))[0]).toMatchObject({ observed: false });
    expect(await comments(w.taskId)).toBe(0);
  });

  it('no effect before its dispatch: the effect identity is refused until the step is marked', async () => {
    const w = await work();
    expect(codeOf(await effectOf(w))).toBe('EFFECT_NOT_DISPATCHED');
    expect(await comments(w.taskId)).toBe(0);
  });

  it('Sol proof, criterion 3: an effect identity cannot write a client-visible comment', async () => {
    const taskId = await createTask(s, `t2c2 person effect ${randomUUID()}`);
    const proposal = appliedDetail(
      await asPerson(s, {
        ...proposeBody(taskId, await revisionOf(s, taskId), { purpose: freshPurpose() }),
        step: { kind: 'synthetic_comment', payload: {} },
      }),
      'task.propose',
    );
    const decision = await approve(s, proposal);
    const picked = appliedDetail(
      await asPerson(s, {
        command: 'task.pickup',
        operationId: randomUUID(),
        reservationId: decision['reservationId'],
      }),
      'task.pickup',
    );
    appliedDetail(
      await asPerson(s, {
        command: 'task.dispatch',
        operationId: randomUUID(),
        leaseId: picked['leaseId'],
        fence: picked['fence'],
      }),
      'task.dispatch',
    );
    const attemptId = String(picked['attemptId']);
    const effect = await asPerson(s, {
      command: 'task.comment',
      operationId: effectOperationId(attemptId),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      body: 'Client-visible effect under the attempt identity',
      audience: 'client',
    });
    expect(codeOf(effect)).not.toBe('applied');
    expect(await comments(taskId)).toBe(0);
    expect(await receiptOf(attemptId)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the effect applies exactly once under duplicate delivery and a lost response', async () => {
    const w = await work();
    // A lost dispatch response: asked again, the committed mark and identity come back.
    const first = appliedDetail(await dispatchOf(w), 'task.dispatch');
    const lost = appliedDetail(await dispatchOf(w), 'task.dispatch');
    expect(lost).toStrictEqual(first);
    // Duplicate delivery, at once, and a retry after a lost answer.
    const [one, two] = await Promise.all([effectOf(w), effectOf(w)]);
    const retried = await effectOf(w);
    expect(appliedDetail(two, 'task.comment')).toStrictEqual(appliedDetail(one, 'task.comment'));
    expect(appliedDetail(retried, 'task.comment')).toStrictEqual(
      appliedDetail(one, 'task.comment'),
    );
    expect(await comments(w.taskId)).toBe(1);
    const marks = await rows<{ readonly n: string }>(
      s,
      `select count(*)::text as n from public.attempts where reservation_id = $1 and dispatch_marker`,
      [w.decision['reservationId']],
    );
    expect(marks[0]?.n).toBe('1');
  });

  it('observe is the lease holder’s with its own token; every other caller is refused, audited and moves no money', async () => {
    const w = await work();
    const other = await work();
    appliedDetail(await dispatchOf(w), 'task.dispatch');
    appliedDetail(await effectOf(w), 'task.comment');
    const before = await money(w);
    const person = await asPerson(s, {
      command: 'task.observe',
      operationId: randomUUID(),
      leaseId: w.picked['leaseId'],
      fence: w.picked['fence'],
      attemptId: w.attemptId,
    });
    const cases = [
      ['non-holder', person, 'LEASE_NOT_OWNED'],
      ['foreign token', await observeOf(w, { attemptId: other.attemptId }), 'LEASE_NOT_OWNED'],
      ['unknown token', await observeOf(w, { attemptId: randomUUID() }), 'LEASE_NOT_OWNED'],
      [
        'fenced token',
        await observeOf(w, { fence: Number(w.picked['fence']) + 1 }),
        'LEASE_NOT_OWNED',
      ],
    ] as const;
    for (const [name, answer, code] of cases) expect(codeOf(answer), name).toBe(code);
    expect(await money(w)).toStrictEqual(before);

    // A released hold: the attempt's money is gone, so nothing is observed against it.
    await s.db.admin.execute(
      `update public.reservations set state = 'abandoned',
              classified_cause = 'lease_expired_and_fenced', terminal_at = now()
        where id = $1`,
      [w.decision['reservationId']],
    );
    const released = await money(w);
    expect(codeOf(await observeOf(w))).toBe('BUDGET_UNAVAILABLE');
    expect(await money(w)).toStrictEqual(released);
    expect((await money(w))[0]).toMatchObject({ observed: false, actual_minor: null });

    const audited = await scalar(
      s,
      `select count(*)::text as n from public.audit_events
        where business_id = $1 and command = 'task.observe' and outcome = 'refused'`,
      [s.business],
    );
    expect(audited).toBeGreaterThanOrEqual(cases.length + 1);
  });

  it('T2 isolation: another business’s receipt reads as a made-up one, and a person outside the task’s client is refused', async () => {
    const w = await work();
    appliedDetail(await dispatchOf(w), 'task.dispatch');
    appliedDetail(await effectOf(w), 'task.comment');
    appliedDetail(await observeOf(w), 'task.observe');
    expect(await receiptOf(w.attemptId)).toHaveProperty('receipt');

    const made = randomUUID();
    const foreign = await receiptOf(w.attemptId, bravo.member, bravo.id);
    const none = await receiptOf(made, bravo.member, bravo.id);
    expect(JSON.stringify(foreign).replaceAll(w.attemptId, 'A')).toBe(
      JSON.stringify(none).replaceAll(made, 'A'),
    );
    expect(foreign).toMatchObject({ code: 'NOT_FOUND' });

    // A client of another task in this business, and a member with no grant.
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const elsewhere = await createTask(s, `t2c2 elsewhere ${randomUUID()}`);
    const outsider = await cq8World(s).client(s.business, s.decider, 't2c2-client', elsewhere);
    expect(await receiptOf(w.attemptId, outsider)).toMatchObject({ code: 'NOT_FOUND' });
    // The task's own client sees the shared view, which carries no decision: no receipt either.
    const own = await cq8World(s).client(s.business, s.decider, 't2c2-own', w.taskId);
    expect(await receiptOf(w.attemptId, own)).toMatchObject({ code: 'NOT_FOUND' });
    const idle = await enrol(s.db.app, s.business, 't2c2-idle');
    expect(await receiptOf(w.attemptId, idle)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(await receiptOf(w.attemptId, outsider))).not.toContain(w.taskId);
  });
});
