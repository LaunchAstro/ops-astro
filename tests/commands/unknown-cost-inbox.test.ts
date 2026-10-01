// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { OVER, t2dHarness } from '../runtime/t2d-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('attention for an unknown cost', () => {
  let s: Schedules;
  const h = t2dHarness(() => s);
  beforeAll(async () => {
    s = await openSchedules('unknowncost', 1_000_000);
  });
  afterAll(async () => {
    await s?.db.drop();
  });

  it('puts the over-hold alert in the launchers inbox when only a person can resolve it', async () => {
    const work = await h.work();
    await h.applied(work);
    expect(codeOf(await h.observeOf(work, { usage: OVER }))).toBe('BUDGET_UNAVAILABLE');
    expect(await h.money(work)).toMatchObject({
      attempt_state: 'liability_unknown',
      envelope_held: '2500',
    });
    const task = await executeRead(s.db.app, s.business, s.decider.presented, {
      read: 'task.read',
      recordId: work.taskId,
    });
    if (!('task' in task)) throw new Error('the launcher must read their task');
    expect(task.task.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'awaiting_person', waitingReason: 'liability_unknown' }),
      ]),
    );
    const inbox = await executeRead(s.db.app, s.business, s.decider.presented, {
      read: 'inbox.read',
    });
    if (!('inbox' in inbox)) throw new Error('the launcher must read their inbox');
    expect(inbox.inbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectRecordId: work.taskId,
          workState: 'open',
          counted: true,
          alert: expect.objectContaining({
            kind: 'awaiting_person',
            waitingReason: 'liability_unknown',
          }),
        }),
      ]),
    );
  });
});
