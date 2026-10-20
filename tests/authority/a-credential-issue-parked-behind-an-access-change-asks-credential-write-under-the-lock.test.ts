// SPDX-License-Identifier: AGPL-3.0-only
//
// `credential.issue` and every change to who may do what take the business's
// access lock, the issue exclusively. An issue that waits on that lock behind
// a revocation of its issuer's `credential:write` asks that key once it holds
// the lock, so it is refused and mints no credential on the revoked grant.
//
// A fixture transaction on its own connection takes the access lock, the
// issue starts and is seen waiting on it (`pg_blocking_pids`), and the
// fixture then revokes the grant and commits.

import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { codeOf, credentialsOf, issueAs, issueBody, issuerIn } from './agent-credential-issuer.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let world: World;

beforeAll(async () => {
  if (serverUrl !== undefined) world = await createWorld('credissuelock');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

/** Waits until some backend waits on `holder`. */
async function waitedOn(holder: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const rows = await world.db.admin.execute<{ readonly pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and $1::int = any(pg_blocking_pids(pid))`,
      [holder],
    );
    if (rows.length > 0) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error('the issue never waited on the access lock');
}

it('an issue parked behind a revocation of its credential:write is refused and mints nothing', async () => {
  const issuer = await issuerIn(world);
  const fixture = connect(world.db.appUrl, { max: 1 });
  const issuing = connect(world.db.appUrl, { max: 1 });
  try {
    let answer: unknown;
    await fixture.withBusiness(world.alpha, async (tx) => {
      const [row] = await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid');
      await advisoryLock(tx, `access:${tx.businessId}`);
      const issue = issueAs(world, issuer, issueBody(), issuing);
      await waitedOn(Number(row?.pid));
      await revokeGrant(tx, issuer.grants['credential:write'] ?? '');
      // Committed when this returns; the issue then takes the lock.
      answer = issue;
    });
    expect(codeOf(await answer)).toBe('SCOPE_NOT_GRANTED');
    expect(await credentialsOf(world, issuer)).toEqual([]);
  } finally {
    await Promise.all([fixture.close(), issuing.close()]);
  }
}, 60_000);
