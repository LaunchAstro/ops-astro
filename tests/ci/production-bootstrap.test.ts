// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's bootstrap, on a new migrated database: it refuses when any
// business is already there, and writes everything in one transaction: the
// business, its owner's person, actor, login and membership, the local seed's
// admin grants plus `operations:manage`, the operating business and the
// installation's operator. No made-up row, and the installation mode stays as
// the migrations leave it. The sign-in itself is the operator's step.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { standingOf } from '../../packages/core-records/src/identity/login-resolution.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { madeUpSeedSigns } from '../../scripts/ops/made-up-only.ts';
import { bootstrap, type Owner } from '../../scripts/ops/production-bootstrap.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import {
  COMMAND,
  OWNER_SET,
  ownerArgs,
  POOLER,
  PRODUCTION,
  SETTINGS,
} from './production-bootstrap.fixture.ts';

const POOLER_AT_LOOPBACK = new URL('../support/pooler-at-loopback.mjs', import.meta.url).pathname;
const PLAINTEXT_AT_LOOPBACK = new URL('../support/plaintext-at-loopback.mjs', import.meta.url)
  .pathname;
const serverUrl = databaseUrlFromEnvironment();
const live = it.skipIf(serverUrl === undefined);

const OWNER: Owner = {
  businessKey: 'harbour-joinery',
  businessName: 'Harbour Joinery',
  ownerName: 'Robin Harbour',
  ownerSubject: randomUUID(),
};

const ROWS = [
  'public.businesses',
  'public.people',
  'public.actors',
  'public.logins',
  'public.person_logins',
  'public.memberships',
  'public.grants',
  'public.record_types',
  'ops.operating_business',
];

async function onNewDatabase(run: (db: FreshDatabase) => Promise<void>): Promise<void> {
  const db = await createFreshDatabase({ part: 'prodboot' });
  try {
    await run(db);
  } finally {
    await db.drop();
  }
}

async function count(db: FreshDatabase, table: string): Promise<number> {
  const [row] = await db.admin.execute<{ n: number }>(`select count(*)::int as n from ${table}`);
  return row?.n ?? -1;
}

async function installation(db: FreshDatabase): Promise<unknown> {
  const [row] = await db.admin.execute(
    'select operator_business_id as operator, mode from ops.installation',
  );
  return row;
}

function named(grants: readonly (readonly (string | undefined)[])[]): string[] {
  return grants.map((grant) => grant.join(':')).toSorted();
}

live('makes the business and its owner, who signs in as its admin', async () => {
  await onNewDatabase(async (db) => {
    const made = await bootstrap(db.admin, OWNER);
    expect(await db.admin.execute('select id, key, name from public.businesses')).toEqual([
      { id: made.businessId, key: 'harbour-joinery', name: 'Harbour Joinery' },
    ]);
    expect(await installation(db)).toStrictEqual({ operator: made.businessId, mode: 'made-up' });
    expect(
      await db.admin.execute('select operating_business as id from ops.operating_business'),
    ).toEqual([{ id: made.businessId }]);
    const standing = await db.app.withBusiness(made.businessId, (tx) =>
      standingOf(tx, { provider: 'supabase', subject: OWNER.ownerSubject }, 'enrolling'),
    );
    expect(standing).toMatchObject({ businessId: made.businessId, roleKey: 'admin' });
    expect(await db.admin.execute('select display_name from public.people')).toEqual([
      { display_name: 'Robin Harbour' },
    ]);
    expect(await count(db, "public.record_types where key = 'task'")).toBe(1);
  });
});

live('grants the owner the local seed’s admin set plus operations:manage, each once', async () => {
  await onNewDatabase(async (db) => {
    await bootstrap(db.admin, OWNER);
    const held = await db.admin.execute<{ collection: string; action: string }>(
      `select g.collection, g.action from public.grants g
         join public.people p on p.id = g.subject_id
        where g.subject_kind = 'person' and g.scope_kind = 'business' and g.revoked_at is null`,
    );
    expect(named(held.map(({ collection, action }) => [collection, action]))).toStrictEqual(
      named(OWNER_SET),
    );
    expect(await count(db, 'public.grants')).toBe(OWNER_SET.length);
  });
});

live('writes no made-up row: one business, one person, no seed mark', async () => {
  await onNewDatabase(async (db) => {
    await bootstrap(db.admin, OWNER);
    for (const table of ROWS.slice(0, 6))
      // oxlint-disable-next-line no-await-in-loop
      expect(await count(db, table), table).toBe(1);
    expect(await madeUpSeedSigns(db.admin)).toStrictEqual([]);
  });
});

live('refuses when a business already exists, and writes nothing', async () => {
  await onNewDatabase(async (db) => {
    await db.admin.execute(
      `insert into public.businesses (business_id, id, key, name) values ($1, $1, 'there', 'There')`,
      [randomUUID()],
    );
    await expect(bootstrap(db.admin, OWNER)).rejects.toThrow('a business already exists');
    expect(await count(db, 'public.businesses')).toBe(1);
    expect(await count(db, 'public.people')).toBe(0);
    expect(await count(db, 'ops.operating_business')).toBe(0);
  });
});

live('leaves nothing behind when a step fails partway', async () => {
  await onNewDatabase(async (db) => {
    await db.admin.execute(
      `create function public.refuse_membership() returns trigger language plpgsql as
         $$ begin raise exception 'membership refused'; end $$`,
    );
    await db.admin.execute(
      `create trigger refuse_membership before insert on public.memberships
         for each row execute function public.refuse_membership()`,
    );
    await expect(bootstrap(db.admin, OWNER)).rejects.toThrow('membership refused');
    for (const table of ROWS)
      // oxlint-disable-next-line no-await-in-loop
      expect(await count(db, table), table).toBe(0);
    expect(await installation(db)).toStrictEqual({ operator: null, mode: 'made-up' });
  });
});

/** The command, through an admin address on production's project, as a person runs it. */
function runCommand(adminUrl: string): { status: number | null; printed: string } {
  const preloads = [`--import=${POOLER_AT_LOOPBACK}`, `--import=${PLAINTEXT_AT_LOOPBACK}`];
  const result = spawnSync(process.execPath, [...preloads, COMMAND, ...ownerArgs()], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...SETTINGS, DATABASE_ADMIN_URL: adminUrl },
  });
  return { status: result.status, printed: `${result.stdout}${result.stderr}` };
}

live(
  'the command bootstraps production’s database once and refuses a second run',
  async () => {
    const login = `own_${randomBytes(4).toString('hex')}.${PRODUCTION}`;
    const password = `${TEST_ONLY_MARKER}-${randomBytes(18).toString('hex')}`;
    const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
    // The hosted admin owns every object the migrations made; here the throwaway
    // server's own superuser did, so the stand-in is one too.
    await server.execute(`create role "${login}" login superuser password '${password}'`);
    try {
      await onNewDatabase(async (db) => {
        const url = new URL(serverUrl ?? '');
        Object.assign(url, { hostname: POOLER, username: login, password });
        url.pathname = `/${db.name}`;
        url.search = '?sslmode=require';
        const first = runCommand(url.toString());
        expect(first.printed).toContain('production-bootstrap: done');
        expect(first.status).toBe(0);
        expect(first.printed).not.toContain(password);
        const second = runCommand(url.toString());
        expect(second.status).toBe(1);
        expect(second.printed).toContain('refused: a business already exists');
        expect(await count(db, 'public.businesses')).toBe(1);
      });
    } finally {
      await server.execute(`drop role if exists "${login}"`);
      await server.close();
    }
  },
  60_000,
);
