// SPDX-License-Identifier: AGPL-3.0-only
//
// T3f, `expired_lease_money_only` (T3-N2, B22), against a real database.
//
// A worker whose lease ran out after its effect applied still reports what
// the step cost: observe settles that money and marks where it came from
// (`lease: 'expired'`, stored in the register with the answer), and no work
// moves: the lease, the run, the task and the delegation read back as they
// were. Every work transition the same worker then asks for on that lease,
// renewal, a second dispatch or a hand-back, is refused `LEASE_EXPIRED` and
// writes nothing. Red until T2d settles money, and red if any work transition
// comes from an expired lease. Beside it: a live lease's settlement is marked
// `live`, so the mark tells the two apart; the expired lease settles only its
// own business's money, and a worker naming another business's lease is
// refused as not its own.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  codeOf,
  handbackBody,
  openSchedules,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { PRICED, t2dHarness, type Work } from './t2d-harness.ts';
import { cq8World } from './cq-8-world.ts';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { openSecond } from './t3b-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn('runtime/t3f-expired-lease: DATABASE_URL is unset, so nothing below ran.');
}

/** Everything a work transition would move, on the work's own rows. */
const workState = async (on: Schedules, w: Work) =>
  await rows<Record<string, unknown>>(
    on,
    `select l.state as lease, l.fence::text as fence, l.expires_at::text as expires,
            run.state as run, t.revision::text as revision, t.data ->> 'status' as status,
            (d.revoked_at is not null) as delegation_revoked, att.dispatch_marker
       from public.leases l
       join public.records t on t.business_id = l.business_id and t.id = l.task_id
       join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.id = $2`,
    [on.business, w.picked['leaseId']],
  );

const expire = async (on: Schedules, w: Work): Promise<void> => {
  await on.db.admin.execute(
    `update public.leases set expires_at = now() - interval '1 minute' where id = $1`,
    [w.picked['leaseId']],
  );
};

/** The grant check's own refusal, as against R4's membership refusal. */
const NO_GRANT = 'no live grant covers it';
const NO_MEMBERSHIP = 'A person without a membership may read what was shared with them';

/** What of another client's work a refusal must never carry. */
const foreignOf = (
  w: Pick<Work, 'taskId' | 'attemptId' | 'picked' | 'decision'>,
  owner: Member,
): readonly string[] => [
  w.taskId,
  w.attemptId,
  String(w.picked['leaseId']),
  String(w.decision['reservationId']),
  owner.personId,
];

describe.skipIf(url === undefined)(
  'T3f an expired lease moves money only',
  { timeout: 60_000 },
  () => {
    let s: Schedules;
    let other: Schedules;
    const h = t2dHarness(() => s);
    const o = t2dHarness(() => other);

    beforeAll(async () => {
      s = await openSchedules('t3f', 1_000_000);
      other = await openSecond(s, 't3f-other');
      // The client cases share a task with a client, which takes the sharer's grant.
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, s.decider, 'share');
      });
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('expired_lease_money_only: the money settles and is marked expired; no work moves, and every work transition is refused', async () => {
      const w = await h.work();
      await h.applied(w);
      await expire(s, w);
      const before = await workState(s, w);

      // Work transitions from the expired lease: each refused, nothing written.
      const renew = await h.held(w, { command: 'task.heartbeat', leaseSeconds: 900 });
      const again = await h.held(w, { command: 'task.dispatch' });
      const back = await h.held(w, handbackBody(w.picked));
      expect([codeOf(renew), codeOf(again), codeOf(back)]).toStrictEqual([
        'LEASE_EXPIRED',
        'LEASE_EXPIRED',
        'LEASE_EXPIRED',
      ]);
      expect(await workState(s, w)).toStrictEqual(before);

      // The money: settled at the book's price, its origin marked.
      const observed = appliedDetail(await h.observeOf(w, { usage: PRICED }), 'task.observe');
      expect(observed).toMatchObject({ lease: 'expired', settlement: { state: 'settled' } });
      expect(await h.money(w)).toMatchObject({ state: 'actual', attempt_state: 'settled' });
      expect(await workState(s, w)).toStrictEqual(before);

      // The mark is stored with the answer: the register replays it.
      const stored = await rows<{ readonly lease: string }>(
        s,
        `select result -> 'detail' ->> 'lease' as lease from public.operations
        where business_id = $1 and command = 'task.observe' and outcome = 'applied'
          and result -> 'detail' ->> 'attemptId' = $2`,
        [s.business, w.attemptId],
      );
      expect(stored).toEqual([{ lease: 'expired' }]);
    });

    it('a live lease settles marked live, so the mark tells the two apart', async () => {
      const w = await h.work();
      await h.applied(w);
      const observed = appliedDetail(await h.observeOf(w, { usage: PRICED }), 'task.observe');
      expect(observed).toMatchObject({ lease: 'live', settlement: { state: 'settled' } });
    });

    it("client to client: two clients' tasks in one business, each granted; a wrong-client observation is refused and moves neither's money", async () => {
      const world = cq8World(s);
      const a = await h.work();
      const b = await h.work();
      await h.applied(a);
      await h.applied(b);
      await expire(s, a);
      // Each client's external party, sharing its own task: R4 lets it read and nothing more.
      const externalA = await world.client(s.business, s.decider, 't3f-external-a', a.taskId);
      const externalB = await world.client(s.business, s.decider, 't3f-external-b', b.taskId);
      // The person acting for each client: a member of the business whose only
      // grant is write on that client's task, which observe asks on its claim.
      const clientA = await enrol(s.db.app, s.business, 't3f-client-a');
      const clientB = await enrol(s.db.app, s.business, 't3f-client-b');
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, clientA, 'write', { kind: 'record', id: a.taskId });
        await grantTo(tx, clientB, 'write', { kind: 'record', id: b.taskId });
        await grantTo(tx, externalA, 'write', { kind: 'record', id: a.taskId });
        await grantTo(tx, externalB, 'write', { kind: 'record', id: b.taskId });
      });
      const moneyBefore = [await h.money(a), await h.money(b)];
      const workBefore = [await workState(s, a), await workState(s, b)];
      const observeAs = async (who: Member, theirs: Work) =>
        await executeCommand(s.db.app, s.business, who.presented, 'api', {
          command: 'task.observe',
          operationId: randomUUID(),
          leaseId: theirs.picked['leaseId'],
          fence: theirs.picked['fence'],
          attemptId: theirs.attemptId,
          usage: PRICED,
        } as never);
      const crossings = [
        // A's worker, its lease expired, names B's lease and attempt; and back.
        {
          said: await h.held(
            { ...a, picked: b.picked, attemptId: b.attemptId },
            { command: 'task.observe', attemptId: b.attemptId, usage: PRICED },
          ),
          foreign: foreignOf(b, clientB),
          code: 'DELEGATION_OUT_OF_PURPOSE',
        },
        {
          said: await h.held(
            { ...b, picked: a.picked, attemptId: a.attemptId },
            { command: 'task.observe', attemptId: a.attemptId, usage: PRICED },
          ),
          foreign: foreignOf(a, clientA),
          code: 'DELEGATION_OUT_OF_PURPOSE',
        },
        // Each client's person, on the person route, observes the other client's
        // work: refused at the grant, because write on its own task covers no other.
        {
          said: await observeAs(clientA, b),
          foreign: foreignOf(b, clientB),
          code: 'SCOPE_NOT_GRANTED',
          reason: NO_GRANT,
        },
        {
          said: await observeAs(clientB, a),
          foreign: foreignOf(a, clientA),
          code: 'SCOPE_NOT_GRANTED',
          reason: NO_GRANT,
        },
        // Each client's external party, write grant and all: R4 stops it first.
        {
          said: await observeAs(externalA, b),
          foreign: foreignOf(b, clientB),
          code: 'SCOPE_NOT_GRANTED',
          reason: NO_MEMBERSHIP,
        },
        {
          said: await observeAs(externalB, a),
          foreign: foreignOf(a, clientA),
          code: 'SCOPE_NOT_GRANTED',
          reason: NO_MEMBERSHIP,
        },
      ];
      for (const crossing of crossings) {
        // Refused on authority (the delegation's purpose, the grant, R4), never on shape.
        expect(isCommandRefusal(crossing.said) && crossing.said.code).toBe(crossing.code);
        const body = JSON.stringify(crossing.said);
        if ('reason' in crossing) expect(body).toContain(crossing.reason);
        for (const foreign of crossing.foreign) expect(body).not.toContain(foreign);
      }
      // The control: on its own task each client's grant holds, so the same call
      // gets past the grant and is refused only because the lease is the worker's.
      for (const [who, own] of [
        [clientA, a],
        [clientB, b],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop
        const mine = await observeAs(who, own);
        expect(isCommandRefusal(mine) && mine.code).toBe('LEASE_NOT_OWNED');
      }
      expect([await h.money(a), await h.money(b)]).toStrictEqual(moneyBefore);
      expect([await workState(s, a), await workState(s, b)]).toStrictEqual(workBefore);

      // A's own worker settles A's money, marked expired; B's money does not move.
      expect(appliedDetail(await h.observeOf(a, { usage: PRICED }), 'task.observe')).toMatchObject({
        lease: 'expired',
      });
      expect(await h.money(b)).toStrictEqual(moneyBefore[1]);
    });

    it("business to business: an expired lease settles only its own business's money; another business's lease is not its own", async () => {
      const mine = await h.work();
      await h.applied(mine);
      const theirs = await o.work();
      await o.applied(theirs);
      await expire(s, mine);
      const theirMoney = await o.money(theirs);
      const theirWork = await workState(other, theirs);

      // Our worker names their lease, fence and attempt in our business: not ours.
      const crossed = await h.held(
        { ...mine, picked: theirs.picked, attemptId: theirs.attemptId },
        { command: 'task.observe', attemptId: theirs.attemptId, usage: PRICED },
      );
      expect(codeOf(crossed)).toBe('LEASE_NOT_OWNED');
      expect(JSON.stringify(crossed)).not.toContain(theirs.taskId);

      // Our own expired lease settles our money, marked as T3f marks it, and
      // theirs does not move: the crossing beside its positive control.
      const ours = appliedDetail(await h.observeOf(mine, { usage: PRICED }), 'task.observe');
      expect(ours).toMatchObject({ lease: 'expired', settlement: { state: 'settled' } });
      expect(await o.money(theirs)).toStrictEqual(theirMoney);
      expect(await workState(other, theirs)).toStrictEqual(theirWork);
    });
  },
);
