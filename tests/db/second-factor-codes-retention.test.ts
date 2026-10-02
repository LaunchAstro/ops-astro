// SPDX-License-Identifier: AGPL-3.0-only
//
// Second-factor codes are kept only as long as they count (migration 20261002105957,
// security review): the daily upkeep job (`backup.mjs expire`) deletes every
// `ops.second_factor_codes` row older than 24 hours through
// `ops.expire_second_factor_codes()`, as `ops_astro_upkeep`, over a login that
// holds that role alone. The application group still inserts and reads only,
// and neither it nor PUBLIC may run the expiry. The job runs here as the
// machine loads it, its store stood in and the database reached over one
// session (backup-host-reach.fixture.ts) rather than psql on staging's network.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { dropLogins, hostReach, job, loginIn, serverUrl } from './backup-identity.fixture.ts';

const UPKEEP = 'ops_astro_upkeep';
const EXPIRE = 'select ops.expire_second_factor_codes()';
let db: FreshDatabase;
let upkeep: { url: string; name: string };

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'sfcret' });
  upkeep = await loginIn(db, UPKEEP, 'up');
}, 120_000);

afterAll(async () => {
  await dropLogins(db, upkeep === undefined ? [] : [upkeep.name]);
});

class Rollback extends Error {}

/**
 * `text` as `role`, after the owner's `before`, all rolled back whatever it
 * did: 'ok' or the server's SQLSTATE.
 */
async function attempt(role: string, text: string, before?: string): Promise<string> {
  try {
    await db.admin.transaction(async (execute) => {
      if (before !== undefined) await execute(before);
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

describe.skipIf(serverUrl === undefined)('second-factor codes retention', () => {
  purgeCases();
  grantCases();
});

function purgeCases() {
  it('second-factor codes older than the horizon are deleted by the upkeep and younger ones kept', async () => {
    const ages = { old: '25 hours', older: '30 days', young: '23 hours', now: '0 seconds' };
    for (const [label, age] of Object.entries(ages)) {
      // oxlint-disable-next-line no-await-in-loop -- one row each, as the admin backdates them
      await db.admin.execute(
        `insert into ops.second_factor_codes (subject_digest, attempt, state, recorded_at)
         values (repeat('a', 64), $1, $2, now() - $3::interval)`,
        [randomUUID(), label === 'now' ? 'answered' : 'sent', age],
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
    expect(record['secondFactorCodes']).toStrictEqual({ outcome: 'recorded', count: 2 });
    const kept = await db.admin.execute<{ hours: number }>(
      `select round(extract(epoch from now() - recorded_at) / 3600)::int as hours
         from ops.second_factor_codes order by recorded_at`,
    );
    expect(kept.map((row) => row.hours)).toStrictEqual([23, 0]);
  });

  it('the app group cannot delete second-factor codes or run the expiry', async () => {
    for (const text of [
      'delete from ops.second_factor_codes',
      'truncate ops.second_factor_codes',
      EXPIRE,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt('ops_astro_app', text), text).toBe('42501');
    }
    expect(await attempt('ops_astro_app', 'select 1 from ops.second_factor_codes')).toBe('ok');
  });
}

function grantCases() {
  it('PUBLIC cannot execute the expiry function, whose path is pinned', async () => {
    // A role holding only what PUBLIC holds, given usage on `ops` for the try,
    // so the refusal is the function's and not the schema's.
    const usage = `grant usage on schema ops to "${db.restrictedRole}"`;
    expect(await attempt(db.restrictedRole, EXPIRE, usage)).toBe('42501');
    const [fn] = await db.admin.execute<Record<string, unknown>>(
      `select (select count(*)::int from aclexplode(p.proacl) a where a.grantee = 0) as "public",
              p.proacl is not null as "acl", p.prosecdef as definer, p.proconfig as config
         from pg_proc p where p.oid = 'ops.expire_second_factor_codes()'::regprocedure`,
    );
    expect(fn).toStrictEqual({
      public: 0,
      acl: true,
      definer: true,
      config: ['search_path=pg_catalog'],
    });
  });

  it('the upkeep identity logs in as nobody, owns nothing and holds the expiry alone', async () => {
    const [role] = await db.admin.execute<Record<string, boolean>>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = $1`,
      [UPKEEP],
    );
    expect(Object.values(role ?? { missing: true }).every((held) => !held)).toBe(true);
    const held = await db.admin.execute<{ held: string }>(
      `select format('%s.%s %s', table_schema, table_name, privilege_type) as held
         from information_schema.table_privileges where grantee = $1
       union all
       select format('%s.%s() %s', routine_schema, routine_name, privilege_type)
         from information_schema.routine_privileges where grantee = $1
       union all
       select 'owns ' || relname from pg_class where relowner = (select oid from pg_roles where rolname = $1)
       order by 1`,
      [UPKEEP],
    );
    expect(held.map((row) => row.held)).toStrictEqual(['ops.expire_second_factor_codes() EXECUTE']);
    for (const text of [
      'select 1 from ops.second_factor_codes',
      'delete from ops.second_factor_codes',
      'select 1 from public.businesses',
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt(UPKEEP, text), text).toBe('42501');
    }
  });
}
