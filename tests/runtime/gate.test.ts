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
import { acquire } from '../../packages/core-runtime/src/locks.ts';
import {
  decidedAtText,
  decisionLink,
  linkVersionOf,
  verifyChain,
} from '../../packages/core-runtime/src/signing.ts';
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

/**
 * Which table the blocked backend is parked on. A waiter takes the tuple lock
 * first and then waits on the holder's transaction, so the tuple lock names
 * the row it wants — which is the whole question in the lock-order case.
 */
async function blockedOnRelation(database: FreshDatabase): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await database.admin.execute<{ readonly relname: string }>(
      `select c.relname from pg_stat_activity a
         join pg_locks l on l.pid = a.pid and l.locktype = 'tuple'
         join pg_class c on c.oid = l.relation
        where a.datname = current_database() and a.wait_event_type = 'Lock'
        limit 1`,
    );
    const relname = rows[0]?.relname;
    if (relname !== undefined) return relname;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error('no backend ever blocked on a row lock: the interleaving was not established');
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

/** Decide a gate as the fixture's decider, returning the raw result. */
async function decideOn(
  database: FreshDatabase,
  fixture: RuntimeFixture,
  of: { readonly gateId: string; readonly versionId: string },
  decision: 'approve' | 'reject' | 'request_changes',
  note = 'as asked',
) {
  return await database.app.withBusiness(fixture.businessId, async (tx) =>
    decide(tx, {
      gateId: of.gateId,
      versionId: of.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision,
      note,
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    }),
  );
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
    // A task of its own: the fixture task's envelope is filled by earlier
    // cases, and a new lineage on it is refused at propose (SOL-R3-3).
    const own = {
      ...fixture,
      taskId: await newTask(database.app, fixture.businessId, fixture.decider),
    };
    const proposal = await proposeOn(database, own, { expiresAt: new Date(Date.now() - 1000) });

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
          readonly decided_by_actor_id: string;
          readonly lineage_id: string;
          readonly round: number;
          readonly decided_at: string;
          readonly evidence_digest: string;
          readonly payload: Record<string, unknown>;
          readonly payload_digest: string;
          readonly signature: string;
          readonly signing_key_id: string;
          readonly prev_hash: string;
          readonly hash: string;
        }>(
          `select id, seq::text as seq, gate_id, version_id, decision, decided_by_person_id,
                decided_by_actor_id, lineage_id, round, ${decidedAtText('decided_at')} as decided_at,
                evidence_digest, payload, payload_digest, signature, signing_key_id, prev_hash, hash
           from public.gate_decisions where business_id = $1 order by seq`,
          [fixture.businessId],
        ),
    );

    expect(rows.length).toBeGreaterThan(0);

    type Row = (typeof rows)[number];
    const broken = verifyChain(
      TEST_SIGNING_KEY,
      rows.map((row) => Object.assign({}, row, { seq: Number(row.seq) })),
      (row) => {
        const full = row as unknown as Row;
        return decisionLink(linkVersionOf(full.payload) ?? 1, {
          id: full.id,
          seq: Number(full.seq),
          gate: full.gate_id,
          version: full.version_id,
          decision: full.decision,
          person: full.decided_by_person_id,
          payloadDigest: full.payload_digest,
          signature: full.signature,
          round: full.round,
          decidedAt: full.decided_at,
          lineage: full.lineage_id,
          actor: full.decided_by_actor_id,
          evidence: full.evidence_digest,
          key: full.signing_key_id,
        });
      },
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
  // Case 1 (G08). Two formal rounds, and the third is refused. Each round is a
  // new version with its own gate, and G04 holds across every one of them: the
  // superseded version's gate can no longer authorise anything.
  it('takes two rounds of requested changes and refuses the third', async () => {
    // Its own task, so the closing approval meets the round rule rather than
    // an envelope another case in this file already filled.
    const own = {
      ...fixture,
      taskId: await newTask(database.app, fixture.businessId, fixture.decider),
    };
    const one = await proposeOn(database, own);

    const first = await decideOn(database, own, one, 'request_changes', 'tighten the scope');
    expect(first.ok).toBe(true);

    const two = await proposeOn(database, own, { lineageId: one.lineageId });
    expect(two.version).toBe(2);
    expect(two.versionId).not.toBe(one.versionId);

    // G04 across rounds: version 1's gate is superseded and approves nothing.
    const stale = await decideOn(database, own, one, 'approve');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.refusal.code).toBe('GATE_ALREADY_DECIDED');

    const second = await decideOn(database, own, two, 'request_changes', 'and the budget');
    expect(second.ok).toBe(true);

    const three = await proposeOn(database, own, { lineageId: one.lineageId });
    expect(three.version).toBe(3);

    const third = await decideOn(database, own, three, 'request_changes', 'once more');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.refusal.code).toBe('CHANGE_ROUNDS_EXHAUSTED');

    await database.app.withBusiness(own.businessId, async (tx) => {
      // Exactly two formal rounds are recorded, and the refused third wrote
      // no decision: a refusal is not a decision.
      const rounds = await tx.query<{ readonly rounds: string }>(
        `select count(*)::text as rounds from public.gate_decisions
          where business_id = $1 and lineage_id = $2 and decision = 'request_changes'`,
        [own.businessId, one.lineageId],
      );
      expect(Number(rounds[0]?.rounds)).toBe(2);
      // No round approved anything, so the lineage holds no reservation.
      const held = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.reservations res
           join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
          where res.business_id = $1 and run.lineage_id = $2`,
        [own.businessId, one.lineageId],
      );
      expect(Number(held[0]?.count)).toBe(0);
    });

    // The third round is refused; the lineage is still live and can be
    // approved or rejected, which is what "escalate" means here.
    const approved = await decideOn(database, own, three, 'approve');
    expect(approved.ok).toBe(true);
  });

  // Case 2 (G05). Rejection is terminal, and only a new lineage goes on.
  it('takes no further decision on a rejected lineage, and restarts only as a new one', async () => {
    const own = {
      ...fixture,
      taskId: await newTask(database.app, fixture.businessId, fixture.decider),
    };
    const first = await proposeOn(database, own);
    const rejected = await decideOn(database, own, first, 'reject', 'not this');
    expect(rejected.ok).toBe(true);

    // Terminal: the gate is decided, so a second decision on it is refused...
    const again = await decideOn(database, own, first, 'approve');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal.code).toBe('GATE_ALREADY_DECIDED');

    // ...and a new version in the same lineage is refused on the lineage, not
    // on the gate. This is the one that matters: rejection closes the line.
    const reopened = await database.app.withBusiness(own.businessId, async (tx) =>
      propose(tx, {
        taskId: own.taskId,
        collection: TASK_COLLECTION,
        proposedByActorId: own.decider.actorId,
        subjects: subjectsOf(own.decider),
        purpose: 'draft_the_brief',
        maximumMinor: 5_000,
        currency: 'AUD',
        payload: { instruction: 'draft it again' },
        step: { kind: 'local.draft', payload: { words: 200 } },
        expiresAt: hour(),
        lineageId: first.lineageId,
      }),
    );
    expect(reopened.ok).toBe(false);
    if (!reopened.ok) expect(reopened.refusal.code).toBe('LINEAGE_TERMINAL');

    await database.app.withBusiness(own.businessId, async (tx) => {
      const rows = await tx.query<{ readonly state: string; readonly reason: string }>(
        `select state, terminal_reason as reason from public.proposal_lineages
          where business_id = $1 and id = $2`,
        [own.businessId, first.lineageId],
      );
      expect(rows[0]?.state).toBe('rejected');
      expect(rows[0]?.reason).toBe('gate_rejected');
    });

    // The authorised restart: a new lineage on the same task, a new version, a
    // new gate. It clears no terminal decision and revives nothing.
    const restarted = await proposeOn(database, own);
    expect(restarted.lineageId).not.toBe(first.lineageId);
    expect(restarted.versionId).not.toBe(first.versionId);
    expect(restarted.gateId).not.toBe(first.gateId);

    await database.app.withBusiness(own.businessId, async (tx) => {
      const gates = await tx.query<{ readonly state: string }>(
        `select state from public.gates where business_id = $1 and id = $2`,
        [own.businessId, restarted.gateId],
      );
      expect(gates[0]?.state).toBe('pending');
      // The rejected lineage stays rejected. A restart is beside it, not over it.
      const old = await tx.query<{ readonly state: string }>(
        `select state from public.proposal_lineages where business_id = $1 and id = $2`,
        [own.businessId, first.lineageId],
      );
      expect(old[0]?.state).toBe('rejected');
    });

    const decided = await decideOn(database, own, restarted, 'reject', 'and again');
    expect(decided.ok).toBe(true);
  });

  // Case 6 (W05). The cap's refusal, not the envelope's, and nothing held.
  it('refuses at the cap with BUDGET_EXHAUSTED and changes no total', async () => {
    const taskId = await newTask(database.app, fixture.businessId, fixture.decider);
    const overCap = { ...fixture, taskId };

    // The envelope this opens has room for the whole ask; the cap does not by
    // the time it is decided. The proposal fits the cap's room when it is
    // made (a proposal past it is refused at propose, R2-RUNTIME-26), and
    // another task's approval then takes 45,000 of that room.
    const proposal = await proposeOn(database, overCap, { maximumMinor: 50_000 });
    const filler = {
      ...fixture,
      taskId: await newTask(database.app, fixture.businessId, fixture.decider),
    };
    const filled = await decideOn(
      database,
      filler,
      await proposeOn(database, filler, { maximumMinor: 45_000 }),
      'approve',
    );
    expect(filled.ok).toBe(true);

    const before = await database.app.withBusiness(fixture.businessId, async (tx) =>
      tx.query<{ readonly held: string; readonly actual: string }>(
        `select coalesce(sum(held_minor), 0)::text as held,
                coalesce(sum(actual_minor), 0)::text as actual
           from public.task_envelopes where business_id = $1`,
        [fixture.businessId],
      ),
    );

    const refused = await decideOn(database, overCap, proposal, 'approve');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // Distinct from BUDGET_UNAVAILABLE on purpose: the caller told the wrong
      // one raises the wrong ceiling.
      expect(refused.refusal.code).toBe('BUDGET_EXHAUSTED');
      expect(refused.refusal.reason).toContain('cap');
    }

    await database.app.withBusiness(fixture.businessId, async (tx) => {
      const after = await tx.query<{ readonly held: string; readonly actual: string }>(
        `select coalesce(sum(held_minor), 0)::text as held,
                coalesce(sum(actual_minor), 0)::text as actual
           from public.task_envelopes where business_id = $1`,
        [fixture.businessId],
      );
      expect(after[0]?.held).toBe(before[0]?.held);
      expect(after[0]?.actual).toBe(before[0]?.actual);

      // Half a commit is the failure this case is really watching for: the
      // gate must not be left approved by a decision that reserved nothing.
      const gates = await tx.query<{ readonly state: string }>(
        `select state from public.gates where business_id = $1 and id = $2`,
        [fixture.businessId, proposal.gateId],
      );
      expect(gates[0]?.state).toBe('pending');
      const decisions = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.gate_decisions
          where business_id = $1 and gate_id = $2`,
        [fixture.businessId, proposal.gateId],
      );
      expect(Number(decisions[0]?.count)).toBe(0);
      const reservations = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.reservations res
          where res.business_id = $1 and res.version_id = $2`,
        [fixture.businessId, proposal.versionId],
      );
      expect(Number(reservations[0]?.count)).toBe(0);
    });

    // And the envelope's own refusal is still the other code, on its own ground.
    const inside = await proposeOn(database, overCap, {
      lineageId: proposal.lineageId,
      maximumMinor: 1_000,
    });
    const ok = await decideOn(database, overCap, inside, 'approve');
    expect(ok.ok).toBe(true);
  });
  // Case 7. The lock order, and why `locks.ts` exists at all.
  it('normalises the lock order so two crossing transactions never deadlock', async () => {
    const locking = await buildFixture(database.app, 'lockbiz');
    const proposal = await proposeOn(database, locking);
    const approved = await decideOn(database, locking, proposal, 'approve');
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error('unreachable');
    if (approved.value.decision !== 'approve')
      throw new Error(`expected an approval, got ${approved.value.decision}`);
    const envelopeId = approved.value.envelopeId;

    const opened = barrier();
    const rival: Database = connect(database.appUrl, { max: 1, source: 'lock-rival' });

    // Both callers list the set in an order the contract forbids, and neither
    // lists the same wrong order. Honoured literally, the first would hold the
    // gate and want the cap while the second held the cap and wanted the gate,
    // which is a deadlock Postgres would have to detect and kill. `acquire`
    // sorts both into cap, envelope, gate, so there is nothing to detect.
    const first = database.app.withBusiness(locking.businessId, async (tx) => {
      const held = await acquire(tx, [
        { lockClass: 'gate', id: proposal.gateId },
        { lockClass: 'envelope', id: envelopeId },
        { lockClass: 'cap', id: locking.capId },
      ]);
      await opened.held;
      return held;
    });

    await delay(150);

    const second = rival.withBusiness(
      locking.businessId,
      async (tx) =>
        await acquire(tx, [
          { lockClass: 'envelope', id: envelopeId },
          { lockClass: 'cap', id: locking.capId },
          { lockClass: 'gate', id: proposal.gateId },
        ]),
    );

    // The observed fact, not a slept-through one: the second caller listed the
    // envelope first and is waiting on the **cap**, because that is the class
    // `acquire` reached first. A literal reading would have it on the envelope.
    const waitingOn = await blockedOnRelation(database);
    expect(waitingOn).toBe('budget_caps');

    opened.release();

    // Both complete. A deadlock here would surface as `40P01 deadlock
    // detected` on one of them rather than as a hang, so awaiting both is the
    // assertion: the run that deadlocks throws instead of resolving.
    const [held, alsoHeld] = await Promise.all([first, second]);
    await rival.close();

    expect(held.has('cap', locking.capId)).toBe(true);
    expect(held.has('envelope', envelopeId)).toBe(true);
    expect(held.has('gate', proposal.gateId)).toBe(true);
    expect(alsoHeld.holds).toStrictEqual(held.holds);

    // The wrong order is unreachable through `acquire` by construction — it
    // sorts, so there is no way to ask it for a late cap. What a helper *can*
    // do wrong is reach for a lock nobody took, and that is refused here,
    // loudly, before Postgres is ever asked about it.
    await database.app.withBusiness(locking.businessId, async (tx) => {
      const set = await acquire(tx, [{ lockClass: 'gate', id: proposal.gateId }]);
      expect(() => {
        set.require('cap', locking.capId);
      }).toThrow('lock order');
      expect(() => {
        set.require('gate', proposal.gateId);
      }).not.toThrow();
    });
  }, 60_000);
});
