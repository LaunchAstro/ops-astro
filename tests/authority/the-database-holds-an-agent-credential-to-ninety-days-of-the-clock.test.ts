// SPDX-License-Identifier: AGPL-3.0-only
//
// The `agent_credentials_within_ceiling` trigger reads the row's `issued_at`
// and refuses an `expires_at` past 90 days of it, so no row written any way
// lives longer than 90 days (`CREDENTIAL_MAX_DAYS`, 90 days of 24 hours).
//
// Two connections: a row whose transaction waited behind another connection
// is still judged on its own stamped issue. A crash: an issue's credential row
// refused by the trigger leaves nothing of the issue behind and records the
// failed attempt; the same operation sent again then issues once. And the time
// the trigger judges on: 90 days in the session's time zone, and an
// `issued_at` the writer supplies, against the 90 days of 24 hours from the
// insert that the ceiling promises.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  advisoryLock,
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { insertsInto } from '../support/failing-statements.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  credentialsOf,
  DAY_MS,
  issueAs,
  issueBody,
  issuerIn,
  type Issuer,
} from './agent-credential-issuer.ts';

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let world: World;

beforeAll(async () => {
  if (serverUrl !== undefined) world = await createWorld('credceilingrace');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

/** A fresh agent actor for a credential row written straight to the table. */
async function agentFor(tx: TenantQuery): Promise<string> {
  const agent = randomUUID();
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
    [tx.businessId, agent],
  );
  return agent;
}

/** Inserts a credential row; `times` is the SQL for its `issued_at` and `expires_at`. */
async function insertRow(
  tx: TenantQuery,
  issuer: Issuer,
  times: { readonly issuedAt: string; readonly expiresAt: string },
  parameters: readonly unknown[] = [],
): Promise<void> {
  const agent = await agentFor(tx);
  await tx.query(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose,
        scope, credential_hash, credential_scheme, credential_key_id, issued_at, expires_at)
     values ($1, $2, $3, $4, $5, 'written straight to the table', array['task:read'],
             $6, 'hmac-sha256-v1', 'test@1', ${times.issuedAt}, ${times.expiresAt})`,
    [
      tx.businessId,
      randomUUID(),
      agent,
      issuer.personId,
      issuer.actorId,
      'a'.repeat(64),
      ...parameters,
    ],
  );
}

/** `tx`, with its credential insert's expiry moved to 91 days out. */
const stretchingTx = (tx: TenantQuery): TenantQuery =>
  new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
      return async (text: string, parameters: readonly unknown[] = []) => {
        if (!insertsInto('agent_credentials')(text, parameters)) {
          return await target.query(text, parameters);
        }
        const moved = [...parameters];
        moved[10] = new Date(Date.now() + 91 * DAY_MS);
        return await target.query(text, moved);
      };
    },
  });

/** `database`, with each credential insert's expiry moved to 91 days out. */
function stretchingExpiry(database: Database): Database {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'withBusiness') return Reflect.get(target, property, receiver) as unknown;
      return async <T>(
        businessId: Parameters<Database['withBusiness']>[0],
        run: (tx: TenantQuery) => Promise<T>,
      ): Promise<T> =>
        await target.withBusiness(businessId, async (tx) => await run(stretchingTx(tx)));
    },
  });
}

const agentActors = async (): Promise<number> => {
  const [row] = await world.db.admin.execute<{ readonly agents: number }>(
    `select count(*)::int as agents from public.actors where business_id = $1 and kind = 'agent'`,
    [world.alpha],
  );
  return row?.agents ?? 0;
};

const auditedFor = async (operationId: unknown): Promise<readonly string[]> =>
  (
    await world.db.admin.execute<{ readonly outcome: string }>(
      `select outcome from public.audit_events where operation_id = $1 order by seq`,
      [String(operationId)],
    )
  ).map((row) => row.outcome);

it('a credential row whose transaction waited behind another connection is judged on its own stamped issue', async () => {
  const issuer = await issuerIn(world);
  const key = `ceiling-proof:${randomUUID()}`;
  const blocker = await hold(world.db.appUrl, world.alpha, async (tx) => {
    await advisoryLock(tx, key);
  });
  const writer = connect(world.db.appUrl);
  try {
    const writing = writer.withBusiness(world.alpha, async (tx) => {
      // The transaction's clock is fixed here, before the wait.
      await tx.query('select now()');
      await advisoryLock(tx, key);
      // 90 days of 24 hours from the insert's own instant, after the wait.
      await insertRow(tx, issuer, {
        issuedAt: 'default',
        expiresAt: `clock_timestamp() + make_interval(secs => ${String((90 * DAY_MS) / 1000)})`,
      });
    });
    writing.catch(() => null);
    try {
      await waitingOn(world.db.admin, 'advisory', 'pg_advisory_xact_lock');
      await delay(1_100);
    } finally {
      await blocker.letGo();
    }
    await expect(writing).rejects.toThrow(/90 days/u);
    expect(await credentialsOf(world, issuer)).toEqual([]);
  } finally {
    await writer.close();
  }
}, 60_000);

it('an issue whose credential row the ceiling refuses leaves nothing behind and records its failed attempt', async () => {
  const issuer = await issuerIn(world);
  const body = issueBody();
  const agentsBefore = await agentActors();
  await expect(issueAs(world, issuer, body, stretchingExpiry(world.db.app))).rejects.toThrow(
    /90 days/u,
  );
  expect({
    minted: await credentialsOf(world, issuer),
    agents: await agentActors(),
    audited: await auditedFor(body['operationId']),
  }).toEqual({ minted: [], agents: agentsBefore, audited: ['failed'] });
}, 60_000);

it('an issue sent again after the ceiling refused its row issues one credential', async () => {
  const issuer = await issuerIn(world);
  const body = issueBody();
  await expect(issueAs(world, issuer, body, stretchingExpiry(world.db.app))).rejects.toThrow(
    /90 days/u,
  );
  const answer = await issueAs(world, issuer, body);
  expect(isCommandRefusal(answer), JSON.stringify(answer)).toBe(false);
  expect({
    minted: (await credentialsOf(world, issuer)).length,
    audited: await auditedFor(body['operationId']),
  }).toEqual({ minted: 1, audited: ['failed', 'applied'] });
}, 60_000);

it('the database refuses a credential row living past 90 days of 24 hours in a session time zone that keeps summer time', async () => {
  const issuer = await issuerIn(world);
  // 1 October 2026 to 30 December 2026 crosses New York's autumn change of clock.
  const issuedAt = Date.parse('2026-10-01T00:00:00Z');
  const living = world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(`set local timezone = 'America/New_York'`);
    await insertRow(tx, issuer, { issuedAt: '$7', expiresAt: '$8' }, [
      new Date(issuedAt),
      new Date(issuedAt + 90 * DAY_MS + 30 * 60 * 1000),
    ]);
  });
  await expect(living).rejects.toThrow(/90 days/u);
}, 60_000);

it('the database refuses a credential row stamped with a later issue that lives past 90 days of its insert', async () => {
  const issuer = await issuerIn(world);
  const living = world.db.app.withBusiness(world.alpha, async (tx) => {
    await insertRow(tx, issuer, {
      issuedAt: `now() + interval '30 days'`,
      expiresAt: `now() + interval '100 days'`,
    });
  });
  await expect(living).rejects.toThrow(/90 days/u);
}, 60_000);
