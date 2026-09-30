// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3b: `S0-3 identity scope`, continued: the grants the backup identity
// holds on later tables, and Sol's criterion 4 proofs on the drill's scope.
//
// S0-3 (lines C1 and C11). The shared fixture is backup-identity.fixture.ts.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import {
  serverUrl,
  BACKUP,
  keys,
  drill,
  seal,
  loginIn,
  dropLogins,
} from './backup-identity.fixture.ts';

let db: FreshDatabase;
let login: { url: string; name: string };

describe.skipIf(serverUrl === undefined)('S0-3 identity scope', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 's03b' });
    login = await loginIn(db, BACKUP);
  }, 120_000);

  afterAll(async () => {
    await dropLogins(
      db,
      [login?.name].filter((n): n is string => n !== undefined),
    );
  });

  identityScopeCases4();
  identityScopeCases5();
  identityScopeCases6();
});

function identityScopeCases4() {
  it('holds select on tables the migrations add later, and nothing more', async () => {
    await db.admin.execute('create table public.s03b_later (id integer primary key)');
    const [grants] = await db.admin.execute<{ privileges: string[] }>(
      `select coalesce(array_agg(privilege_type::text order by privilege_type), '{}') as privileges
         from information_schema.role_table_grants
        where grantee = $1 and table_schema = 'public' and table_name = 's03b_later'`,
      [BACKUP],
    );
    expect(grants?.privileges).toStrictEqual(['SELECT']);
    await db.admin.execute('drop table public.s03b_later');
  });
}

/* eslint-disable max-lines-per-function -- one test, its body kept byte for byte */
function identityScopeCases5() {
  it('a same-business ungranted client and person fail the drill', async () => {
    const business = randomUUID();
    const owner = randomUUID();
    const ownClient = randomUUID();
    const otherClient = randomUUID();
    const otherPerson = randomUUID();
    await db.admin.execute(
      `insert into public.businesses (business_id, id, key, name)
       values ($1, $1, 'sol-s03c', 'Sol S0-3c')`,
      [business],
    );
    await db.admin.execute(
      `insert into public.people (business_id, id, display_name)
       values ($1, $2, 'owner'), ($1, $3, 'own client'),
              ($1, $4, 'other client'), ($1, $5, 'other person')`,
      [business, owner, ownClient, otherClient, otherPerson],
    );
    const url = new URL(serverUrl ?? '');
    url.pathname = `/${db.name}`;
    const sealed = (await seal()).sealArchive(Buffer.from('PGDMP drill proof'), keys.publicKey);
    const { restoreDrill } = await drill();
    let scopedRead = '';
    const run = async (args: string[]): Promise<{ code: number; stdout: string }> => {
      if (args.includes('pg_isready')) return { code: 0, stdout: '' };
      if (args.includes('pg_restore')) {
        return {
          code: 0,
          stdout: args.includes('--list')
            ? 'Dumped from database version: 17\n1; 0 0 TABLE DATA public businesses postgres\n'
            : '',
        };
      }
      if (args.includes('psql')) {
        if (args.join(' ').includes('server_version_num')) return { code: 0, stdout: '170000' };
        if (args.join(' ').includes('select (select string_agg')) {
          const commands = args.flatMap((arg, index) => (arg === '-c' ? [args[index + 1]] : []));
          const sql = postgres(url.toString(), { max: 1 });
          try {
            for (const command of commands.slice(0, -1)) {
              // oxlint-disable-next-line no-await-in-loop
              await sql.unsafe(command ?? '');
            }
            const rows = await sql.unsafe(commands.at(-1) ?? '').values();
            scopedRead = (rows[0] ?? []).join('|');
            return { code: 0, stdout: scopedRead };
          } finally {
            await sql.end();
          }
        }
      }
      return { code: 0, stdout: '' };
    };
    for (const scope of [
      { business, person: owner, client: otherClient },
      { business, person: otherPerson, client: ownClient },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const record = await restoreDrill({
        fetchArchive: async () => ({ takenAt: new Date().toISOString(), body: sealed }),
        privateKey: keys.privateKey,
        scope,
        docker: run,
      });
      expect(scopedRead).toMatch(/\|1\|2$/u);
      expect.soft(record).toMatchObject({ outcome: 'failed', stage: 'check' });
    }
  });
}
/* eslint-enable max-lines-per-function */

/* eslint-disable max-lines-per-function -- one test, its body kept byte for byte */
function identityScopeCases6() {
  it('a grant for another action or collection cannot authorise the client read', async () => {
    const business = randomUUID();
    const person = randomUUID();
    const client = randomUUID();
    const actor = randomUUID();
    await db.admin.execute(
      `insert into public.businesses (business_id, id, key, name)
       values ($1, $1, 'sol-action', 'Sol grant action')`,
      [business],
    );
    await db.admin.execute(
      `insert into public.people (business_id, id, display_name)
       values ($1, $2, 'person'), ($1, $3, 'client')`,
      [business, person, client],
    );
    await db.admin.execute(
      `insert into public.memberships (business_id, id, person_id, role_key)
       values ($1, $2, $3, 'member')`,
      [business, randomUUID(), person],
    );
    await db.admin.execute(
      `insert into public.actors (business_id, id, kind, person_id)
       values ($1, $2, 'person', $3)`,
      [business, actor, person],
    );
    await db.admin.execute(
      `insert into public.grants
       (business_id, id, subject_kind, subject_id, scope_kind, scope_id,
        collection, action, granted_by_actor_id)
       values ($1, $2, 'person', $3, 'party', $4, 'records', 'comment', $5),
              ($1, $6, 'person', $3, 'party', $4, 'tasks', 'read', $5)`,
      [business, randomUUID(), person, client, actor, randomUUID()],
    );
    const url = new URL(serverUrl ?? '');
    url.pathname = `/${db.name}`;
    const sealed = (await seal()).sealArchive(Buffer.from('PGDMP action proof'), keys.publicKey);
    const { restoreDrill } = await drill();
    let scopedRead = '';
    const run = async (args: string[]): Promise<{ code: number; stdout: string }> => {
      if (args.includes('pg_isready')) return { code: 0, stdout: '' };
      if (args.includes('pg_restore')) {
        return {
          code: 0,
          stdout: args.includes('--list')
            ? 'Dumped from database version: 17\n1; 0 0 TABLE DATA public businesses postgres\n'
            : '',
        };
      }
      if (args.includes('psql')) {
        if (args.join(' ').includes('server_version_num')) return { code: 0, stdout: '170000' };
        if (args.join(' ').includes('select (select string_agg')) {
          const commands = args.flatMap((arg, index) => (arg === '-c' ? [args[index + 1]] : []));
          const sql = postgres(url.toString(), { max: 1 });
          try {
            for (const command of commands.slice(0, -1)) {
              // oxlint-disable-next-line no-await-in-loop
              await sql.unsafe(command ?? '');
            }
            const rows = await sql.unsafe(commands.at(-1) ?? '').values();
            scopedRead = (rows[0] ?? []).join('|');
            return { code: 0, stdout: scopedRead };
          } finally {
            await sql.end();
          }
        }
      }
      return { code: 0, stdout: '' };
    };
    const record = await restoreDrill({
      fetchArchive: async () => ({ takenAt: new Date().toISOString(), body: sealed }),
      privateKey: keys.privateKey,
      scope: { business, person, client },
      docker: run,
    });
    expect(scopedRead).toMatch(/\|[01]\|1\|2$/u);
    expect(record).toMatchObject({ outcome: 'failed', stage: 'check' });
  });
}
/* eslint-enable max-lines-per-function */
