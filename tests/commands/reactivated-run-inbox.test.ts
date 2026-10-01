// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asAgent,
  handbackBody,
  liveWork,
  openSchedules,
} from '../runtime/schedules-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'attention for a reactivated run',
  () => {
    it('does not count automatically reactivated work as waiting for the launchers move', async () => {
      const s = await openSchedules('dropinbox', 100_000);
      try {
        const work = await liveWork(s, 'The provider was unavailable before dispatch', 1000);
        appliedDetail(
          await asAgent(
            s,
            {
              ...handbackBody(work.picked),
              outcome: 'dropped',
              report: { dropCause: 'provider_unavailable' },
            },
            String(work.picked['credential']),
          ),
          'task.handback',
        );
        const queue = await executeRead(s.db.app, s.business, s.decider.presented, {
          read: 'task.queue',
        });
        if (!('queue' in queue)) throw new Error('the launcher must read the queue');
        expect(queue.queue).toEqual(
          expect.arrayContaining([expect.objectContaining({ taskId: work.taskId })]),
        );
        const inbox = await executeRead(s.db.app, s.business, s.decider.presented, {
          read: 'inbox.read',
        });
        if (!('inbox' in inbox)) throw new Error('the launcher must read their inbox');
        expect(
          inbox.inbox.filter(
            (item) =>
              item.subjectRecordId === work.taskId && item.counted && item.reason === 'waiting_run',
          ),
        ).toEqual([]);
      } finally {
        await s.db.drop();
      }
    });
  },
);
