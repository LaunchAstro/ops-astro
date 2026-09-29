// SPDX-License-Identifier: AGPL-3.0-only
//
// T3e1 and T3e2: `drop_is_not_cancel`, and `one_report_per_outage`, with real processes, from the kill harness and
// never from row writes. Each drop comes from what really happens to a
// worker: the provider fault injected into it at construction, its SIGKILL,
// or its SIGSTOP past its lease and then SIGCONT. Each keeps its own cause and
// fault, the work comes back by itself and a worker finishes it once. A
// person's cancellation at the same parked point never comes back, and the
// woken worker is refused. The pass runs as the API runs it
// (`passDeployment`), on the proof's own clock rather than the API's minute.
//
// Run by `pnpm verify:runtime-proofs` on its own Postgres; skipped otherwise.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passDeployment, registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import { enrolAgent } from './cast.ts';
import { evidence, hardKill } from './kill-harness.ts';
import { openProofWorld, PROOFS_ASKED, type ProofWorld, type Work } from './proof-world.ts';

const API = 't3e1-api';
const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

describe.skipIf(!PROOFS_ASKED)('T3e1: drops from real processes, never a cancellation', () => {
  let p: ProofWorld;

  const fresh = async (): Promise<Work> =>
    await p.approvedWork(
      await enrolAgent(p.world.db, p.world.alpha, p.world.ada.actorId as string),
    );

  const pass = async () => {
    const keys = new Map([
      ['alpha', p.world.alpha],
      ['bravo', p.world.bravo],
    ]);
    return await passDeployment(
      p.world.db.app,
      async (key) => await Promise.resolve(keys.get(key)),
      ['alpha', 'bravo'],
      registerEffectLookup,
    );
  };

  const kinds = async (taskId: string): Promise<readonly string[]> =>
    (
      await p.admin.execute<{ kind: string }>(
        'select kind from public.run_events where business_id = $1 and task_id = $2 order by position',
        [p.world.alpha, taskId],
      )
    ).map((row) => row.kind);

  /** Room for a replacement beside the kept hold, by the person (T2e, O6). */
  const room = async (w: Work): Promise<void> => {
    await p.asAda('budget.top_up', {
      recordId: w.taskId,
      amountMinor: 2_500,
      fromMaximumMinor: 2_500,
    });
  };

  /** A replacement worker applies the work that came back, once. */
  async function finishedOnce(w: Work, name: string): Promise<void> {
    const again = p.worker(w, 'none', name);
    expect(await again.exited()).toBeNull();
    expect(again.lines().at(-1)).toContain('"applied"');
    expect(await p.effects(w.taskId)).toBe(1);
  }

  beforeAll(async () => {
    p = await openProofWorld('t3e1');
    await p.api(API);
  }, 120_000);

  afterAll(async () => {
    await p?.close();
  });

  for (const cause of ['provider_unavailable', 'connection_lost'] as const) {
    it(`drop_is_not_cancel: ${cause}, injected after the mark, is held whole until the pass proves it absent, then applied once`, async () => {
      const w = await fresh();
      await room(w);
      const run = p.worker(w, 'none', `t3e1-worker-${cause}`, 900, cause);
      expect(await run.exited()).toBeNull();
      expect(
        run
          .lines()
          .some((line) => line.includes(`"dropped":{"taskId":"${w.taskId}","cause":"${cause}"}`)),
      ).toBe(true);
      // The provider may have acted: the whole hold stays unknown, nothing comes back yet.
      expect(await p.attempts(w.taskId)).toMatchObject([
        { state: 'liability_unknown', drop_cause: cause },
      ]);
      expect(await kinds(w.taskId)).toStrictEqual(['claimed', 'dropped']);
      expect(await pass()).toMatchObject({ ok: true });
      await finishedOnce(w, `t3e1-worker-${cause}-2`);
      expect(await p.attempts(w.taskId)).toMatchObject([
        { state: 'liability_unknown', drop_cause: cause },
        { state: 'settled', drop_cause: null },
      ]);
      evidence({ proof: 'drop_is_not_cancel', cause, result: 'pass' });
    }, 60_000);
  }

  it('drop_is_not_cancel: our worker, killed with SIGKILL after its pickup, is worker_lost; the work comes back', async () => {
    const w = await fresh();
    const lost = p.worker(w, 'after-reservation', 't3e1-worker-lost', 3);
    await lost.parked();
    await hardKill('T3e1 worker lost after its pickup', lost, p.admin, API);
    await sleep(3_500);
    expect(await pass()).toMatchObject({ ok: true });
    expect(await p.attempts(w.taskId)).toMatchObject([
      { state: 'dropped', drop_cause: 'worker_lost' },
      { state: 'reserved', drop_cause: null },
    ]);
    await finishedOnce(w, 't3e1-worker-lost-2');
    evidence({ proof: 'drop_is_not_cancel', cause: 'worker_lost', result: 'pass' });
  }, 60_000);

  it('a silent run stays running until its lease runs out; the woken worker is refused (SIGSTOP, then SIGCONT)', async () => {
    const w = await fresh();
    const stalled = p.worker(w, 'after-reservation', 't3e1-worker-stalled', 3);
    await stalled.parked();
    expect(await pass()).toMatchObject({ ok: true });
    expect(await p.attempts(w.taskId)).toMatchObject([{ state: 'dispatched', drop_cause: null }]);
    await sleep(3_500);
    expect(await pass()).toMatchObject({ ok: true });
    expect(await p.attempts(w.taskId)).toMatchObject([
      { state: 'dropped', drop_cause: 'worker_lost' },
      { state: 'reserved' },
    ]);
    stalled.resume();
    await stalled.exited();
    expect(stalled.lines().at(-1)).toContain('"refused"');
    expect(await p.effects(w.taskId)).toBe(0);
    await finishedOnce(w, 't3e1-worker-stalled-2');
    evidence({ proof: 'silent_run_until_lease', result: 'pass' });
  }, 60_000);

  it("drop_is_not_cancel: a person's cancellation at the same point never comes back, and the woken worker is refused", async () => {
    const w = await fresh();
    const parked = p.worker(w, 'after-reservation', 't3e1-worker-cancelled', 3);
    await parked.parked();
    const [lineage] = await p.admin.execute<{ lineage_id: string }>(
      `select distinct run.lineage_id from public.planned_runs run
        where run.business_id = $1 and run.task_id = $2`,
      [p.world.alpha, w.taskId],
    );
    await p.asAda('task.cancel', {
      recordId: w.taskId,
      lineageId: lineage?.lineage_id,
      reason: 'a person stops this work',
    });
    await sleep(3_500);
    expect(await pass()).toMatchObject({ ok: true });
    parked.resume();
    await parked.exited();
    expect(parked.lines().at(-1)).toContain('"refused"');
    expect(await p.attempts(w.taskId)).toMatchObject([{ state: 'abandoned', drop_cause: null }]);
    expect(await kinds(w.taskId)).toStrictEqual(['claimed']);
    expect(await p.effects(w.taskId)).toBe(0);
    evidence({ proof: 'drop_is_not_cancel', cause: 'cancelled', result: 'pass' });
  }, 60_000);
  it('one_report_per_outage: five real workers dropped by one outage give one report, and every run comes back', async () => {
    const five = await Promise.all(Array.from({ length: 5 }, async () => await fresh()));
    for (const w of five) {
      // eslint-disable-next-line no-await-in-loop
      await room(w);
    }
    const runs = five.map((w, at) =>
      p.worker(w, 'none', `t3e2-worker-${String(at)}`, 900, 'provider_unavailable'),
    );
    for (const run of runs) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run.exited()).toBeNull();
    }
    const reports = await p.admin.execute<{ id: string; tasks: string[]; back: boolean }>(
      `select r.id, array_agg(o.task_id::text order by o.task_id) as tasks, bool_and(o.reactivated) as back
         from public.outage_reports r
         join public.outage_runs o on o.business_id = r.business_id and o.outage_id = r.id
        where r.business_id = $1 and o.task_id = any($2::uuid[])
        group by r.id`,
      [p.world.alpha, five.map((w) => w.taskId)],
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.tasks).toStrictEqual(five.map((w) => w.taskId).toSorted());
    // Dropped after the mark: none is back until the pass proves each absent.
    expect(reports[0]?.back).toBe(false);
    expect(await pass()).toMatchObject({ ok: true });
    const back = await p.admin.execute<{ back: boolean }>(
      'select bool_and(reactivated) as back from public.outage_runs where business_id = $1 and task_id = any($2::uuid[])',
      [p.world.alpha, five.map((w) => w.taskId)],
    );
    expect(back[0]?.back).toBe(true);
    const again = five.map((w, at) => p.worker(w, 'none', `t3e2-worker-${String(at)}-2`));
    for (const run of again) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run.exited()).toBeNull();
    }
    const raised = await p.admin.execute<{ kind: string }>(
      'select distinct kind from public.alerts where business_id = $1 and task_id = any($2::uuid[])',
      [p.world.alpha, five.map((w) => w.taskId)],
    );
    // Each run's settlement is its own transition; the drop raised none.
    expect(raised.map((row) => row.kind)).toStrictEqual(['settled']);
    for (const w of five) {
      // eslint-disable-next-line no-await-in-loop
      expect(await p.effects(w.taskId)).toBe(1);
    }
    evidence({ proof: 'one_report_per_outage', runs: 5, result: 'pass' });
  }, 90_000);
});
