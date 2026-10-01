// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the local tick fires a scheduled job on the owner's laptop. One
// pass writes the due occurrence of each enabled schedule through C33's claim,
// dispatches it through C52-A with the product's run starter, and so starts
// the run and its task (AW-01 J). A second pass in the same slot replays and
// starts nothing more. Outside OPS_ENVIRONMENT=local it refuses and writes
// nothing, and a tick for one business never touches another's schedule.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createAutomationWorld, type AutomationWorld } from '../automations/world.ts';
import { bravoApproved, firingOf } from '../automations/firing.ts';
import { fireSchedules, slotOf, type ScheduleTick } from '../../apps/local-agent/tick.ts';

const serverUrl = databaseUrlFromEnvironment();
const LOCAL = { OPS_ENVIRONMENT: 'local' } as const;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('LA-1 local tick: a scheduled job', () => {
  let w: AutomationWorld;
  // A fixed instant, an hour slot of its own for each case.
  let hour = 0;
  const nextHour = (): Date => new Date(Date.UTC(2026, 9, 1, (hour += 1), 7));

  const optionsAt = (now: Date, environment: Record<string, string | undefined> = LOCAL) =>
    ({
      environment,
      database: w.db.app,
      businessId: w.alpha,
      workerActorId: w.worker,
      now: () => now,
    }) satisfies ScheduleTick;

  const firedRuns = async (): Promise<number> =>
    await w.count(
      'select count(*) as n from public.planned_runs where origin_occurrence_id is not null',
    );

  beforeAll(async () => {
    w = await createAutomationWorld('la1tick');
  }, 180_000);

  afterAll(async () => {
    await w?.db.drop();
  });

  it('a scheduled job fires locally: a due schedule with a standing approval starts one run', async () => {
    const approved = await firingOf(w).approved('scheduled');
    const runsBefore = await firedRuns();
    const now = nextHour();

    const fired = await fireSchedules(optionsAt(now));

    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    const mine = fired.fired.filter((f) => f.activationId === approved.activation.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.dueAt.toISOString()).toBe(slotOf(now, 60).toISOString());
    expect(mine[0]?.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mine[0]?.taskId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await w.occurrences(approved.activation.id)).toBe(1);
    expect(await firedRuns()).toBe(runsBefore + 1);
  });

  it('a second tick in the same slot writes no second occurrence and starts no second run', async () => {
    const approved = await firingOf(w).approved('scheduled');
    const now = nextHour();
    const first = await fireSchedules(optionsAt(now));
    const runsAfterFirst = await firedRuns();

    const again = await fireSchedules(optionsAt(new Date(now.getTime() + 60_000)));

    expect(first.ok && again.ok).toBe(true);
    if (!again.ok) return;
    expect(await w.occurrences(approved.activation.id)).toBe(1);
    expect(await firedRuns()).toBe(runsAfterFirst);
    const mine = again.fired.filter((f) => f.activationId === approved.activation.id);
    expect(mine.map((f) => f.replayed)).toEqual([true]);
  });

  it('a schedule that is switched off or has no standing approval starts nothing', async () => {
    const version = await w.release(['scheduled']);
    const off = await w.activate(version, 'scheduled', false);
    const unapproved = await w.activate(version, 'scheduled', true);

    const fired = await fireSchedules(optionsAt(nextHour()));

    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    const started = fired.fired.filter(
      (f) => [off.id, unapproved.id].includes(f.activationId) && f.runId !== null,
    );
    expect(started).toEqual([]);
    expect(await w.occurrences(off.id)).toBe(0);
  });

  it.each([
    ['staging', { OPS_ENVIRONMENT: 'staging' }],
    ['production', { OPS_ENVIRONMENT: 'production' }],
    ['hosted', { OPS_ENVIRONMENT: 'hosted' }],
    ['unset', {}],
    ['Local in another case', { OPS_ENVIRONMENT: 'Local' }],
  ])('a tick refuses outside OPS_ENVIRONMENT=local (%s) and writes nothing', async (_, env) => {
    const approved = await firingOf(w).approved('scheduled');
    const runsBefore = await firedRuns();

    const fired = await fireSchedules(optionsAt(nextHour(), env));

    expect(fired).toEqual({ ok: false, code: 'LOCAL_ONLY', message: expect.any(String) });
    expect(await w.occurrences(approved.activation.id)).toBe(0);
    expect(await firedRuns()).toBe(runsBefore);
  });

  it("a tick for one business never touches another business's due schedule", async () => {
    const bravoActivation = await bravoApproved(w, 'scheduled');

    const fired = await fireSchedules(optionsAt(nextHour()));

    expect(fired.ok).toBe(true);
    if (!fired.ok) return;
    expect(fired.fired.map((f) => f.activationId)).not.toContain(bravoActivation);
    expect(await w.occurrences(bravoActivation)).toBe(0);
  });
});
