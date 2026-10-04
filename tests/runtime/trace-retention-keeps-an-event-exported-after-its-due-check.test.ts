// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 retention against a fresh export: a run past the window is chosen for
// deletion, then takes a new event that an export sends before the delete.
// The event must still be retrievable once retention and the next export tick
// are done. Real Postgres, an applied agent handback and custody delivery,
// with a barrier inside the target's delete.

import { expect, it } from 'vitest';
import { exportDeployment, retainDeployment } from '../../apps/api/trace-exporter.ts';
import { derivedId, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { asAgent, codeOf, handbackBody, liveWork, type Work } from './schedules-harness.ts';
import { age, batchesOf } from './aw-13-retention-world.ts';
import { drain, noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

/** The deployment's businesses, as the composition root hands them: here, alpha only. */
function alphaOnly(): Promise<readonly string[]> {
  return Promise.resolve([t.alpha.business]);
}

/**
 * Retention holds inside its delete of `traceId` while the run takes a fresh
 * event and an export sends it; then the delete goes on.
 */
async function exportDuringDelete(work: Work, traceId: string): Promise<void> {
  const selected = latch();
  const releaseDelete = latch();
  const retention = retainDeployment(t.alpha.db.app, alphaOnly, TRACE_KEY, {
    expire: async (ids) => {
      expect(ids).toContain(traceId);
      selected.resolve();
      await releaseDelete.promise;
      return await t.target.expiry.expire(ids);
    },
    present: t.target.expiry.present,
  });
  let freshExport: Promise<void> | undefined;
  let yieldExport: NodeJS.Timeout | undefined;
  const beforeFreshExport = t.target.received.length;
  try {
    await selected.promise;
    const answer = await asAgent(
      t.alpha,
      handbackBody(work.picked),
      String(work.picked['credential']),
    );
    expect(codeOf(answer)).toBe('applied');
    freshExport = exportDeployment(t.alpha.db.app, alphaOnly, TRACE_KEY, t.target.deliver);
    // Let an unsynchronised export finish before the delete; a corrected
    // exporter may wait for retention, so release that barrier as well.
    await Promise.race([
      freshExport,
      new Promise<void>((resolve) => {
        yieldExport = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    if (yieldExport) clearTimeout(yieldExport);
    releaseDelete.resolve();
    await Promise.all([retention, freshExport]);
  }
  expect(t.target.received.length).toBeGreaterThan(beforeFreshExport);
}

useAw13World('trace_retention_fresh_export');

it.skipIf(noDatabase)(
  'retention cannot delete a fresh event exported after its due-run check',
  async () => {
    const work = await liveWork(t.alpha, 'Sol retention versus new export', 1000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);
    await drain(t.alpha);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    expect(t.target.stored.has(traceId)).toBe(true);
    await exportDuringDelete(work, traceId);
    // Give a recovery strategy another tick; the current head's cursor
    // already passed the fresh event, so this does not restore its trace.
    await exportDeployment(t.alpha.db.app, alphaOnly, TRACE_KEY, t.target.deliver);
    expect(t.target.stored.has(traceId), 'the fresh exported event must remain retrievable').toBe(
      true,
    );
  },
);

it.skipIf(noDatabase)(
  'a run that took an event during its delete is not confirmed, and a later pass deletes it again',
  async () => {
    const work = await liveWork(t.alpha, 'retention holds back a run with a fresh event', 1000);
    const runId = String(work.picked['runId']);
    const traceId = derivedId(TRACE_KEY, ['trace', t.alpha.business, runId], 32);
    await drain(t.alpha);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    await exportDuringDelete(work, traceId);
    await drain(t.alpha);
    expect(t.target.stored.has(traceId), 'the fresh event is exported again').toBe(true);
    const confirmed = (await batchesOf(t.alpha)).flatMap((batch) => batch.expired_run_ids);
    expect(confirmed, 'a run whose trace took a fresh event is not confirmed').not.toContain(runId);
    // Once the fresh event is past the window too, the run is due again.
    await age(runId, TRACE_WINDOW_DAYS + 1);
    await retainDeployment(t.alpha.db.app, alphaOnly, TRACE_KEY, t.target.expiry);
    expect(t.target.stored.has(traceId), 'the run is deleted again').toBe(false);
    const later = (await batchesOf(t.alpha)).flatMap((batch) => batch.expired_run_ids);
    expect(later).toContain(runId);
  },
);
