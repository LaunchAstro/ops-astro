// SPDX-License-Identifier: AGPL-3.0-only
//
// `automation.history` through the real route: one activation's occurrences
// and the changes people made to it, newest first by time and then id, 50 a
// page, each page's cursor reaching the next. An occurrence carries its cause
// (a due time, or only that an event caused it), its outcome code, what its
// dispatch found and the run it started; a change carries its command and its
// actor's id, kind and name. A refused attempt and another activation's
// change are not in it, and an event's id is never sent.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createRegistryWorld, type RegistryWorld } from './registry-world.ts';
import {
  applied,
  askHistory,
  fireAt,
  historyPage,
  nameOf,
  revisionOf,
  scheduledOnFirst,
  wholeHistory,
  type Entry,
} from './history-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const DUE = new Date(Date.UTC(2026, 10, 3, 9));

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('an activation history', () => {
  let w: RegistryWorld;
  let activationId: string;
  let firedId: string;
  const marker = `event-marker-${randomUUID()}`;

  beforeAll(async () => {
    w = await createRegistryWorld('ahist');
    const made = await scheduledOnFirst(w);
    activationId = made.activationId;
    await applied(w, 'activation.adopt', {
      activationId,
      versionId: made.first,
      expectedRevision: 1,
    });
    firedId = await fireAt(w, activationId, DUE);
    await applied(w, 'activation.adopt', {
      activationId,
      versionId: made.second,
      expectedRevision: 2,
    });
    const back = await applied(w, 'activation.roll_back', { activationId, expectedRevision: 3 });
    await applied(w, 'approval.revoke', { approvalId: back['approvalId'] });
    // A refused attempt did not happen to the activation.
    const stale = await w.as(w.admin, 'activation.turn_off', { activationId, expectedRevision: 1 });
    expect(stale.status).toBe(409);
    await applied(w, 'activation.turn_off', {
      activationId,
      expectedRevision: await revisionOf(w, activationId),
    });
    // Another activation's change is its own history.
    await scheduledOnFirst(w);
    // Sixty older occurrences, two to a time so a page can end inside a tie:
    // due times refused for want of an approval, and events while it was off.
    await w.controls.fixture.db.admin.execute(
      `insert into public.activation_occurrences
         (business_id, id, activation_id, version_id, due_at, event_id, outcome, recorded_at)
       select $1, gen_random_uuid(), $2, $3,
              case when g % 3 = 0 then null else timestamptz '2026-01-01' + g * interval '1 hour' end,
              case when g % 3 = 0 then $4 || '-' || g else null end,
              case when g % 3 = 0 then 'activation_off' else 'no_standing_approval' end,
              now() - interval '1 day' - (g / 2) * interval '1 minute'
         from generate_series(1, 60) g`,
      [w.alpha, activationId, made.first, marker],
    );
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  /** The ids, newest first, as the database orders them: by time, then id. */
  const expectedOrder = async (): Promise<string[]> => {
    const rows = await w.controls.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from (
         select o.id, o.recorded_at as at from public.activation_occurrences o
          where o.activation_id = $1
         union all
         select e.id, e.occurred_at from public.audit_events e
          where e.outcome = 'applied'
            and ((e.command in ('activation.change', 'activation.adopt', 'activation.roll_back',
                                'activation.turn_off') and e.subject_record_id = $1)
              or (e.command = 'approval.revoke' and e.subject_record_id in
                    (select id from public.standing_approvals where activation_id = $1)))
       ) entries order by at desc, id desc`,
      [activationId],
    );
    return rows.map((row) => row.id);
  };

  it('reads 50 a page newest first, and each cursor reaches the next page until none is left', async () => {
    const pages = await wholeHistory(w, w.admin, activationId);
    expect(pages.map((page) => page.entries.length)).toStrictEqual([50, 17]);
    expect(typeof pages[0]?.next).toBe('string');
    expect(pages[1]?.next).toBeNull();
    const ids = pages.flatMap((page) => page.entries.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toStrictEqual(await expectedOrder());
    const times = pages.flatMap((page) => page.entries.map((entry) => entry.at));
    expect(times).toStrictEqual(times.toSorted().toReversed());
  });

  it('names each change by its command and its actor, newest first, refused attempts and other activations left out', async () => {
    const [first] = await wholeHistory(w, w.admin, activationId);
    const changes = (first?.entries ?? []).filter((entry) => entry.kind === 'change');
    expect(changes.map((entry) => entry['command'])).toStrictEqual([
      'activation.turn_off',
      'approval.revoke',
      'activation.roll_back',
      'activation.adopt',
      'activation.adopt',
      'activation.change',
    ]);
    const name = await nameOf(w, w.admin);
    const audit = await w.controls.fixture.db.admin.execute<{
      readonly id: string;
      readonly at: Date;
    }>(
      `select id, occurred_at as at from public.audit_events
        where command = 'activation.turn_off' and outcome = 'applied' and subject_record_id = $1`,
      [activationId],
    );
    expect(changes[0]).toStrictEqual({
      kind: 'change',
      id: audit[0]?.id,
      at: new Date(audit[0]?.at ?? 0).toISOString(),
      command: 'activation.turn_off',
      actorId: w.admin.actorId,
      actorKind: 'person',
      actorName: name,
    });
    for (const change of changes) {
      expect([change['actorId'], change['actorKind'], change['actorName']]).toStrictEqual([
        w.admin.actorId,
        'person',
        name,
      ]);
    }
  });

  it('sends an occurrence with its cause, outcome code, dispatch and run, and never an event id', async () => {
    const pages = await wholeHistory(w, w.admin, activationId);
    const all: Entry[] = pages.flatMap((page) => [...page.entries]);
    const [row] = await w.controls.fixture.db.admin.execute<{
      readonly at: Date;
      readonly run: string;
    }>(
      `select o.recorded_at as at, d.run_id as run from public.activation_occurrences o
         join public.occurrence_dispatches d on d.occurrence_id = o.id where o.id = $1`,
      [firedId],
    );
    expect(all.find((entry) => entry.id === firedId)).toStrictEqual({
      kind: 'occurrence',
      id: firedId,
      at: new Date(row?.at ?? 0).toISOString(),
      cause: { kind: 'scheduled', dueAt: DUE.toISOString() },
      outcome: 'approved',
      dispatch: 'started',
      runId: row?.run,
    });
    const older = all.filter((entry) => entry.kind === 'occurrence' && entry.id !== firedId);
    expect(older).toHaveLength(60);
    const events = older.filter((entry) => entry['outcome'] === 'activation_off');
    expect(events).toHaveLength(20);
    for (const event of events) {
      expect([event['cause'], event['dispatch'], event['runId']]).toStrictEqual([
        { kind: 'event' },
        null,
        null,
      ]);
    }
    const refused = older.filter((entry) => entry['outcome'] === 'no_standing_approval');
    expect(refused).toHaveLength(40);
    for (const one of refused) expect(one['cause']).toMatchObject({ kind: 'scheduled' });
    expect(JSON.stringify(pages)).not.toContain(marker);
  });

  it('refuses a cursor no page gave, naming the cursor', async () => {
    for (const cursor of ['not-a-cursor', '', 'MjAyNi0wMS0wMXxub3QtYW4taWQ']) {
      // eslint-disable-next-line no-await-in-loop -- one cursor at a time
      const answer = await askHistory(w, w.admin, activationId, cursor);
      expect([answer.status, answer.body['code'], answer.body['names']], cursor).toStrictEqual([
        422,
        'FIELD_VALUE_INVALID',
        ['cursor'],
      ]);
    }
    const first = await historyPage(w, w.admin, activationId);
    expect(first.entries).toHaveLength(50);
  });
});
