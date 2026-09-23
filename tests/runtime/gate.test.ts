// SPDX-License-Identifier: AGPL-3.0-only
//
// The gate proof (G01, G03, G04, G06, G07) and the decision chain (G02).
//
// Two cases carry the weight. **A decision on a stale version is refused**,
// which is G04: proposing again supersedes version 1, and the approval that
// names version 1 has to stop being able to authorise anything the moment
// version 2 exists. **Two concurrent approves on one version yield one
// decision and one reservation**, which is G03 — and the interleaving is
// forced rather than hoped for, the way `tests/commands/lost-update.test.ts`
// forces its own: the first transaction is held open on a barrier while the
// second blocks on the gate row lock, and the block is *observed* in
// `pg_stat_activity` rather than slept through. A run that could not establish
// the interleaving throws instead of passing quietly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { verifyChain } from '../../packages/core-runtime/src/signing.ts';
import {
  buildFixture,
  envelopeTotals,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/gate: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Ask the server whether a backend is parked on a lock, rather than sleeping and hoping. */
async function awaitBlockedOnLock(database: FreshDatabase): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // Polling is sequential by definition: each question is about the state
    // the previous answer did not find.
    // eslint-disable-next-line no-await-in-loop
    const rows = await database.admin.execute<{ readonly waiting: string }>(
      `select count(*)::text as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error('no backend ever blocked on a lock: the interleaving was not established');
}

const hour = (): Date => new Date(Date.now() + 3_600_000);

async function proposeOn(
  database: FreshDatabase,
  fixture: RuntimeFixture,
  options: {
    readonly lineageId?: string;
    readonly expiresAt?: Date;
    readonly maximumMinor?: number;
  } = {},
) {
  return await database.app.withBusiness(fixture.businessId, async (tx) => {
    const result = await propose(tx, {
      taskId: fixture.taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor: options.maximumMinor ?? 5_000,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
      expiresAt: options.expiresAt ?? hour(),
      ...(options.lineageId === undefined ? {} : { lineageId: options.lineageId }),
    });
    if (!result.ok)
      throw new Error(`propose refused ${result.refusal.code}: ${result.refusal.reason}`);
    return result.value;
  });
}

describe.skipIf(serverUrl === undefined)('the gate', () => {
  let database: FreshDatabase;
  let fixture: RuntimeFixture;

  beforeAll(async () => {
    database = await createFreshDatabase({ part: 'l4gate' });
    fixture = await buildFixture(database.app, 'gatebiz');
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('plans a real run and step and renders the evidence pack before the gate exists', async () => {
    const proposal = await proposeOn(database, fixture);

    await database.app.withBusiness(fixture.businessId, async (tx) => {
      // G01: the gate references a run and a step that exist, non-null.
      const gates = await tx.query<{
        readonly run_id: string;
        readonly step_id: string;
        readonly evidence_pack_id: string;
      }>(
        `select run_id, step_id, evidence_pack_id from public.gates where business_id = $1 and id = $2`,
        [fixture.businessId, proposal.gateId],
      );
      expect(gates[0]?.run_id).toBe(proposal.runId);
      expect(gates[0]?.step_id).toBe(proposal.stepId);

      // G07: the pack is rendered, non-empty, and bound to this version's digest.
      const packs = await tx.query<{
        readonly rendered: Record<string, unknown>;
        readonly version_digest: string;
      }>(
        `select rendered, version_digest from public.evidence_packs where business_id = $1 and id = $2`,
        [fixture.businessId, gates[0]?.evidence_pack_id],
      );
      expect(packs[0]?.version_digest).toBe(proposal.payloadDigest);
      expect(packs[0]?.rendered).toMatchObject({ externalEffect: false, providerRequested: false });
      const rendered = packs[0]?.rendered as { readonly steps: unknown } | undefined;
      expect(Array.isArray(rendered?.steps)).toBe(true);

      // Nothing is dispatched, and the step says so rather than leaving it out.
      const steps = await tx.query<{ readonly dispatched_at: Date | null }>(
        `select dispatched_at from public.planned_steps where business_id = $1 and run_id = $2`,
        [fixture.businessId, proposal.runId],
      );
      expect(steps[0]?.dispatched_at).toBeNull();
    });
  });

  it('refuses a decision on a version that a successor superseded', async () => {
    const first = await proposeOn(database, fixture);
    const second = await proposeOn(database, fixture, { lineageId: first.lineageId });

    expect(second.version).toBe(first.version + 1);

    // The old gate is superseded rather than left pending, and deciding it
    // refuses on that ground rather than on a missing row.
    const refused = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await decide(tx, {
          gateId: first.gateId,
          versionId: first.versionId,
          decidedByPersonId: fixture.decider.personId,
          decidedByActorId: fixture.decider.actorId,
          subjects: subjectsOf(fixture.decider),
          collection: TASK_COLLECTION,
          decision: 'approve',
          note: 'approving the stale one',
          signingKey: TEST_SIGNING_KEY,
          capId: fixture.capId,
        }),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.refusal.code).toBe('GATE_ALREADY_DECIDED');

    // And nothing was reserved by the refusal.
    await database.app.withBusiness(fixture.businessId, async (tx) => {
      const held = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.reservations
          where business_id = $1 and version_id = $2`,
        [fixture.businessId, first.versionId],
      );
      expect(held[0]?.count).toBe('0');
    });

    // The live gate on version 2 still decides, which is what makes the
    // refusal above about staleness rather than about the lineage being stuck.
    const approved = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await decide(tx, {
          gateId: second.gateId,
          versionId: second.versionId,
          decidedByPersonId: fixture.decider.personId,
          decidedByActorId: fixture.decider.actorId,
          subjects: subjectsOf(fixture.decider),
          collection: TASK_COLLECTION,
          decision: 'approve',
          note: 'approving the live one',
          signingKey: TEST_SIGNING_KEY,
          capId: fixture.capId,
        }),
    );
    expect(approved.ok).toBe(true);
  });

  it('refuses an expired gate on the database clock', async () => {
    const proposal = await proposeOn(database, fixture, { expiresAt: new Date(Date.now() - 1000) });

    const refused = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await decide(tx, {
          gateId: proposal.gateId,
          versionId: proposal.versionId,
          decidedByPersonId: fixture.decider.personId,
          decidedByActorId: fixture.decider.actorId,
          subjects: subjectsOf(fixture.decider),
          collection: TASK_COLLECTION,
          decision: 'approve',
          note: 'too late',
          signingKey: TEST_SIGNING_KEY,
          capId: fixture.capId,
        }),
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.refusal.code).toBe('GATE_EXPIRED');
  });

  it('yields one decision and one reservation when two approvals race the same version', async () => {
    // Its own task, and so its own envelope. Sharing the earlier cases' task
    // would have the loser refused BUDGET_UNAVAILABLE by an envelope those
    // cases already filled, which is a true refusal but not this one.
    const racing = await buildFixture(database.app, 'racebiz');
    const proposal = await proposeOn(database, racing);
    const gate = barrier();

    const request = {
      gateId: proposal.gateId,
      versionId: proposal.versionId,
      decidedByPersonId: racing.decider.personId,
      decidedByActorId: racing.decider.actorId,
      subjects: subjectsOf(racing.decider),
      collection: TASK_COLLECTION,
      decision: 'approve' as const,
      note: 'race',
      signingKey: TEST_SIGNING_KEY,
      capId: racing.capId,
    };

    // A second physical connection, because the fixture's pool is `max: 1`:
    // on one pooled handle the second caller would queue on the *pool* and
    // never reach the gate row, which is a different wait and not this proof.
    const rival: Database = connect(database.appUrl, { max: 1, source: 'rival' });

    // The first transaction decides and then holds itself open on the barrier,
    // so the second reaches the gate row lock while the first is uncommitted.
    const firstRun = database.app.withBusiness(racing.businessId, async (tx) => {
      const result = await decide(tx, request);
      await gate.held;
      return result;
    });

    // The first caller has to have reached its own decision before the second
    // starts, or the second simply runs first and the race is not the one
    // named. This wait is bounded and the *contested* wait below is the
    // observed one.
    await delay(150);

    const secondRun = rival.withBusiness(
      racing.businessId,
      async (tx) => await decide(tx, request),
    );

    await awaitBlockedOnLock(database);
    gate.release();

    const [first, second] = await Promise.all([firstRun, secondRun]);
    await rival.close();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('two decisions were taken on one version');
    expect(second.refusal.code).toBe('GATE_ALREADY_DECIDED');

    await database.app.withBusiness(racing.businessId, async (tx) => {
      const decisions = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.gate_decisions
          where business_id = $1 and gate_id = $2`,
        [racing.businessId, proposal.gateId],
      );
      expect(decisions[0]?.count).toBe('1');

      const reservations = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.reservations
          where business_id = $1 and version_id = $2`,
        [racing.businessId, proposal.versionId],
      );
      expect(reservations[0]?.count).toBe('1');

      const attempts = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.attempts a
           join public.reservations r on r.business_id = a.business_id and r.id = a.reservation_id
          where a.business_id = $1 and r.version_id = $2`,
        [racing.businessId, proposal.versionId],
      );
      expect(attempts[0]?.count).toBe('1');
    });
  }, 60_000);

  it('signs every decision and chains them so a removed row is visible', async () => {
    const rows = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await tx.query<{
          readonly id: string;
          readonly seq: string;
          readonly gate_id: string;
          readonly version_id: string;
          readonly decision: string;
          readonly decided_by_person_id: string;
          readonly payload_digest: string;
          readonly signature: string;
          readonly signing_key_id: string;
          readonly prev_hash: string;
          readonly hash: string;
        }>(
          `select id, seq::text as seq, gate_id, version_id, decision, decided_by_person_id,
                payload_digest, signature, signing_key_id, prev_hash, hash
           from public.gate_decisions where business_id = $1 order by seq`,
          [fixture.businessId],
        ),
    );

    expect(rows.length).toBeGreaterThan(0);

    const broken = verifyChain(
      TEST_SIGNING_KEY,
      rows.map((row) => Object.assign({}, row, { seq: Number(row.seq) })),
      (row) => ({
        id: (row as unknown as { id: string }).id,
        seq: Number(row.seq),
        gate: (row as unknown as { gate_id: string }).gate_id,
        version: (row as unknown as { version_id: string }).version_id,
        decision: (row as unknown as { decision: string }).decision,
        person: (row as unknown as { decided_by_person_id: string }).decided_by_person_id,
        payloadDigest: row.payload_digest,
        signature: row.signature,
      }),
    );
    expect(broken).toBeNull();
  });

  it('refuses to update or delete a decision, twice over', async () => {
    const first = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await tx.query<{ readonly id: string }>(
          `select id from public.gate_decisions where business_id = $1 order by seq limit 1`,
          [fixture.businessId],
        ),
    );
    const id = first[0]?.id as string;

    // The application role never holds `update` or `delete` on this table, so
    // its refusal is a privilege refusal and arrives before any trigger runs.
    await expect(
      database.app.withBusiness(fixture.businessId, async (tx) => {
        await tx.query(
          `update public.gate_decisions set decision = 'reject' where business_id = $1 and id = $2`,
          [fixture.businessId, id],
        );
      }),
    ).rejects.toThrow(/permission denied/u);

    // The owner does hold it, and the trigger is what stops the owner. Without
    // this half the grant is the whole mechanism, and a later migration that
    // granted `update` would silently make the trail amendable.
    await expect(
      database.admin.execute(`update public.gate_decisions set decision = 'reject' where id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/append only/u);

    await expect(
      database.admin.execute(`delete from public.gate_decisions where id = $1`, [id]),
    ).rejects.toThrow(/append only/u);
  });

  it('keeps the envelope totals reconciled with its reservations', async () => {
    await database.app.withBusiness(fixture.businessId, async (tx) => {
      const envelopes = await tx.query<{ readonly id: string }>(
        `select id from public.task_envelopes where business_id = $1`,
        [fixture.businessId],
      );
      for (const envelope of envelopes) {
        // One envelope at a time, inside the one transaction.
        // eslint-disable-next-line no-await-in-loop
        const totals = await envelopeTotals(tx, envelope.id);
        // eslint-disable-next-line no-await-in-loop
        const sums = await tx.query<{ readonly held: string; readonly actual: string }>(
          `select coalesce(sum(held_minor) filter (where state = 'held'), 0)::text as held,
                  coalesce(sum(actual_minor) filter (where state = 'actual'), 0)::text as actual
             from public.reservations where business_id = $1 and envelope_id = $2`,
          [fixture.businessId, envelope.id],
        );
        expect(totals.held).toBe(Number(sums[0]?.held ?? 0));
        expect(totals.actual).toBe(Number(sums[0]?.actual ?? 0));
        expect(totals.held + totals.actual).toBeLessThanOrEqual(totals.maximum);
      }
    });
  });
});
