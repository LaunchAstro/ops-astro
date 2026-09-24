// SPDX-License-Identifier: AGPL-3.0-only
//
// RECOVERY-ENTRY: TRANSACTION-CONTRACT lines 84 and 92 through the real
// startup caller. Every case starts `apps/api/server.ts` as its own OS process
// on a free loopback port, against a throwaway database, and reads the result
// from the database afterwards. Nothing below calls the classifier or the
// lifecycle function to make an assertion true; the only direct calls are the
// scope parser's pure cases.
//
// The eligible state is historical recovery setup, written openly: an
// approved hold whose lineage is then marked rejected by a separate statement,
// so the recorded terminal transition exists and its classification does not.
// The current owning operations classify in the same transaction and a crash
// cannot split them; this fixture stands for a row written before they did.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { pickup } from '../../packages/core-runtime/src/pickup.ts';
import { NO_DEPLOYMENT_BUSINESSES, parseRecoveryScope } from '../../apps/api/recovery-entry.ts';
import {
  buildFixture,
  envelopeTotals,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/recovery-entry: DATABASE_URL is unset, so nothing below ran.');
}

interface Work {
  readonly taskId: string;
  readonly lineageId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly envelopeId: string;
}

/** Propose and approve on one task, through the real runtime operations. */
async function approved(
  database: Database,
  fixture: RuntimeFixture,
  taskId: string,
): Promise<Work> {
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const proposed = await propose(tx, {
      taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor: 5_000,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
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
    if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
    return {
      taskId,
      lineageId: proposed.value.lineageId,
      reservationId: decided.value.reservationId as string,
      attemptId: decided.value.attemptId as string,
      envelopeId: decided.value.envelopeId as string,
    };
  });
}

/** The historical recorded transition: the lineage is terminal, its hold is not classified. */
async function recordRejection(database: Database, businessId: string, work: Work): Promise<void> {
  await database.withBusiness(businessId, async (tx) => {
    await tx.query(
      `update public.proposal_lineages
          set state = 'rejected', terminal_reason = 'historical rejection', terminal_at = now()
        where business_id = $1 and id = $2`,
      [businessId, work.lineageId],
    );
  });
}

interface ReservationRow {
  readonly state: string;
  readonly held_minor: string;
  readonly lease_id: string | null;
  readonly classified_cause: string | null;
  readonly classified_cause_id: string | null;
  readonly terminal_at: string | null;
}

async function reservation(
  database: Database,
  businessId: string,
  work: Work,
): Promise<ReservationRow & { readonly envelopeHeld: number; readonly envelopeActual: number }> {
  return await database.withBusiness(businessId, async (tx) => {
    const rows = await tx.query<ReservationRow>(
      `select state, held_minor::text as held_minor, lease_id, classified_cause,
              classified_cause_id, terminal_at::text as terminal_at
         from public.reservations where business_id = $1 and id = $2`,
      [businessId, work.reservationId],
    );
    const totals = await envelopeTotals(tx, work.envelopeId);
    const row = rows[0];
    if (row === undefined) throw new Error(`no reservation ${work.reservationId}`);
    return { ...row, envelopeHeld: totals.held, envelopeActual: totals.actual };
  });
}

/** Rows startup must never create, per business. */
async function createdRows(
  database: Database,
  businessId: string,
): Promise<Record<string, string>> {
  return await database.withBusiness(businessId, async (tx) => {
    const rows = await tx.query<Record<string, string>>(
      `select
         (select count(*)::text from public.gate_decisions where business_id = $1) as decisions,
         (select count(*)::text from public.leases where business_id = $1) as leases,
         (select count(*)::text from public.attempts where business_id = $1) as attempts,
         (select count(*)::text from public.attempts where business_id = $1 and dispatch_marker) as marked,
         (select count(*)::text from public.delegations where business_id = $1) as delegations,
         (select count(*)::text from public.proposal_lineages where business_id = $1 and state = 'cancelled') as cancelled,
         (select coalesce(sum(actual_minor), 0)::text from public.task_envelopes where business_id = $1) as actual`,
      [businessId],
    );
    return rows[0] ?? {};
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

interface Started {
  /** The pid this suite started, and the only one it stops. */
  readonly pid: number;
  readonly ready: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  stop(): Promise<void>;
}

/**
 * Start the production entry and wait until it answers health or exits.
 * `scope` is the configured value; `undefined` passes a blank one.
 */
async function startServer(db: FreshDatabase, scope: string | undefined): Promise<Started> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const admin = new URL(serverUrl as string);
  admin.pathname = `/${db.name}`;
  const keys = mkdtempSync(join(tmpdir(), 'recovery-entry-keys-'));
  const child = spawn(process.execPath, ['apps/api/server.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      API_PORT: String(port),
      DATABASE_URL: db.appUrl,
      DATABASE_ADMIN_URL: admin.toString(),
      SUPABASE_JWT_SECRET: 'recovery-entry-secret-recovery-entry-secret',
      GATE_SIGNING_KEY_ID: '',
      GATE_SIGNING_SECRET: '',
      DELEGATION_CREDENTIAL_KEY_FILE: join(keys, 'delegation-keys.json'),
      // Blank rather than absent, so a `.local/recovery.env` in the checkout
      // cannot stand in for the value a case chose.
      RECOVERY_BUSINESS_KEYS: scope ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid as number;
  console.log(`recovery-entry: started apps/api/server.ts pid ${String(pid)} on ${origin}`);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let exitCode: number | null = null;
  let exited = false;
  const done = new Promise<void>((resolve) => {
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      resolve();
    });
  });
  const hasExited = (): boolean => exited;
  let ready = false;
  for (let attempt = 0; attempt < 200 && !hasExited() && !ready; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling one server
    ready = await fetch(`${origin}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (!ready) {
      // eslint-disable-next-line no-await-in-loop -- polling one server
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      await done;
      console.log(`recovery-entry: stopped pid ${String(pid)}`);
    }
    rmSync(keys, { recursive: true, force: true });
  };
  if (!ready) {
    await Promise.race([
      done,
      new Promise((resolve) => {
        setTimeout(resolve, 5_000);
      }),
    ]);
  }
  return {
    pid,
    ready,
    get exitCode() {
      return exitCode;
    },
    get output() {
      return output;
    },
    stop,
  };
}

describe('the recovery scope setting', () => {
  it('names businesses or says none, and nothing else passes', () => {
    expect(parseRecoveryScope(NO_DEPLOYMENT_BUSINESSES)).toStrictEqual({ ok: true, keys: [] });
    expect(parseRecoveryScope(' alpha , bravo,alpha ')).toStrictEqual({
      ok: true,
      keys: ['alpha', 'bravo'],
    });
    for (const refused of [undefined, '', '   ', 'alpha,,bravo', 'alpha,none', 'al pha', ',']) {
      expect(parseRecoveryScope(refused).ok, JSON.stringify(refused)).toBe(false);
    }
  });
});

describe.skipIf(serverUrl === undefined)('restart recovery at API startup', () => {
  let db: FreshDatabase;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'recovery_entry' });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  it('classifies a recorded eligible hold once before it serves, and a second start subtracts nothing', async () => {
    const fixture = await buildFixture(db.app, 'reca');
    const work = await approved(db.app, fixture, fixture.taskId);
    await recordRejection(db.app, fixture.businessId, work);
    const before = await reservation(db.app, fixture.businessId, work);
    expect(before.state).toBe('held');
    expect(before.envelopeHeld).toBe(5_000);

    const first = await startServer(db, 'reca');
    await first.stop();
    expect(first.ready, first.output).toBe(true);
    // Recovery committed before the socket was bound.
    const recoveredAt = first.output.indexOf(
      'restart recovery: reca committed, 1 classified, 1 released',
    );
    expect(recoveredAt, first.output).toBeGreaterThanOrEqual(0);
    expect(recoveredAt).toBeLessThan(first.output.indexOf('api: listening'));

    const classified = await reservation(db.app, fixture.businessId, work);
    expect(classified.state).toBe('abandoned');
    expect(classified.classified_cause).toBe('lineage_rejected');
    expect(classified.classified_cause_id).toBe(work.lineageId);
    expect(classified.envelopeHeld).toBe(0);
    expect(classified.envelopeActual).toBe(0);

    const second = await startServer(db, 'reca');
    await second.stop();
    expect(second.ready, second.output).toBe(true);
    expect(second.output).toContain('restart recovery: reca committed, 0 classified');
    expect(await reservation(db.app, fixture.businessId, work)).toStrictEqual(classified);
  }, 90_000);

  it('leaves claimable holds and unfenced live claims alone and keeps a marked hold whole', async () => {
    const fixture = await buildFixture(db.app, 'recd');
    const unleased = await approved(db.app, fixture, fixture.taskId);
    const claimed = await approved(
      db.app,
      fixture,
      await newTask(db.app, fixture.businessId, fixture.decider),
    );
    const marked = await approved(
      db.app,
      fixture,
      await newTask(db.app, fixture.businessId, fixture.decider),
    );
    const eligible = await approved(
      db.app,
      fixture,
      await newTask(db.app, fixture.businessId, fixture.decider),
    );

    // A live claim whose lease timestamp has elapsed. Nothing fenced it.
    await db.app.withBusiness(fixture.businessId, async (tx) => {
      const picked = await pickup(tx, {
        claimant: 'person',
        personId: fixture.decider.personId,
        actorId: fixture.decider.actorId,
        authorisedByPersonId: fixture.decider.personId,
        reservationId: claimed.reservationId,
        collection: TASK_COLLECTION,
        leaseSeconds: 60,
      });
      if (!picked.ok) throw new Error(`pickup refused ${picked.refusal.code}`);
      await tx.query(
        `update public.leases set expires_at = now() - interval '1 hour'
          where business_id = $1 and id = $2`,
        [fixture.businessId, picked.value.leaseId],
      );
    });
    // A marked attempt on a lineage that then recorded its rejection.
    await db.app.withBusiness(fixture.businessId, async (tx) => {
      await tx.query(
        `update public.attempts set dispatch_marker = true, state = 'quarantined'
          where business_id = $1 and id = $2`,
        [fixture.businessId, marked.attemptId],
      );
    });
    await recordRejection(db.app, fixture.businessId, marked);
    await recordRejection(db.app, fixture.businessId, eligible);

    const unleasedBefore = await reservation(db.app, fixture.businessId, unleased);
    const claimedBefore = await reservation(db.app, fixture.businessId, claimed);
    const rowsBefore = await createdRows(db.app, fixture.businessId);

    const started = await startServer(db, 'recd');
    await started.stop();
    expect(started.ready, started.output).toBe(true);

    expect(await reservation(db.app, fixture.businessId, unleased)).toStrictEqual(unleasedBefore);
    expect(await reservation(db.app, fixture.businessId, claimed)).toStrictEqual(claimedBefore);
    const leaseState = await db.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await tx.query<{ readonly state: string }>(
          `select state from public.leases where business_id = $1 and id = $2`,
          [fixture.businessId, claimedBefore.lease_id],
        ),
    );
    expect(leaseState[0]?.state).toBe('live');

    const markedAfter = await reservation(db.app, fixture.businessId, marked);
    expect(markedAfter.state).toBe('quarantined');
    expect(markedAfter.held_minor).toBe('5000');
    expect(markedAfter.envelopeHeld).toBe(5_000);
    expect((await reservation(db.app, fixture.businessId, eligible)).state).toBe('abandoned');

    // No cancellation, approval, lease, attempt, delegation, mark or spend.
    expect(await createdRows(db.app, fixture.businessId)).toStrictEqual(rowsBefore);
  }, 120_000);

  it('recovers only the configured businesses, one transaction each', async () => {
    const a = await buildFixture(db.app, 'rece');
    const b = await buildFixture(db.app, 'recf');
    const workA = await approved(db.app, a, a.taskId);
    const workB = await approved(db.app, b, b.taskId);
    await recordRejection(db.app, a.businessId, workA);
    await recordRejection(db.app, b.businessId, workB);
    const bBefore = await reservation(db.app, b.businessId, workB);

    const onlyA = await startServer(db, 'rece');
    await onlyA.stop();
    expect(onlyA.ready, onlyA.output).toBe(true);
    expect((await reservation(db.app, a.businessId, workA)).state).toBe('abandoned');
    expect(await reservation(db.app, b.businessId, workB)).toStrictEqual(bBefore);
    expect(onlyA.output).not.toContain('recf');

    const both = await startServer(db, 'rece,recf');
    await both.stop();
    expect(both.ready, both.output).toBe(true);
    expect(both.output).toContain('restart recovery: rece committed, 0 classified');
    expect(both.output).toContain('restart recovery: recf committed, 1 classified, 1 released');
    expect((await reservation(db.app, b.businessId, workB)).state).toBe('abandoned');
  }, 90_000);

  it('fails the start and rolls back when recovery fails, and the next start completes', async () => {
    const fixture = await buildFixture(db.app, 'recc');
    const work = await approved(db.app, fixture, fixture.taskId);
    await recordRejection(db.app, fixture.businessId, work);
    const before = await reservation(db.app, fixture.businessId, work);

    // Fault injection on this throwaway database only: the envelope write
    // inside the classifier's transaction raises, after the reservation's.
    await db.admin.execute(`
      create function public.recovery_entry_fault() returns trigger language plpgsql as $$
      begin raise exception 'recovery-entry injected fault'; end $$`);
    await db.admin.execute(`
      create trigger recovery_entry_fault before update on public.task_envelopes
        for each row execute function public.recovery_entry_fault()`);
    const failed = await startServer(db, 'recc');
    await failed.stop();
    await db.admin.execute('drop trigger recovery_entry_fault on public.task_envelopes');
    await db.admin.execute('drop function public.recovery_entry_fault()');

    expect(failed.ready).toBe(false);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.output).toContain('restart recovery for business "recc" rolled back');
    expect(failed.output).not.toContain('api: listening');
    expect(await reservation(db.app, fixture.businessId, work)).toStrictEqual(before);

    const next = await startServer(db, 'recc');
    await next.stop();
    expect(next.ready, next.output).toBe(true);
    const after = await reservation(db.app, fixture.businessId, work);
    expect(after.state).toBe('abandoned');
    expect(after.envelopeHeld).toBe(0);
  }, 90_000);

  it('refuses a blank, malformed or unresolvable scope and says none out loud', async () => {
    const fixture = await buildFixture(db.app, 'recs');
    const work = await approved(db.app, fixture, fixture.taskId);
    await recordRejection(db.app, fixture.businessId, work);
    const before = await reservation(db.app, fixture.businessId, work);

    for (const scope of [undefined, 'recs,,x', 'recs,nosuchbusiness']) {
      // eslint-disable-next-line no-await-in-loop -- one process at a time
      const refused = await startServer(db, scope);
      // eslint-disable-next-line no-await-in-loop -- one process at a time
      await refused.stop();
      expect(refused.ready, String(scope)).toBe(false);
      expect(refused.exitCode, String(scope)).toBe(1);
      expect(refused.output).toContain('RECOVERY_BUSINESS_KEYS');
      expect(refused.output).not.toContain('api: listening');
    }
    expect(await reservation(db.app, fixture.businessId, work)).toStrictEqual(before);

    const none = await startServer(db, NO_DEPLOYMENT_BUSINESSES);
    await none.stop();
    expect(none.ready, none.output).toBe(true);
    expect(none.output).toContain('restart recovery: explicitly no installation businesses');
    expect(await reservation(db.app, fixture.businessId, work)).toStrictEqual(before);
  }, 90_000);

  it('releases a hold once when two starts race on one business', async () => {
    const fixture = await buildFixture(db.app, 'recr');
    const works: Work[] = [];
    for (let index = 0; index < 3; index += 1) {
      const taskId =
        // eslint-disable-next-line no-await-in-loop -- one task at a time
        index === 0 ? fixture.taskId : await newTask(db.app, fixture.businessId, fixture.decider);
      // eslint-disable-next-line no-await-in-loop -- one approval at a time
      const work = await approved(db.app, fixture, taskId);
      // eslint-disable-next-line no-await-in-loop -- one transition at a time
      await recordRejection(db.app, fixture.businessId, work);
      works.push(work);
    }

    const [left, right] = await Promise.all([startServer(db, 'recr'), startServer(db, 'recr')]);
    await Promise.all([left.stop(), right.stop()]);
    const outcomes = [left, right];
    for (const one of outcomes) {
      const line = /restart recovery.*|api: restart recovery.*/u.exec(one.output)?.[0] ?? '';
      console.log(`recovery-entry race: pid ${String(one.pid)} ready=${String(one.ready)} ${line}`);
    }
    // At least one start completes. The other either found nothing left or
    // refused visibly on the changed discovery; neither is a silent success.
    expect(outcomes.some((one) => one.ready)).toBe(true);
    for (const one of outcomes) {
      if (!one.ready) {
        expect(one.exitCode).toBe(1);
        expect(one.output).toContain('restart recovery for business "recr" rolled back');
      }
    }
    const released = outcomes
      .map((one) => /recr committed, (\d+) classified, (\d+) released/u.exec(one.output))
      .reduce((sum, match) => sum + Number(match?.[2] ?? 0), 0);
    expect(released).toBe(3);
    for (const work of works) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const row = await reservation(db.app, fixture.businessId, work);
      expect(row.state).toBe('abandoned');
      expect(row.envelopeHeld).toBe(0);
    }
  }, 90_000);
});
