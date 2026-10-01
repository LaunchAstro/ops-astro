// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-9 (REVIEW-BATCH #305, batch 2c1): a timer outlives the reader's
// grant and can then never be ended. time.stop asks task:read on the task
// before it stops anything (tasks-time.ts, stopTime calling refuseUnreadable),
// so once a person's read of the task is revoked their own running timer on it
// answers NOT_FOUND. time.delete refuses a running entry (core-records
// time.ts, deleteTimeEntry), and time.start anywhere else is refused because
// the one-running-timer index still holds the stranded entry. The person is
// left unable to time anything. Once stop reaches the person's own running
// timer whatever they may now read (or a start stops a stranded one), the
// timer is ended and the person can time another task.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { grantTo, type Member } from './fixture.ts';
import { outcomeOf, timeWorld, type TimeWorld } from './time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('review-2c1-9: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('rb2c1n9');
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const run = async (member: Member, body: Record<string, unknown>) =>
  outcomeOf(await w.as(w.alpha, member, body));

const applied = (outcome: object) => 'applied' in outcome;

describe.skipIf(serverUrl === undefined)('REVIEW-2C1-9: a timer outliving its read grant', () => {
  it('REVIEW-2C1-9: after task:read on T is revoked, the person can still end their running timer on T (time.stop on T, or time.start on another task, applies)', async () => {
    const stranded = await w.fresh(w.alpha, w.ada, 'stranded');
    const elsewhere = await w.fresh(w.alpha, w.ada, 'elsewhere');
    const readGrant = await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'read', { kind: 'record', id: elsewhere });
      return await grantTo(tx, w.clientA, 'read', { kind: 'record', id: stranded });
    });

    // Setup, not the defect: the timer starts while the read is held.
    expect(await run(w.clientA, { command: 'time.start', taskId: stranded })).toStrictEqual({
      applied: true,
    });
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      expect(await revokeGrant(tx, readGrant)).not.toBeNull();
    });

    const outcomes = {
      stopOnT: await run(w.clientA, { command: 'time.stop', taskId: stranded }),
      startElsewhere: await run(w.clientA, { command: 'time.start', taskId: elsewhere }),
    };
    expect(
      applied(outcomes.stopOnT) || applied(outcomes.startElsewhere),
      `the stranded timer can be neither stopped nor replaced: ${JSON.stringify(outcomes)}`,
    ).toBe(true);

    const running = await w.db.admin.execute<{ readonly task_id: string }>(
      `select task_id from public.time_entries
        where person_id = $1 and ended_at is null and deleted_at is null`,
      [w.clientA.personId],
    );
    expect(running.map((row) => row.task_id)).not.toContain(stranded);
  });
});
