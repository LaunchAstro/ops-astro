// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's design-check probes for S2243-2 (#2240). One statement can wait on
// several locks in turn: an UPDATE on each row it changes, a read on each
// relation it plans over. A limit per lock wait, or one set before each
// statement, lets that one statement run past the pass deadline. Each case
// holds two locks the statement needs in separate sessions, lets the first go
// late, and checks the same statement then waits on the second.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  boundWorld,
  request,
  sleep,
  withinBound,
  type BoundWorld,
} from './recovery-pass-bound-world.ts';

/**
 * When the first lock goes, from the request: past half the deadline, so a
 * fresh wait for the second ends past the bound, and early enough that the
 * second wait is seen before the deadline ends it.
 */
const FIRST_HELD_MS = 1_500;

/** Two sent model calls on the expired lease, which the sweep holds in one UPDATE. */
async function twoSentCalls(world: BoundWorld): Promise<readonly string[]> {
  const ids = [randomUUID(), randomUUID()];
  await world.s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        state, reserved_minor, route_key, route_reach, credential_kind, started_at)
     select l.business_id, call.id, l.run_id, st.id, l.id, r.version_id, r.id, 'model.replay_compose',
            'dispatched', 100, 'replay', 'cloud', 'api_key', clock_timestamp()
       from public.leases l join public.reservations r on r.id = l.reservation_id
       join lateral (select id from public.planned_steps where run_id = l.run_id
                      order by ordinal limit 1) st on true
       cross join unnest($2::uuid[]) as call(id)
      where l.id = $1`,
    [world.leaseId, ids],
  );
  return ids;
}

/**
 * Hold `first` and `second` in two sessions, let `first` go `FIRST_HELD_MS`
 * after the request, and answer whether the request came back within the bound
 * with the statement matching `pattern` still the one waiting.
 */
async function heldInTurn(
  world: BoundWorld,
  pattern: string,
  first: readonly [string, readonly unknown[]],
  second: readonly [string, readonly unknown[]],
): Promise<number | 'held'> {
  const [one, other] = [world.holder(), world.holder()];
  await one.query('begin');
  await one.query(first[0], [...first[1]]);
  await other.query('begin');
  await other.query(second[0], [...second[1]]);
  const started = performance.now();
  const answer = withinBound(world.handle(request('/api/health')), started);
  await expect.poll(async () => await world.waiting(pattern)).toBeDefined();
  const before = await world.waiting(pattern);
  await sleep(started + FIRST_HELD_MS - performance.now());
  await one.query('rollback');
  await expect
    .poll(async () => await world.waiting(pattern), {
      message: 'the same statement waits on the second lock',
    })
    .toEqual(before);
  const result = await answer;
  console.log(pattern, result, Math.round(performance.now() - started), 'ms');
  return result;
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'Sol proof, criterion 2: a multi-row statement and a discovery read share the request deadline',
  () => {
    it('a multi-row UPDATE waiting on two held rows', async () => {
      const world = await boundWorld('sol2243multirow');
      try {
        const [first, second] = await twoSentCalls(world);
        const lock = 'select 1 from public.model_calls where id = $1 for update';
        const result = await heldInTurn(
          world,
          '%update public.model_calls%',
          [lock, [first]],
          [lock, [second]],
        );
        expect(result, 'one UPDATE over two held rows shares the pass deadline').not.toBe('held');
      } finally {
        await world.end();
      }
    }, 30_000);

    it('a discovery JOIN behind two relation locks', async () => {
      const world = await boundWorld('sol2243discovery');
      try {
        const result = await heldInTurn(
          world,
          '%held_lease%',
          ['lock table public.planned_runs in access exclusive mode', []],
          ['lock table public.proposal_versions in access exclusive mode', []],
        );
        expect(result, 'one read behind two relation locks shares the pass deadline').not.toBe(
          'held',
        );
      } finally {
        await world.end();
      }
    }, 30_000);
  },
);
