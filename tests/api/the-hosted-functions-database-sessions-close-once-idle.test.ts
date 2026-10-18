// SPDX-License-Identifier: AGPL-3.0-only
//
// #1530: a migrate window drains. db-migrate.mjs and staging-reset.mjs refuse
// while any other session is connected, and a warm function with no traffic
// kept its runtime login's session open for as long as the instance lived.
// Every session the function opens (the runtime pool, the reconciliation
// pass's own, the outbox and the lookup login) closes once it has been idle
// for RUNTIME_IDLE_SECONDS, with nothing terminated.
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import {
  RUNTIME_IDLE_SECONDS,
  type AdminConnection,
} from '../../packages/core-records/src/index.ts';
import { dropLogins, loginIn } from '../db/backup-identity.fixture.ts';
import { openSchedules } from '../runtime/schedules-harness.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

/** The sessions the named logins hold on this database. */
async function connected(admin: AdminConnection, logins: readonly string[]): Promise<number> {
  const [row] = await admin.execute<{ count: string }>(
    `select count(*)::text as count from pg_stat_activity
     where datname = current_database() and usename = any($1::text[])`,
    [logins],
  );
  return Number(row?.count ?? '0');
}

function refusedBearer(): Request {
  return new Request('https://ops.example.test/api/b/made-up/task/board', {
    method: 'POST',
    headers: {
      host: 'ops.example.test',
      authorization: 'Bearer not-a-token',
      'content-type': 'application/json',
    },
    body: '{"board":null}',
  });
}

it('pins the idle time the runtime pools close a connection after', () => {
  expect(RUNTIME_IDLE_SECONDS).toBe(20);
});

it("the function's sessions close once idle, so a migrate window drains without a terminate", async () => {
  const s = await openSchedules('host1530idle', 100_000);
  const lookup = await loginIn(s.db, 'ops_astro_lookup', 'idle1530');
  try {
    const keyId = 'test/host1530-idle@1';
    const handle = createFunctionHandler({
      DATABASE_URL: s.db.appUrl,
      DATABASE_LOOKUP_URL: lookup.url,
      GOTRUE_URL: TEST_ISSUER,
      SERVED_HOST: 'ops.example.test',
      DELEGATION_CREDENTIAL_KEY_ID: keyId,
      DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
      OPS_ENVIRONMENT: 'staging',
      ALERT_SCOPE_KEY: 'cd'.repeat(32),
      RECOVERY_BUSINESS_KEYS: 'schedules-host1530idle',
    });
    const health = await handle(
      new Request('https://ops.example.test/api/health', { headers: { host: 'ops.example.test' } }),
    );
    expect(health.status).toBe(200);
    // A refused bearer raises a signal, which the outbox appends.
    await handle(refusedBearer());
    const sessions = async () => await connected(s.db.admin, [s.db.loginRole, lookup.name]);
    const [events] = await s.db.admin.execute<{ count: string }>(
      'select count(*)::text as count from ops.api_events',
    );
    expect(Number(events?.count), 'the outbox connection was used').toBeGreaterThan(0);
    expect(await sessions(), 'the function holds sessions after serving').toBeGreaterThan(0);
    await expect
      .poll(sessions, { timeout: (RUNTIME_IDLE_SECONDS + 10) * 1_000, interval: 500 })
      .toBe(0);
  } finally {
    await dropLogins(s.db, [lookup.name]);
    await s.db.drop();
  }
}, 60_000);
