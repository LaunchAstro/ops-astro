// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2: the agent credential after its issue, through the real API: the
// issuer's replay gets the same secret while it is live and none once
// revoked, another person's credential is not found without `access:manage`,
// a revocation applies once and deactivates the agent actor, and a second
// transaction waits on the row lock. The world is
// `api-2-agent-credential-world.ts`.

import { describe, expect, it } from 'vitest';
import {
  lockAgentCredential,
  revokeAgentCredential,
} from '../../packages/core-records/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  detailOf,
  harness,
  issue,
  issueBody,
  openWorld,
  revoke,
  stored,
} from './api-2-agent-credential-world.ts';

openWorld();

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 replay: the issuer’s retry of one issue gets the same secret while it is live, and none once revoked', async () => {
    const body = issueBody();
    const first = await issue(body);
    const again = await issue(body);
    expect(again.status).toBe(200);
    const secret = String(detailOf(first)['credential']);
    expect(detailOf(again)['credential']).toBe(secret);
    expect(detailOf(again)['credentialId']).toBe(detailOf(first)['credentialId']);
    expect(await stored(harness.world.alpha)).not.toContain(secret);
    expect((await revoke(detailOf(first)['credentialId'])).status).toBe(200);
    const spent = await issue(body);
    expect(spent.status).toBe(200);
    expect(detailOf(spent)['credential']).toBeNull();
    expect(JSON.stringify(spent.body)).not.toContain(secret);
  });

  it('API-2 person to person: without access:manage another person’s credential is not found, and stays live', async () => {
    const adas = await issue();
    const credentialId = detailOf(adas)['credentialId'];
    const refused = await revoke(credentialId, harness.world.noah.token);
    expect(refused.status).toBe(404);
    expect(refused.code).toBe('NOT_FOUND');
    const live = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly revoked: boolean }>(
          'select revoked_at is not null as revoked from public.agent_credentials where id = $1',
          [String(credentialId)],
        ),
    );
    expect(live).toEqual([{ revoked: false }]);
  });
});

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 revoked once: two revocations apply once, and the agent actor is deactivated', async () => {
    const credentialId = detailOf(await issue())['credentialId'];
    const answers = await Promise.all([revoke(credentialId), revoke(credentialId)]);
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 409]);
    expect(answers.find((answer) => answer.status === 409)?.code).toBe(
      'CREDENTIAL_ALREADY_REVOKED',
    );
    const agent = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly active: boolean }>(
          `select a.active from public.actors a
             join public.agent_credentials c on c.agent_actor_id = a.id
            where c.id = $1`,
          [String(credentialId)],
        ),
    );
    expect(agent).toEqual([{ active: false }]);
  });
});

/** A promise and the call that settles it. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  const settle: (() => void)[] = [];
  const promise = new Promise<void>((resolve) => {
    settle.push(resolve);
  });
  return { promise, open: () => settle[0]?.() };
}

/**
 * Until a backend waits on a row lock the transaction `holder` took: blocked
 * by that backend's pid and waiting on its transaction id, on a connection of
 * its own. A sleep would only hope the two overlapped.
 */
async function waitsBehind(holder: { readonly pid: number; readonly xid: string }): Promise<void> {
  for (let tries = 0; tries < 400; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling the server
    const [row] = await harness.world.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n
         from pg_stat_activity a
         join pg_locks l on l.pid = a.pid and not l.granted and l.locktype = 'transactionid'
        where a.datname = current_database() and a.wait_event_type = 'Lock'
          and $1::int = any(pg_blocking_pids(a.pid)) and l.transactionid::text = $2`,
      [holder.pid, holder.xid],
    );
    if ((row?.n ?? 0) >= 1) return;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error('no backend ever waited on the row lock the holder took');
}

const HOLDER = 'select pg_backend_pid() as pid, pg_current_xact_id()::text as xid';

/** The backend of the last revocation that reached its hold. */
let holding = { pid: -1, xid: '' };

/** One revocation in its own transaction; `hold` keeps it open after the update. */
const revokeInTransaction = async (
  database: Database,
  credentialId: string,
  hold?: Promise<void>,
  locked?: () => void,
) =>
  await database.withBusiness(harness.world.alpha, async (tx) => {
    const held = await lockAgentCredential(tx, credentialId);
    if (held === undefined) return 'not-found';
    const refusal = await revokeAgentCredential(tx, held, harness.world.ada.actorId as string);
    const [me] = await tx.query<{ pid: number; xid: string }>(HOLDER);
    if (me !== undefined) holding = me;
    locked?.();
    await hold;
    return refusal ?? 'revoked';
  });

describe.skipIf(serverUrl === undefined)('API-2 the agent credential, issued and revoked', () => {
  it('API-2 revocation race: a second transaction waits on the row lock and finds it revoked', async () => {
    const credentialId = String(detailOf(await issue())['credentialId']);
    // Two connections: the first holds its revocation open until the second
    // is seen waiting on that row's lock behind it.
    const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
    const hold = latch();
    const updated = latch();
    const first = revokeInTransaction(wide, credentialId, hold.promise, updated.open);
    await updated.promise;
    const second = revokeInTransaction(wide, credentialId);
    await waitsBehind(holding).finally(hold.open);
    const outcomes = await Promise.allSettled([first, second]).finally(
      async () => await wide.close(),
    );
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: 'revoked' },
      { status: 'fulfilled', value: 'already-revoked' },
    ]);
  });
});
