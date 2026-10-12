// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow, waiterOf } from '../support/lock-wait-race.ts';
import { codeOf, must, wayfinderWorld } from './world.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a session ended while a frontier write waits keeps no task write',
  // eslint-disable-next-line max-lines-per-function -- one race, set up and observed in one case
  async () => {
    const w = await wayfinderWorld('frontierrace', 'frontierrace');
    try {
      const owner = await w.decider('owner');
      const member = await w.member('writer', ['read', 'write']);
      const sessionId = randomUUID();
      const writer = { ...member, presented: { ...member.presented, sessionId } };
      const chart = await w.as(owner, {
        command: 'map.chart',
        title: 'Sol commit race',
        tickets: [
          { ref: 'a', title: 'research', type: 'research' },
          { ref: 'g', title: 'decision', type: 'grilling', blockedBy: ['a'] },
        ],
      });
      must(chart, 'map.chart');
      const { a, g } = (chart as unknown as { detail: { tickets: Record<string, string> } }).detail
        .tickets;
      const revision = await w.revisionOf(a!);
      const held = await holdRow(
        w.db,
        'select id from public.people where business_id = $1 and id = $2 for update',
        [w.business, owner.personId],
      );
      const completing = w.asOnSecond(writer, {
        command: 'task.complete',
        recordId: a,
        expectedRevision: revision,
      });
      // Attach a rejection handler immediately, while the backend waits.
      const outcome = completing.then(
        (answer) => ({ answer }),
        (error: unknown) => ({ error }),
      );
      let endedBeforeRelease = false;
      let ending: Promise<void> | undefined;
      try {
        await waiterOf(w.db, held);
        const [wait] = await w.db.admin.execute<{ query: string; pid: number }>(
          `select query, pid from pg_stat_activity where datname = current_database()
           and $1::int = any(pg_blocking_pids(pid))`,
          [held.pid],
        );
        expect(wait?.query.toLowerCase()).toBe('commit');
        // This is the no-membership sign-out path's production function. It
        // holds the session's ending key, and writes no business audit event.
        ending = w.db.app.withBusiness(w.business, async (tx) => {
          await endProviderSession(tx, sessionId);
        });
        // Both valid implementations are accepted: refuse if ending commits
        // first, or hold the ending until the already admitted write commits.
        let established = false;
        for (let attempt = 0; attempt < 500; attempt += 1) {
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          const [order] = await w.db.admin.execute<{ ended: boolean; waits: boolean }>(
            `select exists (select 1 from ops.ended_provider_sessions where session_id = $1) as ended,
             exists (select 1 from pg_stat_activity where datname = current_database()
              and $2::int = any(pg_blocking_pids(pid))
              and query ilike '%pg_advisory_xact_lock%') as waits`,
            [sessionId, wait!.pid],
          );
          if (order?.ended || order?.waits) {
            endedBeforeRelease = order.ended;
            established = true;
            break;
          }
          // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
          await delay(10);
        }
        expect(established).toBe(true);
      } finally {
        await held.letGo();
        await ending;
      }
      const result = await outcome;
      if ('error' in result) throw result.error;
      if (!endedBeforeRelease) return;
      expect.soft(codeOf(result.answer)).toBe('AUTH_SESSION_EXPIRED');
      expect.soft(await w.revisionOf(a!)).toBe(revision);
      const items = await w.db.admin.execute(
        "select id from public.inbox_items where subject_record_id = $1 and reason = 'decision'",
        [g],
      );
      expect.soft(items).toHaveLength(0);
    } finally {
      await w.drop();
    }
  },
  30_000,
);
