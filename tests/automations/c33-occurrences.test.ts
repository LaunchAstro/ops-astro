// SPDX-License-Identifier: AGPL-3.0-only
//
// C33: occurrences, claimed once per due time or event, against a real database (U36, #483). Each case is named after
// the supporting checklist line it proves. The commands, the read and the
// screen are the next increment; what is held on AW-01 and AW-02 is in
// `c33-held.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeActivation,
  claimOccurrence,
  readActivation,
  readVersion,
  releaseVersion,
  type ActivationRow,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createAutomationWorld, DIGEST, type AutomationWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();
const ROUNDS = 25;

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C33 occurrences', () => {
  let w: AutomationWorld;

  beforeAll(async () => {
    w = await createAutomationWorld('c33o');
  });

  afterAll(async () => {
    await w?.db.drop();
  });

  it('C33 occurrence once: a due time and an event each write one occurrence, however often they come', async () => {
    const version = await w.release(['scheduled', 'event']);
    const scheduled = await w.activate(version, 'scheduled');
    const dueAt = new Date('2026-10-01T00:00:00Z');
    const first = await w.claim(scheduled.id, { dueAt });
    expect(first.kind).toBe('claimed');
    // A restarted scheduler asks again for the same due time.
    const again = await w.claim(scheduled.id, { dueAt });
    expect(again.kind).toBe('replayed');
    expect(again.kind === 'replayed' && first.kind === 'claimed' && again.occurrence.id).toBe(
      first.kind === 'claimed' && first.occurrence.id,
    );
    expect(await w.occurrences(scheduled.id)).toBe(1);
    const nextHour = await w.claim(scheduled.id, { dueAt: new Date('2026-10-01T01:00:00Z') });
    expect(nextHour.kind).toBe('claimed');
    expect(await w.occurrences(scheduled.id)).toBe(2);

    const evented = await w.activate(version, 'event');
    const eventId = `evt-${randomUUID()}`;
    expect((await w.claim(evented.id, { eventId })).kind).toBe('claimed');
    expect((await w.claim(evented.id, { eventId })).kind).toBe('replayed');
    expect(await w.occurrences(evented.id)).toBe(1);
    // A cause of the wrong kind for the mode is not an occurrence at all.
    expect(await w.claim(evented.id, { dueAt })).toEqual({ kind: 'not_firing', mode: 'event' });
    expect(await w.occurrences(evented.id)).toBe(1);
  });

  it('C33 occurrence refused without approval: with no standing approval on the version, no run starts and the reason is recorded', async () => {
    const version = await w.release(['scheduled']);
    const on = await w.activate(version, 'scheduled', true);
    const off = await w.activate(version, 'scheduled', false);
    const dueAt = new Date('2026-10-02T00:00:00Z');
    const fired = await w.claim(on.id, { dueAt });
    expect(fired).toMatchObject({
      kind: 'claimed',
      occurrence: { outcome: 'no_standing_approval', runId: null, versionId: version.id },
    });
    const held = await w.claim(off.id, { dueAt });
    expect(held).toMatchObject({
      kind: 'claimed',
      occurrence: { outcome: 'activation_off', runId: null },
    });
    // A started occurrence must name its run; nothing here can claim one.
    await expect(
      w.db.admin.execute(
        `insert into public.activation_occurrences
           (business_id, id, activation_id, version_id, due_at, outcome)
         values ($1, $2, $3, $4, now(), 'started')`,
        [w.alpha, randomUUID(), on.id, version.id],
      ),
    ).rejects.toThrow(/activation_occurrences_started_names_run/u);
  });

  it('C33 no run without approval: switching to scheduled or event mode writes no occurrence and no run', async () => {
    const version = await w.release(['manual', 'scheduled', 'event']);
    const manual = await w.activate(version, 'manual', false);
    const runs = await w.count('select count(*) as n from public.planned_runs');
    const toScheduled = await w.inAlpha<ActivationRow | null>((tx) =>
      changeActivation(tx, manual.id, manual.revision, {
        versionId: version.id,
        mode: 'scheduled',
        everyMinutes: 1,
        eventKind: null,
        enabled: true,
        actorId: w.admin.actorId,
      }),
    );
    expect(toScheduled).toMatchObject({ mode: 'scheduled', enabled: true });
    const toEvent = await w.inAlpha<ActivationRow | null>((tx) =>
      changeActivation(tx, manual.id, manual.revision + 1, {
        versionId: version.id,
        mode: 'event',
        everyMinutes: null,
        eventKind: 'invoice.paid',
        enabled: true,
        actorId: w.admin.actorId,
      }),
    );
    expect(toEvent).toMatchObject({ mode: 'event', revision: manual.revision + 2 });
    expect(await w.occurrences(manual.id)).toBe(0);
    expect(await w.count('select count(*) as n from public.planned_runs')).toBe(runs);
    // A stale change moves nothing.
    const stale = await w.inAlpha((tx) =>
      changeActivation(tx, manual.id, manual.revision, {
        versionId: version.id,
        mode: 'manual',
        everyMinutes: null,
        eventKind: null,
        enabled: false,
        actorId: w.admin.actorId,
      }),
    );
    expect(stale).toBeNull();
  });

  // eslint-disable-next-line max-lines-per-function -- the race, then the database's own refusals
  it('C33 concurrent claim: racing schedulers and racing deliveries commit one occurrence, held by the database', async () => {
    const version = await w.release(['scheduled', 'event']);
    const scheduled = await w.activate(version, 'scheduled');
    const evented = await w.activate(version, 'event');
    for (let round = 0; round < ROUNDS; round += 1) {
      const dueAt = new Date(Date.UTC(2026, 10, 1, 0, round));
      const eventId = `race-${round}-${randomUUID()}`;
      // eslint-disable-next-line no-await-in-loop -- one round at a time; each round is its own race
      const [a, b, c, d] = await Promise.all([
        w.claim(scheduled.id, { dueAt }),
        w.claim(scheduled.id, { dueAt }),
        w.claim(evented.id, { eventId }),
        w.claim(evented.id, { eventId }),
      ]);
      expect([a.kind, b.kind].toSorted()).toEqual(['claimed', 'replayed']);
      expect([c.kind, d.kind].toSorted()).toEqual(['claimed', 'replayed']);
    }
    expect(await w.occurrences(scheduled.id)).toBe(ROUNDS);
    expect(await w.occurrences(evented.id)).toBe(ROUNDS);
    // The uniqueness is the database's: a second row for one cause, or a
    // second occurrence naming one run, is refused whoever writes it.
    const taken = await w.db.admin.execute<{ readonly due_at: Date }>(
      'select due_at from public.activation_occurrences where activation_id = $1 limit 1',
      [scheduled.id],
    );
    await expect(
      w.db.admin.execute(
        `insert into public.activation_occurrences
           (business_id, id, activation_id, version_id, due_at, outcome)
         values ($1, $2, $3, $4, $5, 'no_standing_approval')`,
        [w.alpha, randomUUID(), scheduled.id, version.id, taken[0]?.due_at],
      ),
    ).rejects.toThrow(/activation_occurrences_due_once/u);
    const run = randomUUID();
    const started = `insert into public.activation_occurrences
        (business_id, id, activation_id, version_id, event_id, outcome, run_id)
      values ($1, $2, $3, $4, $5, 'started', $6)`;
    await w.db.admin.execute(started, [
      w.alpha,
      randomUUID(),
      evented.id,
      version.id,
      'one-run-a',
      run,
    ]);
    await expect(
      w.db.admin.execute(started, [
        w.alpha,
        randomUUID(),
        evented.id,
        version.id,
        'one-run-b',
        run,
      ]),
    ).rejects.toThrow(/activation_occurrences_run_once/u);
  });

  it('C33 isolation, records: another business sees, counts and claims none of these rows', async () => {
    const version = await w.release(['scheduled']);
    const scheduled = await w.activate(version, 'scheduled');
    const answers = await w.db.app.withBusiness(w.bravo, async (tx) => ({
      definitions: await tx.query('select id, name from public.automation_definitions'),
      versions: await tx.query('select id from public.definition_versions'),
      activations: await tx.query('select id from public.activations'),
      occurrences: await tx.query('select id from public.activation_occurrences'),
      version: await readVersion(tx, version.id),
      activation: await readActivation(tx, scheduled.id),
      claim: await claimOccurrence(tx, scheduled.id, { dueAt: new Date('2026-10-03T00:00:00Z') }),
      release: await releaseVersion(tx, {
        definitionId: w.definition,
        contentDigest: DIGEST,
        contentSize: 1,
        inputs: [],
        operations: [],
        modes: ['manual'],
        actorId: w.bravoAdmin.actorId,
      }),
    }));
    expect(answers).toEqual({
      definitions: [],
      versions: [],
      activations: [],
      occurrences: [],
      version: null,
      activation: null,
      claim: { kind: 'unknown' },
      release: null,
    });
    expect(JSON.stringify(answers)).not.toContain(w.canary);
    expect(await w.occurrences(scheduled.id)).toBe(0);
  });
});
