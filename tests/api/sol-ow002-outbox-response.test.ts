// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { Client } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';
import { openSchedules } from '../runtime/schedules-harness.ts';

it('Sol proof, criterion correctness: the function must persist its security signal before returning a response that can freeze the instance', async () => {
  const s = await openSchedules('solow002outbox', 100_000);
  const address = new URL(databaseUrlFromEnvironment()!);
  address.pathname = `/${s.db.name}`;
  const holder = new Client(address.toString());
  let pending: Promise<Response> | undefined;
  try {
    const keyId = 'test/sol-ow002@1';
    const handle = createFunctionHandler({
      DATABASE_URL: s.db.appUrl,
      GOTRUE_URL: TEST_ISSUER,
      SERVED_HOST: 'ops.example.test',
      DELEGATION_CREDENTIAL_KEY_ID: keyId,
      DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
      OPS_ENVIRONMENT: 'staging',
      ALERT_SCOPE_KEY: 'ab'.repeat(32),
      RECOVERY_BUSINESS_KEYS: 'none',
    });
    await holder.query('begin');
    await holder.query('lock table ops.api_events in access exclusive mode');
    let returned = false;
    pending = handle(
      new Request('https://ops.example.test/api/b/made-up/task/board', {
        method: 'POST',
        headers: {
          host: 'ops.example.test',
          authorization: 'Bearer not-a-token',
          'content-type': 'application/json',
        },
        body: '{"board":null}',
      }),
    ).then((response) => {
      returned = true;
      return response;
    });
    // Wait for the real outbox INSERT to reach the held lock, not an arbitrary delay.
    await expect
      .poll(
        async () => {
          const [row] = await s.db.admin.execute<{ count: string }>(
            "select count(*)::text as count from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and query like 'insert into ops.api_events%'",
            [s.db.name],
          );
          return Number(row?.count ?? '0');
        },
        { timeout: 5_000 },
      )
      .toBe(1);
    expect(
      returned,
      'the function returned while the security event was still blocked before its INSERT',
    ).toBe(false);
  } finally {
    await holder.query('rollback');
    await pending;
    await holder.end();
    await s.db.drop();
  }
});
