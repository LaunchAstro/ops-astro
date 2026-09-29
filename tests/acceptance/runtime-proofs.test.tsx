// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d2: the two runtime proofs, against real processes killed hard.
//
// F1, `apply_after_api_stops`: a person decides through API process A; A is
// killed; the worker, parked after its pickup, applies the effect through a
// second process B started from the same tree and migration head, before A
// comes back, on the lease A gave it; the receipt cites the decision. B is
// killed too and a third process reads the decision, the receipt and the
// task's history back identically; the live channel reconnects to `resync`
// and nothing is replayed (RN-01).
//
// F2, `crash_between_apply_and_settle`: two workers park, one after the
// dispatch mark and one after the effect, and are killed. The page shows each
// step dispatched and not settled. The API's own pass (T3d1) then reconciles:
// the applied one settles with the effect counter at 1, the other resumes as
// a new attempt a replacement worker applies once. Without T3d1 the first
// stalls unknown and the second never resumes, so this stays red.
//
// Run by `pnpm verify:runtime-proofs` on its own Postgres; skipped otherwise.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { mount } from '../surfaces/mount.tsx';
import { enrolAgent } from './cast.ts';
import { bearer, call, personPath } from './world.ts';
import { evidence, hardKill, until } from './kill-harness.ts';
import { openProofWorld, origin, PROOFS_ASKED, type ProofWorld, type Work } from './proof-world.ts';

if (!PROOFS_ASKED) {
  console.warn('runtime-proofs: not asked (pnpm verify:runtime-proofs); nothing proved.');
}

type Name = Parameters<typeof pathOf>[0];

describe.skipIf(!PROOFS_ASKED)('T3d2: the runtime proofs against real hard kills', () => {
  let p: ProofWorld;
  const asAda = async (name: Name, body: object) => await p.asAda(name, body);
  const api = async (label: string) => await p.api(label);
  const worker = (w: Work, parkAt: string, name: string, leaseSeconds?: number) =>
    p.worker(w, parkAt, name, leaseSeconds);
  const effects = async (taskId: string) => await p.effects(taskId);
  const attempts = async (taskId: string) => await p.attempts(taskId);

  /** What a reader of bravo could see or a pass could move there. */
  const bravoRows = async (): Promise<readonly unknown[]> =>
    await Promise.all(
      [
        'reservations',
        'attempts',
        'leases',
        'operations',
        'alerts',
        'run_events',
        'audit_events',
      ].map(
        async (table) =>
          await p.admin.execute(
            `select md5(coalesce(string_agg(t::text, ',' order by t::text), '')) as digest
               from public.${table} t where business_id = $1`,
            [p.world.bravo],
          ),
      ),
    );

  /** The live channel's first events on a fresh connection, for `ms`. */
  async function liveEvents(taskId: string, ms: number): Promise<readonly string[]> {
    const seen: string[] = [];
    const response = await fetch(`${origin()}/api/b/alpha/live/task/${taskId}`, {
      headers: { authorization: `Bearer ${p.world.ada.token}` },
    });
    const reader = response.body?.getReader();
    if (reader === undefined) return seen;
    const deadline = Date.now() + ms;
    // jsdom's AbortSignal is not the one Node's fetch takes, so a deadline
    // races each read and the reader is cancelled once it passes.
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const next = await Promise.race([
        reader.read(),
        new Promise<undefined>((resolve) =>
          setTimeout(resolve, Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (next === undefined || next.done) break;
      for (const line of new TextDecoder().decode(next.value).split('\n')) {
        if (line.startsWith('event:')) seen.push(line.slice(6).trim());
      }
    }
    await reader.cancel().catch(() => undefined);
    return seen;
  }

  beforeAll(async () => {
    p = await openProofWorld('t3d2');
    // Something of bravo's for the pass to leave alone.
    await call(
      p.world.api,
      personPath('bravo', pathOf('task.create')),
      { operationId: randomUUID(), fields: { title: 'bravo keeps its own' } },
      bearer(p.world.bea.token),
    );
  }, 120_000);

  afterAll(async () => {
    await p?.close();
  });

  it('apply_after_api_stops: the worker applies through B after A is killed, and every read comes back the same', async () => {
    const a = await api('t3d2-api-a');
    const w = await p.approvedWork(p.world.agent);
    expect(await liveEvents(w.taskId, 500)).toStrictEqual(['resync']);
    const parked = worker(w, 'after-reservation', 't3d2-worker-f1');
    expect(await parked.parked()).toBe('after-reservation');
    await hardKill('F1 api A', a, p.admin, a.appName);

    const b = await api('t3d2-api-b');
    parked.resume();
    await parked.exited();
    const outcome = JSON.parse(parked.lines().at(-1) ?? '{}') as Record<string, unknown>;
    const applied = outcome['applied'] as { attemptId: string } | undefined;
    expect(applied, JSON.stringify(outcome)).toBeDefined();
    const receipt = await asAda('task.receipt', { attemptId: applied?.attemptId });
    expect(receipt).toMatchObject({
      receipt: { taskId: w.taskId, decision: { id: w.decisionId } },
    });
    // One lease, the one A handed out, carried the work through B.
    const leases = await p.admin.execute(
      'select id from public.leases where business_id = $1 and task_id = $2',
      [p.world.alpha, w.taskId],
    );
    expect(leases).toHaveLength(1);
    expect(await effects(w.taskId)).toBe(1);

    const reads = async () => [
      await asAda('task.read', { recordId: w.taskId }),
      await asAda('task.receipt', { attemptId: applied?.attemptId }),
      await asAda('task.execution', { recordId: w.taskId }),
    ];
    const before = await reads();
    await hardKill('F1 api B', b, p.admin, b.appName);
    await api('t3d2-api-a2');
    expect(await reads()).toStrictEqual(before);
    expect(await liveEvents(w.taskId, 1_500)).toStrictEqual(['resync']);
    evidence({ proof: 'apply_after_api_stops', result: 'pass' });
  }, 120_000);

  it('crash_between_apply_and_settle: killed after the effect and after the mark, reconciled, never repeated', async () => {
    // F1 leaves A2 serving; alone, this case starts it.
    const up = await fetch(`${origin()}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await api('t3d2-api-a2');
    const markOnly = await p.approvedWork(
      await enrolAgent(p.world.db, p.world.alpha, p.world.ada.actorId as string),
    );
    const applied = await p.approvedWork(
      await enrolAgent(p.world.db, p.world.alpha, p.world.ada.actorId as string),
    );
    // Room for the replacement hold a proved absence reserves, by the person (T2e).
    await asAda('budget.top_up', {
      recordId: markOnly.taskId,
      amountMinor: 2_500,
      fromMaximumMinor: 2_500,
    });
    const bravo = await bravoRows();

    const first = worker(markOnly, 'after-dispatch-mark', 't3d2-worker-mark', 20);
    const second = worker(applied, 'after-effect', 't3d2-worker-effect', 20);
    expect([await first.parked(), await second.parked()]).toStrictEqual([
      'after-dispatch-mark',
      'after-effect',
    ]);
    await hardKill('F2 worker after the dispatch mark', first, p.admin, 't3d2-api-a2');
    await hardKill('F2 worker after the effect', second, p.admin, 't3d2-api-a2');

    // The page, before any retry: each step dispatched, not settled.
    for (const w of [markOnly, applied]) {
      const client = new OperationsClient({
        origin: origin(),
        businessKey: 'alpha',
        token: p.world.ada.token,
        fetch,
      });
      // eslint-disable-next-line no-await-in-loop
      const page = await mount(
        <TaskDetailScreen client={client} grantKey="alpha:admin" taskKey={w.taskId} />,
      );
      // eslint-disable-next-line no-await-in-loop
      await until(() => page.find('[data-attempt-state="dispatched"]') !== null, 10_000);
      expect(page.find('[data-attempt-state="settled"]')).toBeNull();
      // eslint-disable-next-line no-await-in-loop
      await page.unmount();
    }
    expect(await effects(markOnly.taskId)).toBe(0);
    expect(await effects(applied.taskId)).toBe(1);

    // The API's own pass, on its interval, once the 20 s leases have run out.
    await until(async () => (await attempts(applied.taskId))[0]?.state === 'settled', 150_000);
    await until(async () => (await attempts(markOnly.taskId)).length === 2, 30_000);
    const replacements = [
      worker(markOnly, 'none', 't3d2-worker-mark-2'),
      worker(applied, 'none', 't3d2-worker-effect-2'),
    ];
    for (const one of replacements) {
      // eslint-disable-next-line no-await-in-loop
      expect(await one.exited()).toBeNull();
    }
    expect(replacements[1]?.lines().at(-1)).toBe(
      JSON.stringify({ idle: { taskId: applied.taskId } }),
    );
    expect(await effects(markOnly.taskId)).toBe(1);
    expect(await effects(applied.taskId)).toBe(1);
    const resumed = JSON.parse(replacements[0]?.lines().at(-1) ?? '{}') as {
      applied?: { attemptId: string };
    };
    const receipt = await asAda('task.receipt', { attemptId: resumed.applied?.attemptId });
    expect(receipt).toMatchObject({ receipt: { decision: { id: markOnly.decisionId } } });
    // Recovery touched only the killed runs' business.
    expect(await bravoRows()).toStrictEqual(bravo);
    evidence({ proof: 'crash_between_apply_and_settle', result: 'pass' });
  }, 300_000);
});
