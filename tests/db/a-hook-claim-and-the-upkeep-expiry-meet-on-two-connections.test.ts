// SPDX-License-Identifier: AGPL-3.0-only
//
// The upkeep's `ops.expire_auth_hook_messages()` (20261020053037) deletes hook
// message claims older than a day while a send may be claiming a message. The
// claim is the primary key, so a claim of a digest the expiry is deleting
// waits on the expiry's transaction: committed, the message is claimed afresh;
// rolled back, the old claim stands and the send is refused as a replay. A
// claim the expiry cannot see yet is never waited on or removed, and a second
// expiry finds nothing. The claim and the expiry each run on a connection of
// their own, as the application and the upkeep identity.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { asRole, Client, dropLogins, loginIn, serverUrl } from './backup-identity.fixture.ts';
import { waitingOn } from '../automations/race-hold.ts';

const CLAIM = `insert into ops.auth_hook_messages (message_digest) values ($1)
  on conflict (message_digest) do nothing returning 1`;
let db: FreshDatabase;
let upkeep: { url: string; name: string };
let owner: Client;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'hookrace' });
  upkeep = await loginIn(db, 'ops_astro_upkeep', 'hr');
  const url = new URL(serverUrl);
  url.pathname = `/${db.name}`;
  owner = new Client(url.toString());
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await dropLogins(db, upkeep === undefined ? [] : [upkeep.name]);
});

const digestOf = (n: number) => n.toString(16).padStart(64, '0');

const watch = async (sql: string, params: readonly unknown[]) =>
  (await owner.query(sql, [...params])).rows;

/** The application group's session, as the product's send claims. */
async function claimant(): Promise<Client> {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db.name}`;
  const client = new Client(url.toString());
  await client.query('begin');
  await client.query('set local role ops_astro_app');
  return client;
}

const ageOf = async (digest: string) =>
  (
    await owner.query<{ hours: number }>(
      `select round(extract(epoch from now() - claimed_at) / 3600)::int as hours
         from ops.auth_hook_messages where message_digest = $1`,
      [digest],
    )
  ).rows.map((row) => row.hours);

/** A claim of a day-old digest sent while the expiry holds its delete, then `settle` ends the expiry. */
async function claimedWhileExpiring(digest: string, settle: 'commit' | 'rollback') {
  await owner.query(
    `insert into ops.auth_hook_messages (message_digest, claimed_at)
     values ($1, now() - interval '25 hours')`,
    [digest],
  );
  const expiry = await asRole(upkeep.url, 'ops_astro_upkeep');
  const claim = await claimant();
  try {
    await expiry.query('begin');
    const [expired] = (
      await expiry.query<{ n: string }>('select ops.expire_auth_hook_messages()::text as n')
    ).rows;
    const claimed = claim.query(CLAIM, [digest]);
    await waitingOn(watch, 1);
    await expiry.query(settle);
    const { rowCount } = await claimed;
    await claim.query('commit');
    return { expired: expired?.n, claimed: rowCount, ages: await ageOf(digest) };
  } finally {
    await claim.end();
    await expiry.end();
  }
}

describe.skipIf(serverUrl === undefined)('a hook claim against the upkeep expiry', () => {
  it('a claim of a digest the expiry is deleting waits, and claims it afresh once the expiry commits', async () => {
    expect(await claimedWhileExpiring(digestOf(1), 'commit')).toStrictEqual({
      expired: '1',
      claimed: 1,
      ages: [0],
    });
  });

  it('a claim of a digest the expiry is deleting is a replay once the expiry rolls back, the old claim kept', async () => {
    expect(await claimedWhileExpiring(digestOf(2), 'rollback')).toStrictEqual({
      expired: '1',
      claimed: 0,
      ages: [25],
    });
  });

  it('an expiry neither waits on nor removes a claim not yet committed, and a second expiry finds nothing', async () => {
    const digest = digestOf(3);
    await owner.query('delete from ops.auth_hook_messages');
    const claim = await claimant();
    const expiry = await asRole(upkeep.url, 'ops_astro_upkeep');
    try {
      expect((await claim.query(CLAIM, [digest])).rowCount).toBe(1);
      const runs = [];
      for (let run = 0; run < 2; run += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one expiry after the other
        const { rows } = await expiry.query<{ n: string }>(
          'select ops.expire_auth_hook_messages()::text as n',
        );
        runs.push(rows[0]?.n);
      }
      await claim.query('commit');
      expect({ runs, ages: await ageOf(digest) }).toStrictEqual({ runs: ['0', '0'], ages: [0] });
    } finally {
      await claim.end();
      await expiry.end();
    }
  });
});
