// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 retention: the product is the trace store's deletion authority. A
// pass enumerates the runs whose events are all exported and older than the
// window, from the product's own records; deletes their traces by derived id
// through custody, paging; confirms each absence by reading it back rather
// than trusting the reply; and records the pass. A run whose deletion is not
// confirmed stays for the next pass, recorded as unconfirmed.

import { expect, it as vitestIt } from 'vitest';
import {
  derivedId,
  EXPIRY_PAGE,
  expireOnce,
  TRACE_WINDOW_DAYS,
} from '../../packages/core-runtime/src/index.ts';
import { liveWork, rows, type Schedules } from './schedules-harness.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';
import { age, batchesOf, clearSeen, deletedIds } from './aw-13-retention-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('aw13ret');

const traceOf = (s: Schedules, runId: string): string =>
  derivedId(TRACE_KEY, ['trace', s.business, runId], 32);

/** Work exported in full, then aged past the window. */
async function oldRun(s: Schedules, title = `aw13 old ${String(Date.now())}`): Promise<string> {
  const work = await liveWork(s, title, 1_000);
  await drain(s);
  const runId = String(work.picked['runId']);
  await age(runId, TRACE_WINDOW_DAYS + 1);
  return runId;
}

async function pass(s: Schedules, page?: number): ReturnType<typeof expireOnce> {
  return await expireOnce(
    t.alpha.db.app,
    s.business,
    TRACE_KEY,
    t.target.expiry,
    page === undefined ? {} : { page },
  );
}

it('AW-13 retention: a past-window run’s trace is deleted by its derived id through custody, its absence read back, and the pass recorded', async () => {
  const old = await oldRun(t.alpha);
  const fresh = String((await liveWork(t.alpha, 'aw13 fresh', 1_000)).picked['runId']);
  await drain(t.alpha);
  expect(t.target.stored.has(traceOf(t.alpha, old))).toBe(true);
  clearSeen();
  const passes = await pass(t.alpha);
  expect(passes.at(-1)).toMatchObject({ code: null });
  expect(deletedIds()).toContain(traceOf(t.alpha, old));
  expect(deletedIds()).not.toContain(traceOf(t.alpha, fresh));
  expect(t.target.stored.has(traceOf(t.alpha, old))).toBe(false);
  expect(t.target.stored.has(traceOf(t.alpha, fresh))).toBe(true);
  // The delete, then a read of each id deleted; each with custody's fixed header.
  expect(t.target.methods[0]).toBe('DELETE');
  expect(t.target.methods).toContain('GET');
  expect(new Set(t.target.ingestion)).toEqual(new Set(['4']));
  const batch = (await batchesOf(t.alpha)).find((one) => one.expired_run_ids.includes(old));
  expect(batch).toMatchObject({ window_days: TRACE_WINDOW_DAYS, code: null });
  expect(batch?.expired_run_ids).not.toContain(fresh);
});

it('AW-13 retention trusts no success reply: a delete the target skipped stays for the next pass, recorded as unconfirmed', async () => {
  const old = await oldRun(t.alpha);
  t.target.mode = 'skipping';
  try {
    const passes = await pass(t.alpha);
    expect(passes.at(-1)).toMatchObject({ code: 'expiry_unconfirmed' });
  } finally {
    t.target.mode = 'ok';
  }
  const unconfirmed = await batchesOf(t.alpha);
  expect(unconfirmed.some((one) => one.expired_run_ids.includes(old))).toBe(false);
  expect(unconfirmed.at(-1)).toMatchObject({ code: 'expiry_unconfirmed' });
  // The next pass deletes it again and confirms it.
  clearSeen();
  await pass(t.alpha);
  expect(deletedIds()).toContain(traceOf(t.alpha, old));
  expect((await batchesOf(t.alpha)).some((one) => one.expired_run_ids.includes(old))).toBe(true);
});

it('AW-13 retention: a failed delete records a gap with its code and marks nothing expired', async () => {
  const old = await oldRun(t.alpha);
  for (const [mode, code] of [
    ['refusing', 'target_refused'],
    ['redirect', 'target_redirect'],
    ['down', 'target_unreachable'],
  ] as const) {
    t.target.mode = mode;
    clearSeen();
    try {
      // oxlint-disable-next-line no-await-in-loop
      const passes = await pass(t.alpha);
      expect(passes.at(-1), mode).toMatchObject({ code });
    } finally {
      t.target.mode = 'ok';
    }
    // No read-back after a failed delete: nothing was confirmed.
    expect(t.target.methods, mode).not.toContain('GET');
    // oxlint-disable-next-line no-await-in-loop
    const batches = await batchesOf(t.alpha);
    expect(batches.some((one) => one.expired_run_ids.includes(old))).toBe(false);
    expect(batches.at(-1)).toMatchObject({ code, expired_run_ids: [] });
  }
  expect(t.target.stored.has(traceOf(t.alpha, old))).toBe(true);
});

it('AW-13 retention pages its deletes at the endpoint’s cap of 1,000 ids', async () => {
  expect(EXPIRY_PAGE).toBe(1_000);
  await pass(t.bravo);
  const runs = [await oldRun(t.bravo), await oldRun(t.bravo), await oldRun(t.bravo)];
  clearSeen();
  const passes = await pass(t.bravo, 2);
  const deletes = t.target.received.filter((_body, at) => t.target.methods[at] === 'DELETE');
  expect(deletes.length).toBeGreaterThanOrEqual(2);
  for (const body of deletes) {
    expect((JSON.parse(body) as { traceIds: string[] }).traceIds.length).toBeLessThanOrEqual(2);
  }
  expect(passes.length).toBeGreaterThanOrEqual(2);
  for (const runId of runs) expect(t.target.stored.has(traceOf(t.bravo, runId))).toBe(false);
});

it('AW-13 retention is idempotent: a rerun deletes nothing it already confirmed', async () => {
  const old = await oldRun(t.alpha);
  await pass(t.alpha);
  clearSeen();
  await pass(t.alpha);
  expect(deletedIds()).not.toContain(traceOf(t.alpha, old));
  const confirmed = (await batchesOf(t.alpha)).filter((one) => one.expired_run_ids.includes(old));
  expect(confirmed).toHaveLength(1);
});

it('AW-13 retention leaves a run with events not yet exported, and a run inside the window', async () => {
  const pendingWork = await liveWork(t.alpha, 'aw13 pending', 1_000);
  const pendingRun = String(pendingWork.picked['runId']);
  await age(pendingRun, TRACE_WINDOW_DAYS + 1);
  const inside = String((await liveWork(t.alpha, 'aw13 inside', 1_000)).picked['runId']);
  const found = await rows<{ n: string }>(
    t.alpha,
    `select count(*)::text as n from public.run_events where business_id = $1 and run_id = $2`,
    [t.alpha.business, pendingRun],
  );
  expect(Number(found[0]?.n)).toBeGreaterThan(0);
  clearSeen();
  await pass(t.alpha);
  expect(deletedIds()).not.toContain(traceOf(t.alpha, pendingRun));
  expect(deletedIds()).not.toContain(traceOf(t.alpha, inside));
  await drain(t.alpha);
});
