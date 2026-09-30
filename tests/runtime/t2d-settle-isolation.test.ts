// SPDX-License-Identifier: AGPL-3.0-only
//
// T2d data separation, over a real database (split from `t2d-settle.test.ts`,
// on the same harness): a settlement moves no other business's envelope, and
// the money line reaches only a reader holding the task grant.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  createTask,
  openSchedules,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World, PRICED, t2dHarness } from './t2d-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2d-settle-isolation: DATABASE_URL is unset, so nothing below ran.');
}

// Shared by both describes, which run in order on the one database. The hooks
// open nothing when the suite is skipped, as the describes' own skip does.
let s: Schedules;

const { work, applied, observeOf } = t2dHarness(() => s);

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('t2d', 1_000_000);
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

describe.skipIf(serverUrl === undefined)('T2d settlement moves no other envelope', () => {
  it('a populated foreign envelope and a wrong client stay isolated', async () => {
    const bravo = await cq8World(s).party('t2d-bravo');
    const others = async () =>
      await rows(
        s,
        `select business_id, id, held_minor::text, actual_minor::text from public.task_envelopes
          where business_id = $1 order by id`,
        [bravo.id],
      );
    const before = await others();
    expect(before.length).toBeGreaterThan(0);
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    expect(await others()).toStrictEqual(before);
    // Another business's member reads no receipt and no money for it.
    const foreign = await executeRead(s.db.app, bravo.id, bravo.member.presented, {
      read: 'task.receipt',
      attemptId: w.attemptId,
    } as never);
    expect(foreign).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(foreign)).not.toContain('1800');

    const otherTask = await createTask(s, `t2d other client ${randomUUID()}`);
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const ownClient = await cq8World(s).client(s.business, s.decider, 't2d-own', w.taskId);
    const wrongClient = await cq8World(s).client(s.business, s.decider, 't2d-wrong', otherTask);
    const own = await executeRead(s.db.app, s.business, ownClient.presented, {
      read: 'task.read',
      recordId: w.taskId,
    } as never);
    expect(own).toHaveProperty('sharedTask');
    expect(JSON.stringify(own)).not.toContain('1800');
    const crossed = await executeRead(s.db.app, s.business, wrongClient.presented, {
      read: 'task.read',
      recordId: w.taskId,
    } as never);
    expect(crossed).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(crossed)).not.toContain('1800');
  });
});

describe.skipIf(serverUrl === undefined)('T2d settlement money line by grant', () => {
  it('the money line reaches only a reader holding the task grant', async () => {
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    const readAs = async (who: Member) =>
      await executeRead(s.db.app, s.business, who.presented, {
        read: 'task.read',
        recordId: w.taskId,
      } as never);
    const granted = JSON.stringify(await readAs(s.decider));
    expect(granted).toContain('"actualMinor":1800');
    expect(granted).toContain('"releasedMinor":700');

    const idle = await enrol(s.db.app, s.business, 't2d-idle');
    const refused = await readAs(idle);
    expect(refused).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'share');
    });
    const client = await cq8World(s).client(s.business, s.decider, 't2d-own', w.taskId);
    const shared = JSON.stringify(await readAs(client));
    expect(shared).not.toMatch(/actualMinor|releasedMinor|heldMinor/u);
  });
});
