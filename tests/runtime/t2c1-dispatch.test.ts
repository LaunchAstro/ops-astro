// SPDX-License-Identifier: AGPL-3.0-only
//
// T2c1, the dispatch transaction, over a real database.
//
// `recheck_inside_dispatch` (split 1.2, case D3): a revocation in flight when
// the dispatch starts holds the grant row; the dispatch waits on it under its
// locks, and once the revocation commits the recheck sees it and refuses
// `AUTHORITY_LOST` with nothing marked. Move the recheck outside the dispatch
// transaction, or before its grant lock, and the dispatch reads the grant as
// it was before the revocation committed and marks the step: red.
//
// The four effect-time facts, each moved in turn, refuse with their own code
// and leave the attempt and the step exactly as they were. An effect that can
// be neither replayed nor reconciled is refused `EFFECT_NOT_RECONCILABLE`.
// Data separation: a lease from another business is answered as one the
// caller does not own and changes nothing there, directly and through the
// `task.dispatch` command beside that business's own dispatch of it; a
// dispatch never waits on another business's step.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { pickup } from '../../packages/core-runtime/src/pickup.ts';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import {
  dispatch,
  EFFECT_OPERATIONS,
  EFFECT_TIME_FACTS,
  type DispatchRequest,
} from '../../packages/core-runtime/src/dispatch.ts';
import {
  buildFixture,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2c1-dispatch: DATABASE_URL is unset, so nothing below ran.');
}

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise a test holds a transaction open on, and the call that lets it go. */
function gate(): { readonly held: Promise<void>; readonly release: () => void } {
  const opened: { release?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    opened.release = resolve;
  });
  return { held, release: () => opened.release?.() };
}

interface Leased {
  readonly taskId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly attemptId: string;
  readonly reservationId: string;
  readonly versionId: string;
  readonly delegationId: string;
  readonly request: DispatchRequest;
}

/** Propose a step on the task and approve it, through the runtime. */
async function approved(
  tx: TenantQuery,
  fixture: RuntimeFixture,
  taskId: string,
  kind: string,
): Promise<{ readonly versionId: string; readonly reservationId: string }> {
  const proposed = await propose(tx, {
    taskId,
    collection: TASK_COLLECTION,
    proposedByActorId: fixture.decider.actorId,
    subjects: subjectsOf(fixture.decider),
    purpose: `t2c1_${randomUUID().slice(0, 8)}`,
    maximumMinor: 2_500,
    currency: 'AUD',
    payload: { change: 'a team-only comment' },
    step: { kind, payload: {} },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  if (!proposed.ok) throw new Error(`propose refused ${proposed.refusal.code}`);
  const decided = await decide(tx, {
    gateId: proposed.value.gateId,
    versionId: proposed.value.versionId,
    decidedByPersonId: fixture.decider.personId,
    decidedByActorId: fixture.decider.actorId,
    subjects: subjectsOf(fixture.decider),
    collection: TASK_COLLECTION,
    decision: 'approve',
    note: 'go',
    signingKey: TEST_SIGNING_KEY,
    capId: fixture.capId,
  });
  if (!decided.ok || decided.value.decision !== 'approve') throw new Error('decide refused');
  return { versionId: proposed.value.versionId, reservationId: decided.value.reservationId };
}

/** Propose, approve and pick up as the agent, on a new task, through the runtime. */
async function leased(
  database: Database,
  fixture: RuntimeFixture,
  kind = 'synthetic_comment',
): Promise<Leased> {
  const taskId = await newTask(database, fixture.businessId, fixture.decider);
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const { versionId, reservationId } = await approved(tx, fixture, taskId, kind);
    const picked = await pickup(tx, {
      claimant: 'agent',
      reservationId,
      agentActorId: fixture.agentActorId,
      authorisedByPersonId: fixture.decider.personId,
      mintedByActorId: fixture.decider.actorId,
      collection: TASK_COLLECTION,
      leaseSeconds: 600,
    });
    if (!picked.ok) throw new Error(`pickup refused ${picked.refusal.code}`);
    const delegationId = picked.value.delegation.delegation.id;
    return {
      taskId,
      leaseId: picked.value.leaseId,
      fence: picked.value.fence,
      attemptId: picked.value.attemptId,
      reservationId: picked.value.reservationId,
      versionId,
      delegationId,
      request: {
        claimant: 'agent',
        leaseId: picked.value.leaseId,
        fence: picked.value.fence,
        holderActorId: fixture.agentActorId,
        delegationId,
        collection: TASK_COLLECTION,
      },
    };
  });
}

/** A step approved and picked up by the business's own person, as `leased` does for its agent. */
async function personLeased(database: Database, fixture: RuntimeFixture) {
  const taskId = await newTask(database, fixture.businessId, fixture.decider);
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const proposed = await propose(tx, {
      taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: `t2c1_${randomUUID().slice(0, 8)}`,
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { change: 'a team-only comment' },
      step: { kind: 'synthetic_comment', payload: {} },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!proposed.ok) throw new Error('propose refused');
    const decided = await decide(tx, {
      gateId: proposed.value.gateId,
      versionId: proposed.value.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    });
    if (!decided.ok || decided.value.decision !== 'approve') throw new Error('decide refused');
    const picked = await pickup(tx, {
      claimant: 'person',
      reservationId: decided.value.reservationId,
      personId: fixture.decider.personId,
      actorId: fixture.decider.actorId,
      authorisedByPersonId: fixture.decider.personId,
      collection: TASK_COLLECTION,
      leaseSeconds: 600,
    });
    if (!picked.ok) throw new Error(`pickup refused ${picked.refusal.code}`);
    return picked.value;
  });
}

/** The attempt and the step a dispatch could mark, as the owner reads them. */
async function marks(db: FreshDatabase, attemptId: string): Promise<Record<string, unknown>> {
  const rows = await db.admin.execute<Record<string, unknown>>(
    `select a.state, a.dispatch_marker, a.observed, s.dispatched_at, s.dispatch_attempt_id,
            s.dispatch_marked
       from public.attempts a join public.planned_steps s
         on s.business_id = a.business_id and s.id = a.step_id
      where a.id = $1`,
    [attemptId],
  );
  return rows[0] ?? {};
}

const UNMARKED = {
  state: 'dispatched',
  dispatch_marker: false,
  observed: false,
  dispatched_at: null,
  dispatch_attempt_id: null,
  dispatch_marked: null,
};

describe.skipIf(serverUrl === undefined)('T2c1 the dispatch transaction', () => {
  let db: FreshDatabase;
  let fixture: RuntimeFixture;
  let other: RuntimeFixture;
  // A second connection: the first is `max: 1`, and the races hold one transaction open.
  let rival: Database;

  const run = async (on: RuntimeFixture, request: DispatchRequest) =>
    await db.app.withBusiness(on.businessId, async (tx) => await dispatch(tx, request));

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 't2c1dispatch' });
    fixture = await buildFixture(db.app, 't2c1-alpha');
    other = await buildFixture(db.app, 't2c1-beta');
    rival = connect(db.appUrl, { max: 1, source: 't2c1-rival' });
  }, 120_000);

  afterAll(async () => {
    await rival?.close();
    await db?.drop();
  });

  it('enumerates the effect-time facts in code, and declares the synthetic effect replayable', () => {
    expect([...EFFECT_TIME_FACTS].toSorted()).toStrictEqual(
      [
        'approvedVersion',
        'authority',
        'budget',
        'lease',
        'superseded',
        'lineage',
        'launch',
        'signOff',
      ].toSorted(),
    );
    expect(EFFECT_OPERATIONS['synthetic_comment']).toBe('replay');
  });

  it('marks the attempt, then names it on its step, once; a second dispatch writes nothing new', async () => {
    const work = await leased(db.app, fixture);
    const first = await run(fixture, work.request);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.value).toMatchObject({
      leaseId: work.leaseId,
      taskId: work.taskId,
      attemptId: work.attemptId,
      stepKind: 'synthetic_comment',
      reconcileMode: 'replay',
    });
    const marked = await marks(db, work.attemptId);
    expect(marked).toMatchObject({
      state: 'dispatched',
      dispatch_marker: true,
      observed: false,
      dispatch_attempt_id: work.attemptId,
      dispatch_marked: true,
    });
    expect(marked['dispatched_at']).not.toBeNull();

    const again = await run(fixture, work.request);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.dispatchedAt).toStrictEqual(first.value.dispatchedAt);
    expect(await marks(db, work.attemptId)).toStrictEqual(marked);
  });

  it('recheck_inside_dispatch: a revocation in flight is seen, and the dispatch is refused AUTHORITY_LOST', async () => {
    const work = await leased(db.app, fixture);
    const { held, release } = gate();
    const revoking = rival.withBusiness(fixture.businessId, async (tx) => {
      await tx.query(
        `update public.grants set revoked_at = now()
          where business_id = $1 and subject_id = $2 and action = 'write'`,
        [fixture.businessId, fixture.decider.personId],
      );
      await held;
    });
    // The revocation holds the grant row before the dispatch starts.
    await delay(100);
    const dispatching = run(fixture, work.request);
    // Bounded, so a dispatch that never waits on the grant is answered by the assertions below.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await db.admin.execute<{ readonly waiting: string }>(
        `select count(*)::text as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (Number(rows[0]?.waiting ?? 0) > 0) break;
      // eslint-disable-next-line no-await-in-loop
      await delay(25);
    }
    release();
    await revoking;
    const answer = await dispatching;
    try {
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.refusal.code).toBe('AUTHORITY_LOST');
      expect(await marks(db, work.attemptId)).toMatchObject(UNMARKED);
    } finally {
      await db.admin.execute(
        `update public.grants set revoked_at = null
          where business_id = $1 and subject_id = $2 and action = 'write'`,
        [fixture.businessId, fixture.decider.personId],
      );
    }
  }, 20_000);

  it('a settled delegation cannot dispatch while its lease is live', async () => {
    const work = await leased(db.app, fixture);
    await db.admin.execute(
      `update public.delegations set settled_at = now()
        where business_id = $1 and id = $2`,
      [fixture.businessId, work.delegationId],
    );
    const answer = await run(fixture, work.request);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.refusal.code).toBe('AUTHORITY_LOST');
    expect(await marks(db, work.attemptId)).toMatchObject(UNMARKED);
  });

  it.each([
    [
      'authority',
      'AUTHORITY_LOST',
      `update public.delegations set revoked_at = now(), revocation_cause = 'delegation_revoked'
        where id = $1`,
      'delegationId',
    ],
    [
      'superseded',
      'PROPOSAL_SUPERSEDED',
      'update public.proposal_versions set superseded_at = now() where id = $1',
      'versionId',
    ],
    [
      'lease',
      'LEASE_EXPIRED',
      `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
      'leaseId',
    ],
    [
      'budget',
      'BUDGET_UNAVAILABLE',
      `update public.reservations set state = 'abandoned', classified_cause = 'lease_expired_and_fenced',
              terminal_at = now() where id = $1`,
      'reservationId',
    ],
  ] as const)('the %s fact moved refuses %s, and marks nothing', async (_fact, code, move, key) => {
    const work = await leased(db.app, fixture);
    await db.admin.execute(move, [work[key]]);
    const answer = await run(fixture, work.request);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.refusal.code).toBe(code);
    expect(await marks(db, work.attemptId)).toMatchObject(UNMARKED);
  });

  it('refuses EFFECT_NOT_RECONCILABLE for an effect declaring neither replay nor reconciliation', async () => {
    const work = await leased(db.app, fixture, 'local.draft');
    const answer = await run(fixture, work.request);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.refusal.code).toBe('EFFECT_NOT_RECONCILABLE');
    expect(await marks(db, work.attemptId)).toMatchObject(UNMARKED);
  });

  it('answers a stale fence and another holder as LEASE_NOT_OWNED', async () => {
    const work = await leased(db.app, fixture);
    const stale = await run(fixture, { ...work.request, fence: work.fence + 1 });
    const stranger = await run(fixture, {
      ...work.request,
      holderActorId: fixture.decider.actorId,
    });
    for (const answer of [stale, stranger]) {
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.refusal.code).toBe('LEASE_NOT_OWNED');
    }
    expect(await marks(db, work.attemptId)).toMatchObject(UNMARKED);
  });

  it('answers an agent naming a person’s own lease as LEASE_NOT_OWNED, not a fault', async () => {
    const personLease = await personLeased(db.app, fixture);
    const mine = await leased(db.app, fixture);
    const answer = await run(fixture, {
      ...mine.request,
      leaseId: personLease.leaseId,
      fence: personLease.fence,
    });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.refusal.code).toBe('LEASE_NOT_OWNED');
    expect(await marks(db, personLease.attemptId)).toMatchObject(UNMARKED);
  });

  it('T2 isolation: another business’s lease is not owned and nothing there moves', async () => {
    const theirs = await leased(db.app, other);
    const before = await marks(db, theirs.attemptId);
    const answer = await run(fixture, theirs.request);
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.refusal.code).toBe('LEASE_NOT_OWNED');
    expect(await marks(db, theirs.attemptId)).toStrictEqual(before);

    // Through the command T2c1 serves, `task.dispatch`, as each business's own person calls it.
    const person = await personLeased(db.app, other);
    const untouched = await marks(db, person.attemptId);
    const dispatchAs = async (on: RuntimeFixture) =>
      await executeCommand(db.app, on.businessId, on.decider.presented, 'api', {
        command: 'task.dispatch',
        operationId: randomUUID(),
        leaseId: person.leaseId,
        fence: person.fence,
      } as never);
    const crossed = await dispatchAs(fixture);
    expect(isCommandRefusal(crossed) ? crossed.code : 'dispatched').toBe('LEASE_NOT_OWNED');
    expect(JSON.stringify(crossed)).not.toContain(person.attemptId);
    expect(await marks(db, person.attemptId)).toStrictEqual(untouched);
    // Its positive control: the same command in the lease's own business
    // marks that step, so the refusals are the ownership check on a working
    // dispatch, not a dispatch that marks nothing anywhere.
    const home = await dispatchAs(other);
    expect(isCommandRefusal(home), JSON.stringify(home)).toBe(false);
    expect(await marks(db, person.attemptId)).toMatchObject({
      dispatch_marker: true,
      dispatch_attempt_id: person.attemptId,
      dispatch_marked: true,
    });
  });

  it('T2 isolation: a dispatch never waits on another business’s step', async () => {
    const theirs = await leased(db.app, other);
    const mine = await leased(db.app, fixture);
    const { held, release } = gate();
    const locking = rival.withBusiness(other.businessId, async (tx) => {
      await tx.query(
        `select 1 from public.planned_steps s join public.attempts a
            on a.business_id = s.business_id and a.step_id = s.id
          where a.id = $1 for update of s`,
        [theirs.attemptId],
      );
      await held;
    });
    try {
      await delay(100);
      const answer = await Promise.race([
        run(fixture, mine.request),
        delay(5_000).then(() => 'waited' as const),
      ]);
      expect(answer).not.toBe('waited');
      if (answer !== 'waited') expect(answer.ok).toBe(true);
    } finally {
      release();
      await locking;
    }
  });
});
