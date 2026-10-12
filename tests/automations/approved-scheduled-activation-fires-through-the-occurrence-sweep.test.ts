// SPDX-License-Identifier: AGPL-3.0-only
//
// An approved scheduled activation fires in production through the occurrence
// sweep (`sweepOccurrences`), the pass the API runs over each business on an
// interval: its latest due time is claimed once and that occurrence's run
// started by the business's worker, a repeat of the pass at the same time
// starts nothing more, and the next due time is the next occurrence. A
// disabled activation fires nothing, and a pass over one business writes
// nothing in another.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepOccurrences } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { bravoApproved, firingOf, type Firing } from './firing.ts';
import { finishRuns, prepareRuns, type Workers } from './run-start.ts';
import { createAutomationWorld, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A time on the hour, so an hourly activation's due time is that hour. */
const hour = (h: number): Date => new Date(Date.UTC(2026, 10, 2, h, 0, 0));

describe.skipIf(serverUrl === undefined)('the occurrence sweep', () => {
  let w: AutomationWorld;
  let f: Firing;
  let k: Workers;

  beforeAll(async () => {
    w = await createAutomationWorld('osweep');
    f = firingOf(w);
    k = await prepareRuns(w);
  });

  beforeEach(async () => {
    await finishRuns(w, w.alpha);
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  const sweep = async (at: Date) =>
    await sweepOccurrences(w.db.app, { businessId: w.alpha, workerActorId: k.worker, now: at });

  /** Each occurrence of the activation: its due time and the run its dispatch started. */
  const firedOf = async (activationId: string) =>
    (
      await w.db.admin.execute<{ due: Date; run: string | null }>(
        `select o.due_at as due, d.run_id as run
           from public.activation_occurrences o
           left join public.occurrence_dispatches d
             on d.business_id = o.business_id and d.occurrence_id = o.id
          where o.activation_id = $1 order by o.due_at`,
        [activationId],
      )
    ).map((row) => ({ due: new Date(row.due).toISOString(), started: row.run !== null }));

  it('claims an approved hourly activation at its latest due time and starts its run, once', async () => {
    const { activation } = await f.approved();
    const report = await sweep(new Date(hour(9).getTime() + 25 * 60_000));
    expect(report.failed).toEqual([]);
    expect(await firedOf(activation.id)).toEqual([{ due: hour(9).toISOString(), started: true }]);
    // The same pass again, a restart or a second API process: the occurrence is
    // replayed and its run is not started twice.
    await sweep(new Date(hour(9).getTime() + 40 * 60_000));
    expect(await firedOf(activation.id)).toEqual([{ due: hour(9).toISOString(), started: true }]);
    await finishRuns(w, w.alpha);
    await sweep(hour(10));
    expect(await firedOf(activation.id)).toEqual([
      { due: hour(9).toISOString(), started: true },
      { due: hour(10).toISOString(), started: true },
    ]);
  });

  it('fires nothing for an activation turned off', async () => {
    const { activation } = await f.approved();
    await f.turnOff(activation.id);
    await sweep(hour(11));
    expect(await firedOf(activation.id)).toEqual([]);
  });

  it('writes nothing in another business', async () => {
    const bravo = await bravoApproved(w, 'scheduled', 'Bravo hourly report');
    await sweep(hour(12));
    expect(await firedOf(bravo.activationId)).toEqual([]);
    expect(
      await w.count('select count(*) as n from public.planned_runs where business_id = $1', [
        w.bravo,
      ]),
    ).toBe(0);
  });
});
