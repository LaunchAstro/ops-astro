// SPDX-License-Identifier: AGPL-3.0-only
//
// The C52-A owner check, with the scheduler as it is: an adopted hourly
// activation fires through the occurrence sweep (`sweepOccurrences`), a person
// turns it off through the route (`activation.turn_off`), and after its next
// due time a sweep adds no occurrence and starts no run. Its history shows the
// turn-off, with the person who did it and when, above the occurrence that ran.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepOccurrences } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { insertWorker } from './run-start.ts';
import { createRegistryWorld, type RegistryWorld } from './registry-world.ts';
import { applied, historyPage, nameOf, scheduledOnFirst } from './history-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const hour = (h: number): Date => new Date(Date.UTC(2026, 10, 5, h));

describe.skipIf(serverUrl === undefined)('a turned-off scheduled activation', () => {
  let w: RegistryWorld;
  let worker: string;

  beforeAll(async () => {
    w = await createRegistryWorld('ahoff');
    worker = await insertWorker(w.controls.fixture.db, w.alpha);
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  const sweep = async (now: Date) =>
    await sweepOccurrences(w.controls.fixture.db.app, {
      businessId: w.alpha,
      workerActorId: worker,
      now,
    });

  const footprint = async (activationId: string): Promise<readonly number[]> => [
    await w.controls.count(
      'select count(*) as n from public.activation_occurrences where activation_id = $1',
      [activationId],
    ),
    await w.controls.count(
      `select count(*) as n from public.planned_runs r
         join public.activation_occurrences o on o.id = r.origin_occurrence_id
        where o.activation_id = $1`,
      [activationId],
    ),
  ];

  it('fires nothing after its next due time once turned off, and its history shows the turn-off with its actor and time', async () => {
    const { activationId, first } = await scheduledOnFirst(w);
    await applied(w, 'activation.adopt', { activationId, versionId: first, expectedRevision: 1 });
    // On and adopted, the sweep fires it: one occurrence, one run.
    const fired = await sweep(new Date(hour(9).getTime() + 5 * 60_000));
    expect([fired.claimed.length, fired.started.length, fired.failed]).toStrictEqual([1, 1, []]);
    expect(await footprint(activationId)).toStrictEqual([1, 1]);

    await applied(w, 'activation.turn_off', { activationId, expectedRevision: 2 });
    const later = await sweep(new Date(hour(10).getTime() + 5 * 60_000));
    expect(later).toStrictEqual({ claimed: [], started: [], failed: [] });
    expect(await footprint(activationId)).toStrictEqual([1, 1]);

    const [turnOff] = await w.controls.fixture.db.admin.execute<{
      readonly id: string;
      readonly at: Date;
    }>(
      `select id, occurred_at as at from public.audit_events
        where command = 'activation.turn_off' and outcome = 'applied' and subject_record_id = $1`,
      [activationId],
    );
    const { entries } = await historyPage(w, w.admin, activationId);
    expect(
      entries.map((entry) => [entry.kind, entry['command'] ?? entry['outcome']]),
    ).toStrictEqual([
      ['change', 'activation.turn_off'],
      ['occurrence', 'approved'],
      ['change', 'activation.adopt'],
      ['change', 'activation.change'],
    ]);
    expect(entries[0]).toStrictEqual({
      kind: 'change',
      id: turnOff?.id,
      at: new Date(String(turnOff?.at)).toISOString(),
      command: 'activation.turn_off',
      actorId: w.admin.actorId,
      actorKind: 'person',
      actorName: await nameOf(w, w.admin),
    });
    expect(entries[1]).toMatchObject({
      cause: { kind: 'scheduled', dueAt: hour(9).toISOString() },
      dispatch: 'started',
      runId: fired.started[0],
    });
  });
});
