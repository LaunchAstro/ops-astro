// SPDX-License-Identifier: AGPL-3.0-only
//
// C55, carried from S0-3 (TR-S-B1-5; ORCH47's ruling (b)7): the operations
// view shows the date of the last successful tested restore and marks it
// stale once the restore alert would fire. The receipt lives in the backup
// store, which the API cannot reach, so a passed drill also stamps one row on
// the installation's database (migration 0068), through the drill's own
// identity, and `operations.read` reads it, through the real API.
//
// `C55 last tested restore`: none yet reads null; a failed or partial drill
// writes nothing; a passed drill's date shows; past the window the store's
// restore heartbeat uses it is stale. The grant proof: the application group
// only selects, the drill's identity can write only that date, PUBLIC holds
// nothing. `C55 isolation`: a member without operations:read, a client share
// and a delegated agent never see it. Helpers: c55-last-tested-restore-world.ts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  APP_GROUP,
  attempt,
  drill,
  DRILL_ROLE,
  RESTORE_DAYS,
  shown,
  stamped,
  storeRefused,
  storeTook,
  TABLE,
  view,
  WRITE,
} from './c55-last-tested-restore-world.ts';
import { c55Keys, pathOf } from './c55-operations-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c55-last-tested-restore: DATABASE_URL is unset, so nothing below ran.');
}

let harness: Harness;
let credential: string;
let clientToken: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('c55_restore');
  ({ credential, clientToken } = await c55Keys(harness));
}, 120_000);

afterAll(async () => {
  if (serverUrl === undefined) return;
  await harness?.close();
});

it('C55 last tested restore: the window is the store heartbeat window, read from the store file', () => {
  expect(RESTORE_DAYS).toBeGreaterThanOrEqual(1);
});

describe.skipIf(serverUrl === undefined)('C55 last tested restore', () => {
  it('C55 last tested restore: none yet reads null, and stale, since the restore alert fires', async () => {
    expect(await shown(harness)).toStrictEqual({ at: null, stale: true });
    expect(await stamped(harness)).toStrictEqual([]);
  });

  it('C55 last tested restore: a failed drill, and a pass the store did not take, write nothing', async () => {
    await drill(harness, 'failed', storeTook('failed'));
    await expect(drill(harness, 'passed', storeRefused)).rejects.toThrow(
      /receipt could not be written/u,
    );
    expect(await shown(harness)).toStrictEqual({ at: null, stale: true });
    expect(await stamped(harness)).toStrictEqual([]);
  });

  it("C55 last tested restore: a passed drill's date shows, fresh", async () => {
    const before = Date.now();
    await drill(harness, 'passed', storeTook('passed'));
    const after = Date.now();
    const [row] = await stamped(harness);
    const answer = await shown(harness);
    expect(answer).toStrictEqual({ at: row?.at, stale: false });
    expect(Date.parse(answer?.at ?? '')).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(answer?.at ?? '')).toBeLessThanOrEqual(after + 1000);
  });
});

describe.skipIf(serverUrl === undefined)('C55 last tested restore', () => {
  it('C55 last tested restore: past the restore window it is stale; inside it, not', async () => {
    const age = async (days: number) =>
      await harness.world.db.admin.execute(
        `update ${TABLE}
            set at = date_trunc('milliseconds', now() - make_interval(days => $1) - interval '1 hour')`,
        [days],
      );
    await age(RESTORE_DAYS);
    const [old] = await stamped(harness);
    expect(await shown(harness)).toStrictEqual({ at: old?.at, stale: true });
    await age(RESTORE_DAYS - 1);
    const [recent] = await stamped(harness);
    expect(await shown(harness)).toStrictEqual({ at: recent?.at, stale: false });
  });

  it('C55 last tested restore: a later pass moves the date forward, and the row stays one', async () => {
    const [before] = await stamped(harness);
    await drill(harness, 'passed', storeTook('passed'));
    const rows = await stamped(harness);
    expect(rows).toHaveLength(1);
    expect(Date.parse(rows[0]?.at ?? '')).toBeGreaterThan(Date.parse(before?.at ?? ''));
    expect((await shown(harness))?.stale).toBe(false);
  });
});

describe.skipIf(serverUrl === undefined)('C55 last tested restore grants', () => {
  it('C55 last tested restore: the application group only selects the date, and cannot write it', async () => {
    expect(await attempt(harness, APP_GROUP, `select at from ${TABLE}`)).toBe('ok');
    for (const text of [
      `insert into ${TABLE} (at) values (now())`,
      `update ${TABLE} set at = now()`,
      `delete from ${TABLE}`,
      `truncate ${TABLE}`,
      WRITE,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt(harness, APP_GROUP, text), text).toBe('42501');
    }
  });

  it("C55 last tested restore: the drill's identity writes only the date, as now, and reads nothing", async () => {
    expect(await attempt(harness, DRILL_ROLE, WRITE)).toBe('ok');
    // No argument: it cannot name a date, only say a restore passed now.
    const dated = "select ops.record_tested_restore('2020-01-01')";
    expect(await attempt(harness, DRILL_ROLE, dated)).toBe('42883');
    for (const text of [
      `select at from ${TABLE}`,
      `insert into ${TABLE} (at) values (now())`,
      `update ${TABLE} set at = now()`,
      `delete from ${TABLE}`,
      'select 1 from public.businesses',
      'select 1 from ops.operating_business',
      'select 1 from public.privacy_incidents',
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await attempt(harness, DRILL_ROLE, text), text).toBe('42501');
    }
  });
});

describe.skipIf(serverUrl === undefined)('C55 last tested restore grants', () => {
  it("C55 last tested restore: the drill's identity logs in as nobody, owns nothing and holds the stamp alone", async () => {
    const [role] = await harness.world.db.admin.execute<Record<string, boolean>>(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = $1`,
      [DRILL_ROLE],
    );
    expect(Object.values(role ?? { missing: true }).every((held) => !held)).toBe(true);
    const held = await harness.world.db.admin.execute<{ held: string }>(
      `select format('%s.%s %s', table_schema, table_name, privilege_type) as held
         from information_schema.table_privileges where grantee = $1
       union all
       select format('%s.%s() %s', routine_schema, routine_name, privilege_type)
         from information_schema.routine_privileges where grantee = $1
       union all
       select 'owns ' || relname from pg_class where relowner = (select oid from pg_roles where rolname = $1)
       order by 1`,
      [DRILL_ROLE],
    );
    expect(held.map((row) => row.held)).toStrictEqual(['ops.record_tested_restore() EXECUTE']);
  });

  it('C55 last tested restore: PUBLIC holds nothing on the table or the function, whose path is pinned', async () => {
    const [acl] = await harness.world.db.admin.execute<Record<string, unknown>>(
      `select (select count(*)::int from pg_class c, aclexplode(c.relacl) a
                where c.oid = $1::regclass and a.grantee = 0) as "tablePublic",
              (select count(*)::int from aclexplode(p.proacl) a where a.grantee = 0) as "fnPublic",
              p.proacl is not null as "fnAcl", p.prosecdef as definer, p.proconfig as config
         from pg_proc p where p.oid = 'ops.record_tested_restore()'::regprocedure`,
      [TABLE],
    );
    expect(acl).toStrictEqual({
      tablePublic: 0,
      fnPublic: 0,
      fnAcl: true,
      definer: true,
      config: ['search_path=pg_catalog'],
    });
  });
});

describe.skipIf(serverUrl === undefined)('C55 isolation', () => {
  it('C55 isolation: a member without operations:read, a client share and a delegated agent never see the last tested restore', async () => {
    await drill(harness, 'passed', storeTook('passed'));
    const [row] = await stamped(harness);
    const at = row?.at ?? 'no date';
    for (const token of [harness.world.mia.token, clientToken]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await view(harness, token);
      expect(refused.status).toBe(403);
      expect(refused.code).toBe('SCOPE_NOT_GRANTED');
      expect(refused.body['lastTestedRestore']).toBeUndefined();
      expect(JSON.stringify(refused.body)).not.toContain(at);
    }
    const agent = await call(
      harness.world.api,
      agentPath('alpha', pathOf('operations.read')),
      { operationId: randomUUID() },
      { ...bearer(harness.world.agent.token), [DELEGATION_HEADER]: credential },
    );
    expect(agent.status).toBe(403);
    expect(agent.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(JSON.stringify(agent.body)).not.toContain(at);
    // The holder of the key reads it.
    const noah = await view(harness, harness.world.noah.token);
    expect(noah.body['lastTestedRestore']).toStrictEqual({ at, stale: false });
  });
});
