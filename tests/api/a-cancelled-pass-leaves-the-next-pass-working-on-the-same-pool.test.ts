// SPDX-License-Identifier: AGPL-3.0-only
//
// #2240 (Sol's design check on #2243): at the pass deadline the statement in
// flight is cancelled through the driver's own cancel request, never by
// ending the session, which crashes the process through postgres.js. The
// cancelled pass rolls back on its own connection and leaves it in the pool,
// and the next request's pass does the recovery work on that same session.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Schedules } from '../runtime/schedules-harness.ts';
import { boundWorld, request, withinBound } from './recovery-pass-bound-world.ts';

/** What the process raised with nothing to catch it while `work` ran. */
async function uncaughtDuring(work: () => Promise<void>): Promise<readonly unknown[]> {
  const raised: unknown[] = [];
  const keep = (cause: unknown): void => {
    raised.push(cause);
  };
  process.on('uncaughtException', keep);
  process.on('unhandledRejection', keep);
  try {
    await work();
  } finally {
    process.off('uncaughtException', keep);
    process.off('unhandledRejection', keep);
  }
  return raised;
}

/** The runtime login's sessions, by process id. */
async function sessionsOf(s: Schedules): Promise<readonly number[]> {
  const rows = await s.db.admin.execute<{ pid: number }>(
    'select pid from pg_stat_activity where datname = current_database() and usename = $1 order by pid',
    [s.db.loginRole],
  );
  return rows.map((row) => row.pid);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('a cancelled recovery pass', () => {
  it('a cancelled pass leaves the next pass working on the same pool', async () => {
    const world = await boundWorld('cancelledpass');
    const { s } = world;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const raised = await uncaughtDuring(async () => {
        const holder = world.holder();
        await holder.query('begin');
        await holder.query(
          'select 1 from public.budget_caps where business_id = $1 and id = $2 for update',
          [s.business, s.capId],
        );
        const started = performance.now();
        const answer = withinBound(world.handle(request('/api/health')), started);
        await expect.poll(async () => await world.waiting('%budget_caps%')).toBeDefined();
        const pass = await world.waiting('%budget_caps%');
        expect(await answer, 'the stalled pass held the request past the bound').toBe(200);
        // SQLSTATE 57014 from the driver's cancel, not the server's backstop or a lock timeout.
        expect(logged.mock.calls.flat().join('\n')).toMatch(
          /rolled back: canceling statement due to user request/u,
        );
        expect(await world.open(), 'the cancelled pass is still in a transaction').toBe(0);
        const [session] = await s.db.admin.execute<{ state: string }>(
          'select state from pg_stat_activity where pid = $1',
          [pass?.pid],
        );
        expect(session?.state, 'the cancelled session stays connected, idle').toBe('idle');
        const before = await sessionsOf(s);
        expect(before).toContain(pass?.pid);
        await holder.query('rollback');
        expect((await world.handle(request('/api/health'))).status).toBe(200);
        const [lease] = await s.db.admin.execute<{ state: string }>(
          'select state from public.leases where id = $1',
          [world.leaseId],
        );
        expect(lease?.state, 'the next pass recovers the lease').toBe('expired');
        expect(await sessionsOf(s), 'the next pass opened a session of its own').toEqual(before);
      });
      expect(raised, 'the cancel raised something nothing caught').toEqual([]);
    } finally {
      await world.end();
    }
  }, 30_000);
});
