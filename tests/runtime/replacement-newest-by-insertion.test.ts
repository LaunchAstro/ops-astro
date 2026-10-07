// SPDX-License-Identifier: AGPL-3.0-only
//
// Only the newest hold of a version and run is replaced (pickup's `replaced`).
// "Newest" has to mean the hold inserted last, under the run lock that orders
// inserts on a run, and not the one whose transaction began last: a hold
// written by a transaction that started before its predecessor was created
// is still the newer hold. Driven on two backends: transaction P begins and
// reads its clock, R1 is created by a pickup on another backend and commits,
// and only then does P reserve R2 on the same version and run.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import { acquire } from '../../packages/core-runtime/src/locks.ts';
import { reserve } from '../../packages/core-runtime/src/decide.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  barrier,
  codeOf,
  liveWork,
  openSchedules,
  pickup,
  racer,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/replacement-newest-by-insertion: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('replacement_insertion', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** A model call on the hold, settled at `minor`, as the broker records one. */
async function spend(reservationId: unknown, minor: number): Promise<void> {
  await s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        route_key, route_reach, credential_kind, state, reserved_minor, observed_minor,
        actual_minor, ended_at)
     select r.business_id, $2, r.run_id, a.step_id, r.lease_id, r.version_id, r.id,
            'insertion_spend', 'replay', 'local', 'replay', 'settled', $3, $3, $3,
            clock_timestamp()
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.id = $1`,
    [reservationId, randomUUID(), minor],
  );
}

/** A manager revokes the worker's delegation: the hold is classified at its calls' spend. */
async function stopWorker(picked: Detail): Promise<void> {
  const revoked = await asPerson(s, {
    command: 'delegation.revoke',
    operationId: randomUUID(),
    delegationId: picked['delegationId'],
  });
  appliedDetail(revoked, 'delegation.revoke');
}

const claim = async (reservationId: unknown) =>
  await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId,
    leaseSeconds: 600,
  });

interface Parent {
  readonly envelope_id: string;
  readonly version_id: string;
  readonly run_id: string;
  readonly step_id: string;
}

async function parentOf(reservationId: unknown): Promise<Parent> {
  const [found] = await rows<Parent>(
    s,
    `select r.envelope_id, r.version_id, r.run_id, a.step_id
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.business_id = $1 and r.id = $2`,
    [s.business, reservationId],
  );
  if (found === undefined) throw new Error('no reservation to hold beside');
  return found;
}

/**
 * Transaction P on its own backend: it begins and reads its clock, waits for
 * `go`, then reserves `heldMinor` on the parent's version and run under the
 * envelope and run locks, as every reservation insert is made.
 */
function olderTransaction(parent: Parent, heldMinor: number) {
  const began = barrier();
  const go = barrier();
  const other = racer(s);
  const done = other
    .withBusiness(s.business, async (tx) => {
      await tx.query('select now()');
      began.release();
      await go.held;
      await acquire(tx, [
        { lockClass: 'envelope', id: parent.envelope_id },
        { lockClass: 'run', id: parent.run_id },
      ]);
      const reserved = await reserve(tx, {
        envelopeId: parent.envelope_id,
        versionId: parent.version_id,
        runId: parent.run_id,
        stepId: parent.step_id,
        heldMinor,
      });
      if (!reserved.ok) throw new Error(`reserve refused ${reserved.refusal.code}`);
      return reserved.value.reservationId;
    })
    .finally(async () => await other.close());
  return { began: began.held, go: go.release, done };
}

describe.skipIf(serverUrl === undefined)('the newest hold is the one inserted last', () => {
  it('replaces a hold reserved by a transaction older than its predecessor, and refuses the predecessor', async () => {
    const work = await liveWork(s, `replacement insertion ${randomUUID()}`, 500);
    const r0 = work.decision['reservationId'];
    const parent = await parentOf(r0);
    await spend(r0, 100);
    await stopWorker(work.picked);

    const p = olderTransaction(parent, 300);
    await p.began;
    const r1Picked = await pickup(s, r0);
    const r1 = r1Picked['reservationId'];
    await spend(r1, 100);
    await stopWorker(r1Picked);
    p.go();
    const r2 = await p.done;

    // R2 ends abandoned: picked up, then stopped with nothing spent.
    await stopWorker(await pickup(s, r2));
    const states = await rows<{ readonly id: string; readonly state: string }>(
      s,
      `select id, state from public.reservations where business_id = $1 and version_id = $2`,
      [s.business, parent.version_id],
    );
    expect(Object.fromEntries(states.map((hold) => [hold.id, hold.state]))).toEqual({
      [String(r0)]: 'actual',
      [String(r1)]: 'actual',
      [r2]: 'abandoned',
    });

    const onR2 = await claim(r2);
    // Its replacement is stopped too, so R1 is refused for being older and
    // not because another hold of the version is active.
    if (codeOf(onR2) === 'applied') await stopWorker(appliedDetail(onR2, 'pickup R2'));
    const onR1 = await claim(r1);
    expect({ r2: codeOf(onR2), r1: codeOf(onR1) }).toEqual({
      r2: 'applied',
      r1: 'RESERVATION_NOT_CLAIMABLE',
    });
  });
});
