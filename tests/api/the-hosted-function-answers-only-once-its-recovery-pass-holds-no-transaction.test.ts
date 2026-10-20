// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { Client, dropLogins, loginIn } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { openSchedules } from '../runtime/schedules-harness.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

type Schedules = Awaited<ReturnType<typeof openSchedules>>;

const request = (path: string): Request =>
  new Request(`https://ops.example.test${path}`, { headers: { host: 'ops.example.test' } });

function functionOver(s: Schedules, lookupUrl: string): ReturnType<typeof createFunctionHandler> {
  const keyId = 'test/idle-pass@1';
  return createFunctionHandler({
    DATABASE_URL: s.db.appUrl,
    DATABASE_LOOKUP_URL: lookupUrl,
    GOTRUE_URL: TEST_ISSUER,
    SERVED_HOST: 'ops.example.test',
    DELEGATION_CREDENTIAL_KEY_ID: keyId,
    DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
    RECOVERY_BUSINESS_KEYS: 'schedules-idlepass',
  });
}

/** Whether a runtime-login session is waiting on a lock on `leases`. */
async function passWaitsOnLeases(s: Schedules): Promise<boolean | undefined> {
  const [row] = await s.db.admin.execute<{ waiting: boolean }>(
    `select exists (select 1 from pg_stat_activity
      where datname = current_database() and usename = $1
        and wait_event_type = 'Lock' and query ilike '%leases%') as waiting`,
    [s.db.loginRole],
  );
  return row?.waiting;
}

/** The runtime login's sessions inside a transaction, active, waiting or idle. */
async function openOnRuntime(s: Schedules): Promise<number> {
  const [row] = await s.db.admin.execute<{ open: number }>(
    `select count(*)::int as open from pg_stat_activity
      where datname = current_database() and usename = $1 and xact_start is not null`,
    [s.db.loginRole],
  );
  return row?.open ?? -1;
}

// A hosted instance may be frozen the moment it answers. A pass whose
// transaction is still open then keeps its session `idle in transaction`,
// holding its row locks, and every pass that takes those locks after it
// freezes the same way (#2240's staging evidence: the budget_caps queue on
// alpha). So the answer comes back only once the pass holds no transaction.
describe.skipIf(databaseUrlFromEnvironment() === undefined)('the hosted recovery pass', () => {
  it('the function answers only once its recovery pass stalled on a lock holds no transaction', async () => {
    const s = await openSchedules('idlepass', 100_000);
    const url = new URL(databaseUrlFromEnvironment() ?? '');
    url.pathname = `/${s.db.name}`;
    const holder = new Client(url.toString());
    const lookup = await loginIn(s.db, 'ops_astro_lookup', 'idlepass');
    let handle: ReturnType<typeof createFunctionHandler> | undefined;
    let response: Promise<Response> | undefined;
    try {
      handle = functionOver(s, lookup.url);
      await holder.query('begin');
      await holder.query('lock table public.leases in access exclusive mode');
      response = handle(request('/api/health'));
      await expect.poll(async () => await passWaitsOnLeases(s)).toBe(true);
      // The holder keeps its lock past the answer, as a frozen instance's
      // session keeps its own: nothing but the pass's own bound ends the wait.
      await response;
      const open = await openOnRuntime(s);
      expect(open, 'the function answered while its recovery pass held a transaction open').toBe(0);
    } finally {
      await holder.query('rollback');
      await response;
      await handle?.(request('/api/sign-in'));
      await holder.end();
      await dropLogins(s.db, [lookup.name]);
    }
  }, 30_000);
});
