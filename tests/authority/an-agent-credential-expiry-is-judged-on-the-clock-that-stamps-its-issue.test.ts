// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential lives at most 90 days from its issue. `issued_at` is
// the database's clock, so the expiry is judged on that clock too: an app
// clock running a day ahead of the database cannot stretch the ceiling past
// 90 days of `issued_at`, and one running a day behind cannot shrink it. The
// database holds the ceiling itself as well, so no row written any other way
// lives longer.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it as vitestIt, vi } from 'vitest';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import {
  codeOf,
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
  if (serverUrl !== undefined) world = await createWorld('credexpiryclock');
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (serverUrl !== undefined) await world.close();
});

/** The database's clock now, in milliseconds. */
const databaseNow = async (): Promise<number> => {
  const rows = await world.db.admin.execute<{ readonly at: Date }>(
    'select clock_timestamp() as at',
  );
  return new Date(rows[0]?.at ?? Number.NaN).getTime();
};

/** The app's clock set `skew` milliseconds off the database's. */
async function appClockOff(skew: number): Promise<number> {
  const at = await databaseNow();
  const offset = at + skew - Date.now();
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
  return at;
}

it('an expiry past 90 days of the database clock is refused when the app clock runs a day ahead', async () => {
  const issuer = await issuerIn(world);
  const at = await appClockOff(DAY_MS);
  const expiresAt = new Date(at + 90 * DAY_MS + DAY_MS / 2).toISOString();
  const answer = await issueAs(world, issuer, issueBody({ expiresAt }));
  const lives = (await credentialsOf(world, issuer)).map(
    (row) => (row.expires_at.getTime() - row.issued_at.getTime()) / DAY_MS,
  );
  expect(lives, 'days each issued credential lives').toEqual([]);
  expect(codeOf(answer)).toBe('FIELD_VALUE_INVALID');
}, 60_000);

it('an expiry inside 90 days of the database clock is issued when the app clock runs a day behind', async () => {
  const issuer = await issuerIn(world);
  const at = await appClockOff(-DAY_MS);
  const expiresAt = new Date(at + 90 * DAY_MS - DAY_MS / 2).toISOString();
  const answer = await issueAs(world, issuer, issueBody({ expiresAt }));
  expect(isCommandRefusal(answer), JSON.stringify(answer)).toBe(false);
  const [row] = await credentialsOf(world, issuer);
  expect(row?.expires_at.getTime()).toBeLessThanOrEqual(
    (row?.issued_at.getTime() ?? 0) + 90 * DAY_MS,
  );
}, 60_000);

/** A credential row written straight to the table, `lives` past its `issued_at`. */
const insertLiving = async (issuer: Issuer, lives: string): Promise<void> => {
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const agent = randomUUID();
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
      [tx.businessId, agent],
    );
    await tx.query(
      `insert into public.agent_credentials
         (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose,
          scope, credential_hash, credential_scheme, credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'written straight to the table', array['task:read'],
               $6, 'hmac-sha256-v1', 'test@1', now() + $7::interval)`,
      [tx.businessId, randomUUID(), agent, issuer.personId, issuer.actorId, 'a'.repeat(64), lives],
    );
  });
};

it('the database refuses a credential row that lives past 90 days of its issue', async () => {
  const issuer = await issuerIn(world);
  await insertLiving(issuer, '90 days');
  await expect(insertLiving(issuer, '90 days 1 second')).rejects.toThrow(/90 days/u);
  expect(await credentialsOf(world, issuer)).toHaveLength(1);
}, 60_000);
