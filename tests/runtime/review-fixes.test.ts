// SPDX-License-Identifier: AGPL-3.0-only
//
// The runtime source review's findings, as regressions.
//
// One case per finding in `REVIEW-RUNTIME-dcbc8e8.md`, each written to fail on
// `dcbc8e8` and named by its finding number so a red run names what is broken
// rather than which assertion noticed. The existing gate and lease suites keep
// their own subjects; this file holds only the cases those suites were found
// not to cover.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { handback } from '../../packages/core-runtime/src/handback.ts';
import { pickup } from '../../packages/core-runtime/src/pickup.ts';
import { acquire } from '../../packages/core-runtime/src/locks.ts';
import {
  classifyUnderLocks,
  replayRecordedTransitions,
} from '../../packages/core-runtime/src/recovery.ts';
import { verifyChain } from '../../packages/core-runtime/src/signing.ts';
import {
  buildFixture,
  envelopeTotals,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/review-fixes: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const hour = (): Date => new Date(Date.now() + 3_600_000);

interface Proposed {
  readonly lineageId: string;
  readonly versionId: string;
  readonly gateId: string;
  readonly runId: string;
}

async function proposeOn(
  database: FreshDatabase,
  fixture: RuntimeFixture,
  options: {
    readonly taskId?: string;
    readonly lineageId?: string;
    readonly maximumMinor?: number;
  } = {},
): Promise<Proposed> {
  return await database.app.withBusiness(fixture.businessId, async (tx) => {
    const result = await propose(tx, {
      taskId: options.taskId ?? fixture.taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor: options.maximumMinor ?? 5_000,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
      expiresAt: hour(),
      ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
    });
    if (!result.ok)
      throw new Error(`propose refused ${result.refusal.code}: ${result.refusal.reason}`);
    return result.value;
  });
}

async function decideOn(
  database: FreshDatabase,
  fixture: RuntimeFixture,
  of: Proposed,
  options: {
    readonly decision?: 'approve' | 'reject';
    readonly capId?: string;
  } = {},
) {
  return await database.app.withBusiness(fixture.businessId, async (tx) =>
    decide(tx, {
      gateId: of.gateId,
      versionId: of.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: options.decision ?? 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: options.capId ?? fixture.capId,
    }),
  );
}

describe.skipIf(serverUrl === undefined)('the runtime review findings', () => {
  let database: FreshDatabase;
  let fixture: RuntimeFixture;

  beforeAll(async () => {
    database = await createFreshDatabase({
      serverUrl: serverUrl as string,
      part: 'runtime_review_fixes',
    });
    fixture = await buildFixture(database.app, 'review-fixes');
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  // R6. A non-null actual is expenditure this head cannot have observed.
  it('R6: handback refuses any non-null actual expenditure before it writes', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const proposed = await proposeOn(database, fixture, { taskId: task });
    const decided = await decideOn(database, fixture, proposed);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);

    const claimed = await database.app.withBusiness(fixture.businessId, async (tx) =>
      pickup(tx, {
        reservationId: decided.value.reservationId as string,
        agentActorId: fixture.agentActorId,
        authorisedByPersonId: fixture.decider.personId,
        mintedByActorId: fixture.decider.actorId,
        collection: TASK_COLLECTION,
        leaseSeconds: 3_600,
      }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    const settled = await database.app.withBusiness(fixture.businessId, async (tx) =>
      handback(tx, {
        leaseId: claimed.value.leaseId,
        fence: claimed.value.fence,
        outcome: 'completed',
        report: { words: 200 },
        actualMinor: 0,
      }),
    );
    expect(settled.ok).toBe(false);
    if (settled.ok) return;
    expect(settled.refusal.code).toBe('ACTUAL_EXPENDITURE_UNSUPPORTED');

    // And nothing moved: the lease is still live and the hold is still held.
    const after = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly lease_state: string; readonly res_state: string }>(
        `select l.state as lease_state, res.state as res_state
           from public.leases l
           join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
          where l.business_id = $1 and l.id = $2`,
        [fixture.businessId, claimed.value.leaseId],
      );
      return rows[0];
    });
    expect(after).toEqual({ lease_state: 'live', res_state: 'held' });

    // The honest handback still works, and it is the only one that does.
    const honest = await database.app.withBusiness(fixture.businessId, async (tx) =>
      handback(tx, {
        leaseId: claimed.value.leaseId,
        fence: claimed.value.fence,
        outcome: 'completed',
        report: { words: 200 },
        actualMinor: null,
      }),
    );
    expect(honest.ok).toBe(true);
    if (!honest.ok) return;
    expect(honest.value.reservationState).toBe('abandoned');
  });

  // R4. The report is durable, its identity comes back, and a stale holder's
  // report is retained rather than discarded.
  it('R4: handback stores its report durably and returns its identity', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const proposed = await proposeOn(database, fixture, { taskId: task });
    const decided = await decideOn(database, fixture, proposed);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);

    const claimed = await database.app.withBusiness(fixture.businessId, async (tx) =>
      pickup(tx, {
        reservationId: decided.value.reservationId as string,
        agentActorId: fixture.agentActorId,
        authorisedByPersonId: fixture.decider.personId,
        mintedByActorId: fixture.decider.actorId,
        collection: TASK_COLLECTION,
        leaseSeconds: 3_600,
      }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    const settled = await database.app.withBusiness(fixture.businessId, async (tx) =>
      handback(tx, {
        leaseId: claimed.value.leaseId,
        fence: claimed.value.fence,
        outcome: 'completed',
        report: { draft: 'the brief, 200 words', words: 200 },
        actualMinor: null,
      }),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    const stored = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{
        readonly disposition: string;
        readonly report: Record<string, unknown>;
        readonly refusal_code: string | null;
      }>(
        `select disposition, report, refusal_code from public.handback_reports
          where business_id = $1 and id = $2`,
        [fixture.businessId, settled.value.reportId],
      );
      return rows[0];
    });
    expect(stored?.disposition).toBe('settled');
    expect(stored?.refusal_code).toBeNull();
    expect(stored?.report).toEqual({ draft: 'the brief, 200 words', words: 200 });

    // A stale fence cannot settle, and its report is retained anyway.
    const late = await database.app.withBusiness(fixture.businessId, async (tx) =>
      handback(tx, {
        leaseId: claimed.value.leaseId,
        fence: claimed.value.fence,
        outcome: 'failed',
        report: { note: 'the work the replaced holder had done' },
        actualMinor: null,
      }),
    );
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.refusal.code).toBe('LEASE_EXPIRED');

    const retained = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{
        readonly disposition: string;
        readonly refusal_code: string | null;
      }>(
        `select disposition, refusal_code from public.handback_reports
          where business_id = $1 and lease_id = $2 and disposition = 'retained'`,
        [fixture.businessId, claimed.value.leaseId],
      );
      return rows;
    });
    expect(retained).toHaveLength(1);
    expect(retained[0]?.refusal_code).toBe('LEASE_EXPIRED');
  });

  // R3. A lineage belongs to one task, and the request has to name that task.
  it('R3: propose refuses a lineage whose task is not the requested one', async () => {
    const other = await newTask(database.app, fixture.businessId, fixture.decider);
    const onOther = await proposeOn(database, fixture, { taskId: other });

    const crossed = await database.app.withBusiness(fixture.businessId, async (tx) =>
      propose(tx, {
        taskId: fixture.taskId,
        collection: TASK_COLLECTION,
        proposedByActorId: fixture.decider.actorId,
        subjects: subjectsOf(fixture.decider),
        purpose: 'draft_the_brief',
        maximumMinor: 5_000,
        currency: 'AUD',
        payload: { instruction: 'draft it' },
        step: { kind: 'local.draft', payload: { words: 200 } },
        expiresAt: hour(),
        lineageId: onOther.lineageId,
      }),
    );
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.refusal.code).toBe('LINEAGE_NOT_ON_TASK');

    // The other task's version is untouched: no supersession happened.
    const live = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly superseded_at: Date | null }>(
        `select superseded_at from public.proposal_versions where business_id = $1 and id = $2`,
        [fixture.businessId, onOther.versionId],
      );
      return rows[0]?.superseded_at ?? null;
    });
    expect(live).toBeNull();
  });

  // R3, second barrier: the database refuses the same fact independently.
  it('R3: the schema refuses a run whose lineage belongs to another task', async () => {
    const other = await newTask(database.app, fixture.businessId, fixture.decider);
    const onOther = await proposeOn(database, fixture, { taskId: other });

    await expect(
      database.app.withBusiness(fixture.businessId, async (tx) =>
        tx.query(`update public.planned_runs set task_id = $3 where business_id = $1 and id = $2`, [
          fixture.businessId,
          onOther.runId,
          fixture.taskId,
        ]),
      ),
    ).rejects.toThrow(/planned_runs_lineage_on_same_task/u);
  });

  // R2. The envelope's own cap is the cap, and a request naming another is refused.
  it('R2: decide refuses a request bound to a cap the task envelope does not draw on', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const first = await proposeOn(database, fixture, { taskId: task, maximumMinor: 4_000 });
    const opened = await decideOn(database, fixture, first);
    if (!opened.ok) throw new Error(`decide refused ${opened.refusal.code}`);

    // A second, entirely separate cap with plenty of room.
    const otherCap = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly id: string }>(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, gen_random_uuid(), 'synthetic-other', 1000000, 'AUD') returning id`,
        [fixture.businessId],
      );
      return rows[0]?.id as string;
    });

    const second = await proposeOn(database, fixture, {
      taskId: task,
      lineageId: first.lineageId,
      maximumMinor: 4_000,
    });
    const crossed = await decideOn(database, fixture, second, { capId: otherCap });

    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(crossed.refusal.code).toBe('CAP_BINDING_MISMATCH');

    // The refusal is total: no decision row and no approved gate were written.
    const written = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly decisions: string; readonly gate_state: string }>(
        `select (select count(*)::text from public.gate_decisions
                  where business_id = $1 and gate_id = $2) as decisions,
                (select state from public.gates where business_id = $1 and id = $2) as gate_state`,
        [fixture.businessId, second.gateId],
      );
      return rows[0];
    });
    expect(written).toEqual({ decisions: '0', gate_state: 'pending' });
  });

  // R7. A marked attempt quarantines; it does not fail the constraint first.
  it('R7: handback quarantines a marked claimed attempt and retains the full hold', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const proposed = await proposeOn(database, fixture, { taskId: task });
    const decided = await decideOn(database, fixture, proposed);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
    const envelopeId = decided.value.envelopeId as string;
    const before = await database.app.withBusiness(fixture.businessId, async (tx) =>
      envelopeTotals(tx, envelopeId),
    );

    const claimed = await database.app.withBusiness(fixture.businessId, async (tx) =>
      pickup(tx, {
        reservationId: decided.value.reservationId as string,
        agentActorId: fixture.agentActorId,
        authorisedByPersonId: fixture.decider.personId,
        mintedByActorId: fixture.decider.actorId,
        collection: TASK_COLLECTION,
        leaseSeconds: 3_600,
      }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    // An imported or corrupt observation, applied as the owner would find it.
    await database.admin.execute(
      `update public.attempts set observed = true, state = 'quarantined' where id = $1`,
      [decided.value.attemptId as string],
    );

    const settled = await database.app.withBusiness(fixture.businessId, async (tx) =>
      handback(tx, {
        leaseId: claimed.value.leaseId,
        fence: claimed.value.fence,
        outcome: 'completed',
        report: { words: 200 },
        actualMinor: null,
      }),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.reservationState).toBe('quarantined');

    const after = await database.app.withBusiness(fixture.businessId, async (tx) =>
      envelopeTotals(tx, envelopeId),
    );
    expect(after.held).toBe(before.held);
    expect(after.actual).toBe(before.actual);
  });

  // R9. The verifier reads the payload, not only the digest the row asserts.
  it('R9: verifyChain detects a payload tampered under its stored digest', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const proposed = await proposeOn(database, fixture, { taskId: task });
    const decided = await decideOn(database, fixture, proposed);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);

    // The append-only trigger owns the application role; the tamper is applied
    // as the owner, which is exactly the restored-or-imported evidence case.
    await database.admin.execute(`alter table public.gate_decisions disable trigger all`);
    await database.admin.execute(
      `update public.gate_decisions
          set payload = jsonb_set(payload, '{note}', '"approved for something else"')
        where business_id = $1 and gate_id = $2`,
      [fixture.businessId, proposed.gateId],
    );
    await database.admin.execute(`alter table public.gate_decisions enable trigger all`);

    const rows = await database.admin.execute<{
      readonly seq: number;
      readonly prev_hash: string;
      readonly hash: string;
      readonly payload: Record<string, unknown>;
      readonly payload_digest: string;
      readonly signature: string;
      readonly signing_key_id: string;
      readonly id: string;
      readonly gate_id: string;
      readonly version_id: string;
      readonly decision: string;
      readonly decided_by_person_id: string;
    }>(
      `select id, seq::int as seq, prev_hash, hash, payload, payload_digest, signature,
              signing_key_id, gate_id, version_id, decision, decided_by_person_id
         from public.gate_decisions where business_id = $1 order by seq`,
      [fixture.businessId],
    );

    type Row = (typeof rows)[number];
    const broken = verifyChain(TEST_SIGNING_KEY, rows, (row) => {
      const full = row as Row;
      return {
        id: full.id,
        seq: Number(full.seq),
        gate: full.gate_id,
        version: full.version_id,
        decision: full.decision,
        person: full.decided_by_person_id,
        payloadDigest: full.payload_digest,
        signature: full.signature,
      };
    });
    expect(broken).toMatch(/payload/u);
  });

  // R8. Supersession releases the hold it made nonclaimable, in its own transaction.
  it('R8: superseding a version classifies its unstarted hold in the same transaction', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const first = await proposeOn(database, fixture, { taskId: task, maximumMinor: 5_000 });
    const decided = await decideOn(database, fixture, first);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
    const envelopeId = decided.value.envelopeId as string;

    await proposeOn(database, fixture, {
      taskId: task,
      lineageId: first.lineageId,
      maximumMinor: 5_000,
    });

    const state = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly state: string; readonly cause: string | null }>(
        `select state, classified_cause as cause from public.reservations
          where business_id = $1 and id = $2`,
        [fixture.businessId, decided.value.reservationId as string],
      );
      return rows[0];
    });
    expect(state?.state).toBe('abandoned');
    expect(state?.cause).toBe('version_superseded');

    const totals = await database.app.withBusiness(fixture.businessId, async (tx) =>
      envelopeTotals(tx, envelopeId),
    );
    expect(totals.held).toBe(0);
  });

  // R8, the rejection half.
  it('R8: rejecting a lineage classifies its unstarted hold in the same transaction', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const first = await proposeOn(database, fixture, { taskId: task, maximumMinor: 5_000 });
    const decided = await decideOn(database, fixture, first);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
    const envelopeId = decided.value.envelopeId as string;

    const second = await proposeOn(database, fixture, {
      taskId: task,
      lineageId: first.lineageId,
      maximumMinor: 5_000,
    });
    const rejected = await decideOn(database, fixture, second, { decision: 'reject' });
    expect(rejected.ok).toBe(true);

    const totals = await database.app.withBusiness(fixture.businessId, async (tx) =>
      envelopeTotals(tx, envelopeId),
    );
    expect(totals.held).toBe(0);
  });

  // R5. An expired lease is discovered, fenced and classified by the owning
  // transaction, and the still-approved version takes a fresh hold.
  it('R5: an expired lease is classified and the approved version is picked up again', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const proposed = await proposeOn(database, fixture, { taskId: task });
    const decided = await decideOn(database, fixture, proposed);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
    const envelopeId = decided.value.envelopeId as string;
    const first = decided.value.reservationId as string;

    const claimed = await database.app.withBusiness(fixture.businessId, async (tx) =>
      pickup(tx, {
        reservationId: first,
        agentActorId: fixture.agentActorId,
        authorisedByPersonId: fixture.decider.personId,
        mintedByActorId: fixture.decider.actorId,
        collection: TASK_COLLECTION,
        leaseSeconds: 3_600,
      }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    // The server's clock, moved by the server. Nothing here sleeps.
    await database.admin.execute(
      `update public.leases set expires_at = now() - interval '1 minute' where id = $1`,
      [claimed.value.leaseId],
    );
    await database.admin.execute(`update public.delegations set settled_at = now() where id = $1`, [
      claimed.value.delegation.delegation.id,
    ]);

    const again = await database.app.withBusiness(fixture.businessId, async (tx) =>
      pickup(tx, {
        reservationId: first,
        agentActorId: fixture.agentActorId,
        authorisedByPersonId: fixture.decider.personId,
        mintedByActorId: fixture.decider.actorId,
        collection: TASK_COLLECTION,
        leaseSeconds: 3_600,
      }),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    // A fresh attempt and a fresh hold, never the abandoned one revived.
    expect(again.value.reservationId).not.toBe(first);
    expect(again.value.fence).toBeGreaterThan(claimed.value.fence);

    const state = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{
        readonly id: string;
        readonly state: string;
        readonly cause: string | null;
      }>(
        `select id, state, classified_cause as cause from public.reservations
          where business_id = $1 and version_id = $2 order by created_at`,
        [fixture.businessId, proposed.versionId],
      );
      return rows;
    });
    expect(state).toHaveLength(2);
    expect(state[0]).toMatchObject({
      id: first,
      state: 'abandoned',
      cause: 'lease_expired_and_fenced',
    });
    expect(state[1]?.state).toBe('held');

    // One hold's worth of the envelope, not two.
    const totals = await database.app.withBusiness(fixture.businessId, async (tx) =>
      envelopeTotals(tx, envelopeId),
    );
    expect(totals.held).toBe(5_000);

    // The fixture's agent holds one live delegation per purpose, so this case
    // settles the one it minted rather than leaving it for the next case.
    await database.admin.execute(`update public.delegations set settled_at = now() where id = $1`, [
      again.value.delegation.delegation.id,
    ]);
  });

  // R5, the replay half: a fenced lease's hold is discoverable by recovery.
  it('R5: bounded replay discovers a hold left behind a fenced lease', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const proposed = await proposeOn(database, fixture, { taskId: task });
    const decided = await decideOn(database, fixture, proposed);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
    const reservationId = decided.value.reservationId as string;

    const claimed = await database.app.withBusiness(fixture.businessId, async (tx) =>
      pickup(tx, {
        reservationId,
        agentActorId: fixture.agentActorId,
        authorisedByPersonId: fixture.decider.personId,
        mintedByActorId: fixture.decider.actorId,
        collection: TASK_COLLECTION,
        leaseSeconds: 3_600,
      }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    // The fence committed; the classification did not. That is the crash the
    // replay exists for, and age is not what makes it discoverable.
    await database.admin.execute(
      `update public.leases set state = 'expired', released_at = now() where id = $1`,
      [claimed.value.leaseId],
    );

    const replayed = await database.app.withBusiness(fixture.businessId, async (tx) =>
      replayRecordedTransitions(tx),
    );
    const mine = replayed.find((one) => one.reservationId === reservationId);
    expect(mine?.released).toBe(true);
    expect(mine?.reason).toContain('lease_expired_and_fenced');
  });

  // R1. The classifier will not run outside the locks its caller must hold.
  it('R1: the classifier refuses to run without the reservation and envelope locks', async () => {
    const task = await newTask(database.app, fixture.businessId, fixture.decider);
    const proposed = await proposeOn(database, fixture, { taskId: task });
    const decided = await decideOn(database, fixture, proposed);
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);

    await expect(
      database.app.withBusiness(fixture.businessId, async (tx) => {
        const locks = await acquire(tx, [{ lockClass: 'task', id: task }]);
        await classifyUnderLocks(
          tx,
          {
            reservationId: decided.value.reservationId as string,
            cause: 'lineage_cancelled',
            causeId: proposed.lineageId,
          },
          locks,
        );
      }),
    ).rejects.toThrow(/lock order/u);
  });

  // R10. Two decisions on different tasks and caps of one business.
  it('R10: concurrent decisions in one business take distinct consecutive sequences', async () => {
    const taskA = await newTask(database.app, fixture.businessId, fixture.decider);
    const taskB = await newTask(database.app, fixture.businessId, fixture.decider);
    const capB = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly id: string }>(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, gen_random_uuid(), 'synthetic-r10', 1000000, 'AUD') returning id`,
        [fixture.businessId],
      );
      return rows[0]?.id as string;
    });
    const a = await proposeOn(database, fixture, { taskId: taskA });
    const b = await proposeOn(database, fixture, { taskId: taskB });

    const [left, right] = await Promise.all([
      decideOn(database, fixture, a),
      decideOn(database, fixture, b, { capId: capB }),
    ]);

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;

    const seqs = await database.app.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly at: string }>(
        `select seq::text as at from public.gate_decisions
          where business_id = $1 and id = any($2::uuid[]) order by seq`,
        [fixture.businessId, [left.value.decisionId, right.value.decisionId]],
      );
      return rows.map((row) => Number(row.at));
    });
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBe((seqs[0] as number) + 1);
  });
});
