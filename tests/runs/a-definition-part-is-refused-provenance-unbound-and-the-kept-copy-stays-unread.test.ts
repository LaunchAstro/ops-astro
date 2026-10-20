// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, the definition part: the run's kept copy of a pinned file stays
// insert-only for the application (0086), so the broker never reads it back,
// and a turn that names a definition is refused `PROVENANCE_UNBOUND` at
// binding, never a server error. Proof by Sol (GPT-6.1-Sol), review of #1900,
// finding S1900-1; assertions unchanged.
//
// #1904 P14 keeps it: the part carries `text` now, and the two assertions
// stand. Added: the catalogue shows no run role holds anything on the copy
// but 0086's insert, and no function in the database reads from it.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { asAgent, s, signedIn, useDoorWorld } from './run-stop-door-world.ts';
import { taskPart, turnBody, turnBroker } from './turn-world.ts';

/** The catalogue, read by the owner: what the run roles may do with the copy, and who reads it. */
async function noRunRoleReadsTheCopy(): Promise<void> {
  // Mutation: grant select on `bootstrap_bytes` to `ops_astro_app` -> a privilege listed, red.
  const granted = await s.db.admin.execute<{ role: string; privilege: string }>(
    `select r.rolname as role, p.privilege
       from pg_roles r
      cross join unnest(array['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
                              'TRIGGER']) as p(privilege)
      where r.rolname in ('ops_astro_app', 'ops_astro_broker', 'ops_astro_worker')
        and has_table_privilege(r.oid, 'public.bootstrap_bytes', p.privilege)
     union all
     select r.rolname, 'SELECT (a column)'
       from pg_roles r
      where r.rolname in ('ops_astro_app', 'ops_astro_broker', 'ops_astro_worker')
        and has_any_column_privilege(r.oid, 'public.bootstrap_bytes', 'SELECT')`,
  );
  expect(granted).toEqual([]);
  const [insert] = await s.db.admin.execute<{ granted: boolean }>(
    `select has_table_privilege('ops_astro_app', 'public.bootstrap_bytes', 'INSERT') as granted`,
  );
  expect(insert?.granted, "0086's insert stands").toBe(true);
  const readers = await s.db.admin.execute<{ name: string }>(
    `select p.oid::regprocedure::text as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
        and p.prosrc ~* '(from|join)\\s+(public\\.)?bootstrap_bytes'`,
  );
  expect(readers).toEqual([]);
}

describe.skipIf(serverUrl === undefined)('a definition part', () => {
  useDoorWorld('r3definition', turnBroker(3));

  it('is refused PROVENANCE_UNBOUND, and the kept copy stays unreadable to the application', async () => {
    const work = await liveWork(s, 'r3 definition', 2000);
    const as = await signedIn();
    await expect(
      s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await tx.query('select bytes from public.bootstrap_bytes where business_id = $1', [
            s.business,
          ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const answer = await asAgent(
      '/model/call',
      work,
      turnBody(work, 0, [
        { ref: 'definition', path: 'AGENTS.md', digest: '0'.repeat(64), text: 'x' },
        await taskPart(work),
      ]),
      as,
    );
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('PROVENANCE_UNBOUND');
  }, 60000);

  it(
    'has no grant beyond 0086 insert for a run role, and no function reads from it',
    noRunRoleReadsTheCopy,
    60000,
  );
});
