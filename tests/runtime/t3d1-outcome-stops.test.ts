// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d1, Sol review 1 on #146, criterion 2: a person's `happened` says the work
// is finished, so the replacement the pass reserved when it proved the first
// effect absent is stopped in the same transaction, under the same locks, and
// never dispatches. One case each: the replacement's hold goes back, its lease
// ends and its delegation is revoked, and a lost response replays without
// moving anything; `happened` racing the replacement's dispatch has exactly
// one winner; a replacement that already dispatched refuses `happened`, since
// the work did repeat and a person must see that, with nothing moved.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  appliedDetail,
  asAgent,
  codeOf,
  openSchedules,
  pickup,
  racer,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import type { Work } from './t2d-harness.ts';
import { openBilling, t3d1Harness } from './t3d1-harness.ts';

const url = databaseUrlFromEnvironment();

describe.skipIf(url === undefined)(
  'T3d1: happened stops the replacement',
  { timeout: 60_000 },
  () => {
    let s: Schedules;
    const h = t3d1Harness(() => s);

    beforeAll(async () => {
      s = await openSchedules('t3d1stop', 1_000_000);
      await openBilling(s);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    /** An unknown step proved absent, and its replacement picked up by a fresh worker. */
    const replaced = async (): Promise<{ readonly original: Work; readonly next: Work }> => {
      const original = await h.unknownStep({ applied: false, room: true });
      await h.reconcile();
      const picked = await pickup(s, await h.replacement(original));
      const next = {
        ...original,
        picked,
        credential: String(picked['credential']),
        attemptId: String(picked['attemptId']),
      };
      return { original, next };
    };

    const stateOf = async (next: Work) =>
      (
        await rows<Record<string, unknown>>(
          s,
          `select res.state, res.classified_cause, att.state as attempt_state, att.dispatch_marker,
                l.state as lease_state, (d.revoked_at is not null) as delegation_revoked
           from public.reservations res
           join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
           join public.leases l on l.business_id = res.business_id and l.id = res.lease_id
           left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
          where res.business_id = $1 and att.id = $2`,
          [s.business, next.attemptId],
        )
      )[0];

    it('happened releases the replacement, ends its lease, revokes its delegation; a lost response replays', async () => {
      const { original, next } = await replaced();
      const operationId = randomUUID();
      const recorded = appliedDetail(
        await h.outcome(original, 'happened', operationId),
        'budget.record_outcome',
      );
      expect(await stateOf(next)).toMatchObject({
        state: 'abandoned',
        classified_cause: 'outcome_recorded',
        attempt_state: 'abandoned',
        dispatch_marker: false,
        lease_state: 'released',
        delegation_revoked: true,
      });
      // The old hold spent whole; the replacement's hold back; nothing else held.
      expect(await h.envelope(original)).toMatchObject({ held: '0', actual: '2500' });
      const once = await h.t3b.snapshot();
      expect(
        appliedDetail(await h.outcome(original, 'happened', operationId), 'replay'),
      ).toStrictEqual(recorded);
      expect(await h.t3b.snapshot()).toStrictEqual(once);
      expect(await h.effects(original)).toBe(0);
    });

    it('happened racing the replacement dispatch: exactly one wins, and the loser moves nothing', async () => {
      const { original, next } = await replaced();
      // The dispatch on a connection of its own: two backends, two transactions.
      const other = racer(s);
      const [outcome, dispatched] = await Promise.all([
        h.outcome(original, 'happened'),
        asAgent(
          s,
          {
            command: 'task.dispatch',
            operationId: randomUUID(),
            leaseId: next.picked['leaseId'],
            fence: next.picked['fence'],
          },
          next.credential,
          other,
        ),
      ]);
      await other.close();
      const codes = [codeOf(outcome), codeOf(dispatched)];
      expect(codes.filter((code) => code === 'applied')).toHaveLength(1);
      if (codeOf(outcome) === 'applied') {
        expect(await stateOf(next)).toMatchObject({ dispatch_marker: false, state: 'abandoned' });
      } else {
        expect(codeOf(outcome)).toBe('TRANSITION_NOT_PERMITTED');
        expect(await h.t3b.money(original)).toMatchObject({
          state: 'held',
          attempt_state: 'liability_unknown',
        });
        expect(await stateOf(next)).toMatchObject({ dispatch_marker: true, state: 'held' });
      }
    });

    it('a replacement that already dispatched refuses happened, and nothing moves', async () => {
      const { original, next } = await replaced();
      appliedDetail(await h.t2d.held(next, { command: 'task.dispatch' }), 'task.dispatch');
      const before = await h.t3b.snapshot();
      expect(codeOf(await h.outcome(original, 'happened'))).toBe('TRANSITION_NOT_PERMITTED');
      expect(await h.t3b.snapshot()).toStrictEqual(before);
    });
  },
);
