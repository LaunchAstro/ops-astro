// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { Client } from '../db/backup-identity.fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';
import { openSchedules } from '../runtime/schedules-harness.ts';

const HOST = 'ops.example.test';
const WAITING =
  "select count(*)::text as count from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and query like 'insert into ops.api_events%'";

/** The hosted handler on `s`'s database, with outbox alerts. */
function handlerFor(appUrl: string): (request: Request) => Promise<Response> {
  const keyId = 'test/outbox-own@1';
  return createFunctionHandler({
    DATABASE_URL: appUrl,
    GOTRUE_URL: TEST_ISSUER,
    SERVED_HOST: HOST,
    DELEGATION_CREDENTIAL_KEY_ID: keyId,
    DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
    OPS_ENVIRONMENT: 'staging',
    ALERT_SCOPE_KEY: 'cd'.repeat(32),
    RECOVERY_BUSINESS_KEYS: 'none',
  });
}

/** A request with a bearer no issuer signed: it raises a sign-in signal. */
const badBearer = (): Request =>
  new Request(`https://${HOST}/api/b/made-up/task/board`, {
    method: 'POST',
    headers: {
      host: HOST,
      authorization: 'Bearer not-a-token',
      'content-type': 'application/json',
    },
    body: '{"board":null}',
  });

// A response waits for the events its own request raised, never another's:
// a flood of signals queued on the one outbox login holds up no one else.
it('a request that raised no signal is answered while another request’s signal waits on the outbox', async () => {
  const s = await openSchedules('outboxownevents', 100_000);
  const address = new URL(databaseUrlFromEnvironment()!);
  address.pathname = `/${s.db.name}`;
  const holder = new Client(address.toString());
  let blocked: Promise<Response> | undefined;
  try {
    const handle = handlerFor(s.db.appUrl);
    await holder.query('begin');
    await holder.query('lock table ops.api_events in access exclusive mode');
    let signalled = false;
    blocked = handle(badBearer()).then((response) => {
      signalled = true;
      return response;
    });
    await expect
      .poll(
        async () => {
          const [row] = await s.db.admin.execute<{ count: string }>(WAITING, [s.db.name]);
          return Number(row?.count ?? '0');
        },
        { timeout: 5_000 },
      )
      .toBe(1);
    const health = new Request(`https://${HOST}/api/health`, { headers: { host: HOST } });
    const quiet = await Promise.race([
      handle(health).then((response) => response.status),
      new Promise<'held'>((resolve) => {
        setTimeout(() => resolve('held'), 3_000);
      }),
    ]);
    expect(quiet, 'a request with no signal of its own waited on another’s outbox insert').not.toBe(
      'held',
    );
    expect(signalled, 'the signalling request still waits for its own insert').toBe(false);
  } finally {
    await holder.query('rollback');
    await blocked;
    await holder.end();
    await s.db.drop();
  }
});
