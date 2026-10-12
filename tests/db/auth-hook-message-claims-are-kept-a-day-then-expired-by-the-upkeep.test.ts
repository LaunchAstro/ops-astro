// SPDX-License-Identifier: AGPL-3.0-only
//
// A Send Email hook message's claim (`ops.auth_hook_messages`) only matters
// while the message could still be replayed, and the hook's signature check
// refuses a message more than five minutes from its timestamp. The table kept
// every claim forever, with no time to trim by, and granted the application
// group the whole table. Now a claim records when it was made, the daily
// upkeep job (`backup.mjs expire`) removes claims older than a day through
// `ops.expire_auth_hook_messages()` as `ops_astro_upkeep`, and the
// application group claims by the digest column alone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { dropLogins, hostReach, job, loginIn, serverUrl } from './backup-identity.fixture.ts';

const EXPIRE = 'select ops.expire_auth_hook_messages()';
let db: FreshDatabase;
let upkeep: { url: string; name: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'hookret' });
  upkeep = await loginIn(db, 'ops_astro_upkeep', 'hk');
}, 120_000);

afterAll(async () => {
  await dropLogins(db, upkeep === undefined ? [] : [upkeep.name]);
});

class Rollback extends Error {}

/** `text` as `role`, rolled back whatever it did: 'ok' or the server's SQLSTATE. */
async function attempt(role: string, text: string): Promise<string> {
  try {
    await db.admin.transaction(async (execute) => {
      await execute(`set local role ${role}`);
      await execute(text);
      throw new Rollback();
    });
  } catch (error) {
    if (error instanceof Rollback) return 'ok';
    return String((error as { code?: unknown }).code);
  }
  return 'committed';
}

describe.skipIf(serverUrl === undefined)('hook message claims', () => {
  expiryCases();
  grantCases();
});

function expiryCases() {
  it('claims older than a day are removed by the upkeep job and younger ones kept', async () => {
    const ages = { old: '25 hours', older: '30 days', young: '23 hours', now: '0 seconds' };
    for (const [label, age] of Object.entries(ages)) {
      // oxlint-disable-next-line no-await-in-loop -- one row each, as the admin backdates them
      await db.admin.execute(
        `insert into ops.auth_hook_messages (message_digest, claimed_at)
         values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), now() - $2::interval)`,
        [label, age],
      );
    }
    const record = await (
      await job()
    ).expireBackups({
      storeUrl: 'postgres://backups:5432/backups',
      upkeepUrl: upkeep.url,
      reach: async (url, script) =>
        url === upkeep.url ? await hostReach(url, script) : '{"count":0,"fresh":false}',
    });
    expect(record['secondFactorCodes']).toStrictEqual({
      outcome: 'recorded',
      count: 0,
      hookMessages: 2,
    });
    const kept = await db.admin.execute<{ hours: number }>(
      `select round(extract(epoch from now() - claimed_at) / 3600)::int as hours
         from ops.auth_hook_messages order by claimed_at`,
    );
    expect(kept.map((row) => row.hours)).toStrictEqual([23, 0]);
  });
}

function grantCases() {
  it('the app group claims by digest alone: no claim time of its own, no change, no removal, no expiry', async () => {
    const digest = `'${'b'.repeat(64)}'`;
    expect(
      await attempt(
        'ops_astro_app',
        `insert into ops.auth_hook_messages (message_digest) values (${digest})`,
      ),
    ).toBe('ok');
    for (const text of [
      `insert into ops.auth_hook_messages (message_digest, claimed_at) values (${digest}, now() - interval '2 days')`,
      `update ops.auth_hook_messages set claimed_at = now()`,
      'delete from ops.auth_hook_messages',
      EXPIRE,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt('ops_astro_app', text), text).toBe('42501');
    }
  });

  it('PUBLIC cannot run the expiry, which runs as its definer on a pinned path', async () => {
    const [fn] = await db.admin.execute<Record<string, unknown>>(
      `select (select count(*)::int from aclexplode(p.proacl) a where a.grantee = 0) as "public",
              p.proacl is not null as "acl", p.prosecdef as definer, p.proconfig as config
         from pg_proc p where p.oid = 'ops.expire_auth_hook_messages()'::regprocedure`,
    );
    expect(fn).toStrictEqual({
      public: 0,
      acl: true,
      definer: true,
      config: ['search_path=pg_catalog'],
    });
  });
}
