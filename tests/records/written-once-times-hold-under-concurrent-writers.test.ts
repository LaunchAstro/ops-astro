// SPDX-License-Identifier: AGPL-3.0-only
//
// The two written-once times against writers on other connections. An agent
// credential's first revocation is stamped by its trigger with the database
// clock, and a revocation already recorded is not rewritten; when a privacy
// incident was found is not rewritten. Each schedule holds one writer of the
// row open on its own connection, sees the second parked on the row in
// `pg_stat_activity`, then ends the first. A crash or a lost response is a
// relay cut before or after the commit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  connect,
  type BusinessId,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { cutTransaction } from '../support/cut-transaction.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: string;
let first: Member;
let second: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'writtenoncerace' });
  business = await insertBusiness(db.app, 'written-once-race');
  first = await enrol(db.app, business, 'first-revoker');
  second = await enrol(db.app, business, 'second-revoker');
}, 120_000);

afterAll(async () => {
  if (serverUrl === undefined) return;
  await db?.drop();
});

const asApp = async (sql: string, params: readonly unknown[]) =>
  await db.app.withBusiness(business, async (tx) => await tx.query(sql, params));

/** A live credential for a new agent of the business. */
async function liveCredential(): Promise<string> {
  const id = randomUUID();
  const agent = randomUUID();
  await asApp(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
    business,
    agent,
  ]);
  await asApp(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose,
        scope, credential_hash, credential_scheme, credential_key_id, expires_at)
     values ($1, $2, $3, $4, $5, 'a reporting agent', array['task:read'], repeat('a', 64),
             'hmac-sha256-v1', 'test/written-once-race@1', now() + interval '30 days')`,
    [business, id, agent, first.personId, first.actorId],
  );
  return id;
}

/** A revocation as the application role writes it straight, answering the time stored. */
const revoke = async (tx: TenantQuery, id: string, by: Member): Promise<string> => {
  const [row] = await tx.query<{ readonly at: string }>(
    `update public.agent_credentials
        set revoked_at = timestamptz '2000-01-01 00:00:00+00', revoked_by_actor_id = $2
      where id = $1 returning revoked_at::text as at`,
    [id, by.actorId],
  );
  return String(row?.at);
};

const revocationOf = async (id: string) =>
  (
    await db.admin.execute<{ readonly at: string | null; readonly by: string | null }>(
      `select revoked_at::text as at, revoked_by_actor_id::text as by
         from public.agent_credentials where id = $1`,
      [id],
    )
  ).map((row) => ({ at: row.at, by: row.by }))[0];

/** The first revocation held open, the second seen parked on the row, then the first ends `ending`. */
async function revokeBehind(id: string, ending: 'commit' | 'rollback') {
  let held = '';
  const holder = await hold(
    db.appUrl,
    business,
    async (tx) => {
      held = await revoke(tx, id, first);
    },
    ending,
  );
  const racer = connect(db.appUrl, { source: 'racer' });
  try {
    // Settled as it starts, so its refusal is never an unhandled rejection.
    const racing = Promise.allSettled([
      racer.withBusiness(business as BusinessId, async (tx) => await revoke(tx, id, second)),
    ]);
    await waitingOn(db.admin, 'transactionid', 'agent_credentials');
    await holder.letGo();
    const [raced] = await racing;
    return { held, raced };
  } finally {
    await holder.letGo().catch(() => null);
    await racer.close();
  }
}

it('two revocations of one agent credential at once leave the first one stamped', async () => {
  const id = await liveCredential();
  const { held, raced } = await revokeBehind(id, 'commit');
  expect(raced).toMatchObject({ status: 'rejected', reason: { code: '23001' } });
  expect(await revocationOf(id)).toStrictEqual({ at: held, by: first.actorId });
});

it('a revocation behind one that rolled back is stamped with the clock after its wait', async () => {
  const id = await liveCredential();
  const { held, raced } = await revokeBehind(id, 'rollback');
  expect(raced.status).toBe('fulfilled');
  const stored = await revocationOf(id);
  expect(stored?.by).toBe(second.actorId);
  const [later] = await db.admin.execute<{ readonly later: boolean }>(
    `select $1::timestamptz > $2::timestamptz as later`,
    [stored?.at, held],
  );
  expect(later).toMatchObject({ later: true });
});

it('a revocation cut before its commit leaves the credential live, and its retry stamps it', async () => {
  const id = await liveCredential();
  const cut = await cutTransaction(db.appUrl, business, 'before-commit', async (tx) => {
    await revoke(tx, id, first);
  });
  expect(cut.status).toBe('rejected');
  expect(await revocationOf(id)).toStrictEqual({ at: null, by: null });
  await db.app.withBusiness(business, async (tx) => await revoke(tx, id, first));
  expect((await revocationOf(id))?.by).toBe(first.actorId);
});

it('a revocation whose commit answer is lost keeps its stamp when it is retried', async () => {
  const id = await liveCredential();
  const cut = await cutTransaction(db.appUrl, business, 'after-commit', async (tx) => {
    await revoke(tx, id, first);
  });
  expect(cut.status).toBe('rejected');
  const stamped = await revocationOf(id);
  expect(stamped?.by).toBe(first.actorId);
  await expect(
    db.app.withBusiness(business, async (tx) => await revoke(tx, id, first)),
  ).rejects.toMatchObject({ code: '23001' });
  expect(await revocationOf(id)).toStrictEqual(stamped);
});

it('a change to when an incident was found, parked behind a status change, is refused', async () => {
  const id = randomUUID();
  await asApp(
    `insert into public.privacy_incidents
       (business_id, id, what_happened, found_at, found_by, affected, information_kinds,
        recorded_by_actor)
     values ($1, $2, 'a report went to the wrong client', now() - interval '2 days',
             'the account manager', 'one client', array['contact'], $3)`,
    [business, id, first.actorId],
  );
  const read = async () =>
    (
      await db.admin.execute<{ readonly found: string; readonly status: string }>(
        `select found_at::text as found, status from public.privacy_incidents where id = $1`,
        [id],
      )
    ).map((row) => ({ found: row.found, status: row.status }))[0];
  const before = await read();
  const holder = await hold(db.appUrl, business, async (tx) => {
    await tx.query(`update public.privacy_incidents set status = 'closed' where id = $1`, [id]);
  });
  const racer = connect(db.appUrl, { source: 'racer' });
  try {
    const racing = Promise.allSettled([
      racer.withBusiness(business as BusinessId, async (tx) => {
        await tx.query(`update public.privacy_incidents set found_at = now() where id = $1`, [id]);
      }),
    ]);
    await waitingOn(db.admin, 'transactionid', 'privacy_incidents');
    await holder.letGo();
    expect((await racing)[0]).toMatchObject({ status: 'rejected', reason: { code: '23001' } });
  } finally {
    await holder.letGo().catch(() => null);
    await racer.close();
  }
  expect(await read()).toStrictEqual({ found: before?.found, status: 'closed' });
});
