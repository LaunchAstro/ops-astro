// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3c: the restore drill (ticket S0-3, lines C2, C3 and C8).
//
// `S0-3 bad archive red`: a truncated archive fails the drill, whether it is
// cut after sealing or the dump inside was cut before it; nothing is left
// running either way.
// `S0-3 drill target`: the drill restores only into a container it starts
// itself, with no network, of the production major; it takes no target, and an
// image of another major is refused before anything is restored. The drill's
// record names the Postgres major on both sides.
// `S0-3 backup encryption`: a backup is sealed to the operator's public key
// before it leaves the job, so the store and the wire hold only ciphertext;
// only the private key, held apart from the store, opens it; the drill restores
// from the sealed artefact and refuses a plain dump. (The store's half, write
// only for the backup identity and every read logged, is in
// tests/db/backup-store-encryption.test.ts under the same name.)
//
// `S0-3 drill scope` (Sol's review 2, criterion 4, as the orchestrator ruled):
// the backup and the restored copy stay whole, and the drill reads the copy
// only as the tenancy role under one named business, client and person, with
// the business barrier (forced row security) in force. A copy where the
// barrier did not survive fails, and so does a person or client of another
// business named under this one.
//
// Runs wherever Docker runs, CI's hosted runner included. The fixture is a
// real pg_dump of made-up rows, taken in a container of staging's own image.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type DrillRecord = Record<string, unknown> & { outcome: string; stage?: string };
type Docker = (args: string[], input?: Buffer) => Promise<{ code: number; stdout: string }>;
type Archive = { takenAt: string; body: Buffer };
type Scope = { business: string; client: string; person: string };

const drillModule = async (): Promise<{
  restoreDrill: (options: {
    fetchArchive: () => Promise<Archive>;
    privateKey: string;
    scope: Scope;
    docker?: Docker;
    image?: string;
  }) => Promise<DrillRecord>;
  docker: Docker;
}> => {
  const path = '../../scripts/ops/restore-drill.mjs';
  return await import(
    /* @vite-ignore */
    path
  );
};
const sealModule = async (): Promise<{
  sealArchive: (dump: Buffer, publicKey: string) => Buffer;
  openArchive: (sealed: Buffer, privateKey: string) => Buffer;
}> => {
  const path = '../../scripts/ops/archive-seal.mjs';
  return await import(
    /* @vite-ignore */
    path
  );
};

const staging = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as {
  'x-ops-astro': { ownPrefix: string; productionDatabaseMajor: number };
  services: { db: { image: string } };
};
const IMAGE = staging.services.db.image;
const PRODUCTION_MAJOR = staging['x-ops-astro'].productionDatabaseMajor;
// Postgres 18 by digest: CI's own service image (.github/workflows/ci.yml).
const OTHER_MAJOR_IMAGE =
  'postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const DRILL_PREFIX = `${staging['x-ops-astro'].ownPrefix}-drill-`;
const MADE_UP = `made-up-business-${randomBytes(4).toString('hex')}`;
// Two businesses, each with a person and a client (an external party, a
// person of the business with no membership). The drill is scoped to A.
const A = { business: randomUUID(), person: randomUUID(), client: randomUUID() };
const B = { business: randomUUID(), person: randomUUID(), client: randomUUID() };
const SCOPE: Scope = A;
// A second pair in A with its own grant, a client A.person's grant over which
// is revoked, and a person with a grant over A.client but no membership.
const A2 = {
  person: randomUUID(),
  client: randomUUID(),
  revoked: randomUUID(),
  outsider: randomUUID(),
  derived: randomUUID(),
  // Clients A.person holds the wrong grant over, and two business-scope managers.
  wrongAction: randomUUID(),
  wrongCollection: randomUUID(),
  manager: randomUUID(),
  taskManager: randomUUID(),
};
// A root grant over A2.derived, revoked, and a grant A.person holds from it.
const ROOT = randomUUID();
// An agent's actor acting for A.person under a live delegation (migration 0008).
const AGENT = randomUUID();

const hasDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
if (!hasDocker) console.warn('ci/restore-drill: Docker is not running, so nothing below ran.');

function run(args: string[], input?: Buffer): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks) }));
    child.stdin.end(input);
  });
}

/** The product's business barrier on one table (migrations/0001_tenancy.sql). */
const barrier = (table: string): string => `
  alter table public.${table} enable row level security;
  alter table public.${table} force row level security;
  create policy tenancy_${table} on public.${table} as restrictive for all
    using (business_id = (select public.app_business_id()));
  create policy authority_${table} on public.${table} as permissive for all using (true);`;

/**
 * A real custom-format dump of made-up rows, as the backup job takes one, in
 * the product's tenancy shape (migrations/0001_tenancy.sql): a restrictive,
 * forced business barrier on every table. `unbarred` is the same data dumped
 * after the barrier was taken off.
 */
async function fixtureDump(): Promise<{ dump: Buffer; unbarred: Buffer }> {
  const name = `ops-astro-test-fixture-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  await run([
    'run',
    '-d',
    '--rm',
    '--network',
    'none',
    '--name',
    name,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_DB=fixture',
    IMAGE,
  ]);
  try {
    for (let i = 0; i < 120; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const ready = await run([
        'exec',
        name,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'fixture',
      ]);
      if (ready.code === 0) break;
      // oxlint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, 500);
      });
    }
    const sql = `
      create schema ops;
      create table ops.schema_migrations (version text primary key, checksum text not null);
      insert into ops.schema_migrations values ('0033', 'a'), ('0034', 'b');
      create function public.app_business_id() returns uuid language sql stable
        as $$ select nullif(current_setting('app.business_id', true), '')::uuid $$;
      create table public.businesses (business_id uuid not null, id uuid primary key, name text not null);
      insert into public.businesses values ('${A.business}', '${A.business}', 'made-up A'),
        ('${B.business}', '${B.business}', 'made-up B');
      insert into public.businesses select u, u, '${MADE_UP}-' || g
        from (select gen_random_uuid() as u, g from generate_series(1, 2000) g) s;
      create table public.people (business_id uuid not null, id uuid primary key, name text not null);
      insert into public.people values ('${A.business}', '${A.person}', 'made-up person A'),
        ('${A.business}', '${A.client}', 'made-up client A'), ('${B.business}', '${B.person}', 'made-up person B'),
        ('${B.business}', '${B.client}', 'made-up client B'), ('${A.business}', '${A2.person}', 'made-up person A2'),
        ('${A.business}', '${A2.client}', 'made-up client A2'), ('${A.business}', '${A2.revoked}', 'made-up client A3'),
        ('${A.business}', '${A2.outsider}', 'made-up outsider A'),
        ('${A.business}', '${A2.derived}', 'made-up client A4'),
        ('${A.business}', '${A2.wrongAction}', 'made-up client A5'),
        ('${A.business}', '${A2.wrongCollection}', 'made-up client A6'),
        ('${A.business}', '${A2.manager}', 'made-up manager A'),
        ('${A.business}', '${A2.taskManager}', 'made-up task manager A');
      create table public.memberships (business_id uuid not null, id uuid primary key default gen_random_uuid(),
        person_id uuid not null, active boolean not null default true);
      insert into public.memberships (business_id, person_id) values ('${A.business}', '${A.person}'),
        ('${A.business}', '${A2.person}'), ('${A.business}', '${A2.manager}'), ('${A.business}', '${A2.taskManager}'), ('${B.business}', '${B.person}');
      create table public.grants (business_id uuid not null, id uuid primary key default gen_random_uuid(),
        subject_kind text not null, subject_id uuid not null, scope_kind text not null, scope_id uuid,
        collection text not null default 'person', action text not null, can_delegate boolean not null default false,
        may_permit_delegation boolean not null default false, parent_grant_id uuid,
        expires_at timestamptz, revoked_at timestamptz);
      insert into public.grants (business_id, subject_kind, subject_id, scope_kind, scope_id, action, revoked_at) values
        ('${A.business}', 'person', '${A.person}', 'party', '${A.client}', 'read', null),
        ('${A.business}', 'person', '${A2.person}', 'party', '${A2.client}', 'read', null),
        ('${A.business}', 'person', '${A.person}', 'party', '${A2.revoked}', 'read', now()),
        ('${A.business}', 'person', '${A2.outsider}', 'party', '${A.client}', 'read', null),
        ('${B.business}', 'person', '${B.person}', 'party', '${B.client}', 'read', null);
      insert into public.grants (business_id, id, subject_kind, subject_id, scope_kind, scope_id, action,
        can_delegate, parent_grant_id, revoked_at) values
        ('${A.business}', '${ROOT}', 'person', '${A2.person}', 'party', '${A2.derived}', 'read', true, null, now()),
        ('${A.business}', gen_random_uuid(), 'person', '${A.person}', 'party', '${A2.derived}', 'read', false, '${ROOT}', null);
      insert into public.grants (business_id, subject_kind, subject_id, scope_kind, scope_id, collection, action) values
        ('${A.business}', 'person', '${A.person}', 'party', '${A2.wrongAction}', 'person', 'comment'),
        ('${A.business}', 'person', '${A.person}', 'party', '${A2.wrongCollection}', 'task', 'read'),
        ('${A.business}', 'person', '${A2.manager}', 'business', null, 'person', 'manage'),
        ('${A.business}', 'person', '${A2.taskManager}', 'business', null, 'task', 'manage');
      create table public.delegations (business_id uuid not null, id uuid primary key default gen_random_uuid(),
        agent_actor_id uuid not null, delegate_person_id uuid not null, revoked_at timestamptz);
      insert into public.delegations (business_id, agent_actor_id, delegate_person_id) values
        ('${A.business}', '${AGENT}', '${A.person}');
      create table public.tasks (business_id uuid not null, id int primary key, title text);
      insert into public.tasks select '${A.business}', g, repeat('made-up task ', 20) from generate_series(1, 4000) g;
      ${['businesses', 'people', 'memberships', 'grants', 'delegations', 'tasks'].map((table) => barrier(table)).join('\n')}`;
    const created = await run(
      ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fixture'],
      Buffer.from(sql),
    );
    expect(created.code).toBe(0);
    const dump = await run([
      'exec',
      name,
      'pg_dump',
      '--format=custom',
      '--schema=public',
      '--schema=ops',
      '-U',
      'postgres',
      '-d',
      'fixture',
    ]);
    expect(dump.code).toBe(0);
    const unbar = ['businesses', 'people', 'memberships', 'grants', 'delegations', 'tasks']
      .map(
        (t) =>
          `alter table public.${t} no force row level security; alter table public.${t} disable row level security;`,
      )
      .join(' ');
    const off = await run(
      ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'fixture'],
      Buffer.from(unbar),
    );
    expect(off.code).toBe(0);
    const unbarred = await run([
      'exec',
      name,
      'pg_dump',
      '--format=custom',
      '--schema=public',
      '--schema=ops',
      '-U',
      'postgres',
      '-d',
      'fixture',
    ]);
    expect(unbarred.code).toBe(0);
    return { dump: dump.stdout, unbarred: unbarred.stdout };
  } finally {
    await run(['rm', '-f', '-v', name]);
  }
}

async function drillContainers(): Promise<string> {
  const listed = await run([
    'ps',
    '-a',
    '--filter',
    `name=${DRILL_PREFIX}`,
    '--format',
    '{{.Names}}',
  ]);
  return listed.stdout.toString().trim();
}

const keys = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const takenAt = '2026-09-29T02:00:00.000Z';

let dump: Buffer;

let sealed: Buffer;

let unbarred: Buffer;

describe.skipIf(!hasDocker)('the restore drill', () => {
  beforeAll(async () => {
    ({ dump, unbarred } = await fixtureDump());
    sealed = (await sealModule()).sealArchive(dump, keys.publicKey);
  }, 180_000);

  afterAll(async () => {
    expect(await drillContainers()).toBe('');
  });

  theRestoreDrillCases1();
  theRestoreDrillCases2();
  theRestoreDrillCases3();
  theRestoreDrillCases4();
});

function theRestoreDrillCases1() {
  describe('S0-3 backup encryption', () => {
    it('seals the dump so the stored bytes carry none of it, and only the private key opens it', async () => {
      const { sealArchive, openArchive } = await sealModule();
      expect(dump.subarray(0, 5).toString()).toBe('PGDMP');
      expect(sealed.includes(Buffer.from('PGDMP'))).toBe(false);
      expect(sealed.includes(Buffer.from(MADE_UP))).toBe(false);
      expect(openArchive(sealed, keys.privateKey).equals(dump)).toBe(true);
      // Two seals of one dump differ: a fresh key and nonce each time.
      expect(sealArchive(dump, keys.publicKey).equals(sealed)).toBe(false);

      const other = generateKeyPairSync('rsa', {
        modulusLength: 3072,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      expect(() => openArchive(sealed, other.privateKey)).toThrow();
      expect(() => openArchive(dump, keys.privateKey)).toThrow();
      // Tampering with any byte after the header is refused, not restored.
      const tampered = Buffer.from(sealed);
      tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
      expect(() => openArchive(tampered, keys.privateKey)).toThrow();
    });

    it('restores from the sealed artefact, and refuses a plain dump before starting anything', async () => {
      const { restoreDrill, docker } = await drillModule();
      const passed = await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
        scope: SCOPE,
      });
      expect(passed).toMatchObject({
        event: 'restore drill',
        outcome: 'passed',
        archiveTakenAt: takenAt,
      });

      const calls: string[][] = [];
      const plain = await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: dump }),
        privateKey: keys.privateKey,
        scope: SCOPE,
        docker: (args, input) => {
          calls.push(args);
          return docker(args, input);
        },
      });
      expect(plain).toMatchObject({ outcome: 'failed', stage: 'open' });
      expect(calls).toEqual([]);
    }, 180_000);
  });
}

function theRestoreDrillCases2() {
  describe('S0-3 bad archive red', () => {
    badArchiveRedCases1();
    badArchiveRedCases2();
  });
}

function badArchiveRedCases1() {
  it('fails an archive cut after sealing, and starts no container', async () => {
    const { restoreDrill } = await drillModule();
    const record = await restoreDrill({
      fetchArchive: async () => ({
        takenAt,
        body: sealed.subarray(0, Math.floor(sealed.length / 2)),
      }),
      privateKey: keys.privateKey,
      scope: SCOPE,
    });
    expect(record).toMatchObject({ event: 'restore drill', outcome: 'failed', stage: 'open' });
  });

  it('fails a sealed archive whose dump was cut before sealing, and leaves nothing running', async () => {
    const { restoreDrill } = await drillModule();
    const { sealArchive } = await sealModule();
    const cut = sealArchive(dump.subarray(0, dump.length - 4096), keys.publicKey);
    const record = await restoreDrill({
      fetchArchive: async () => ({ takenAt, body: cut }),
      privateKey: keys.privateKey,
      scope: SCOPE,
    });
    expect(record).toMatchObject({ event: 'restore drill', outcome: 'failed', stage: 'restore' });
    expect(Object.keys(record).toSorted()).toEqual(
      [
        'archiveTakenAt',
        'at',
        'event',
        'outcome',
        'productionMajor',
        'sourceMajor',
        'stage',
        'target',
        'targetMajor',
        'timings',
      ].toSorted(),
    );
    expect(await drillContainers()).toBe('');
  }, 120_000);
}

function badArchiveRedCases2() {
  it('fails when the archive cannot be fetched, naming the stage and nothing else', async () => {
    const { restoreDrill } = await drillModule();
    const canary = `canary-${randomBytes(6).toString('hex')}`;
    const record = await restoreDrill({
      fetchArchive: async () => {
        throw new Error(`password ${canary} rejected at /var/lib/ops-keys/restore.pem`);
      },
      privateKey: keys.privateKey,
      scope: SCOPE,
    });
    expect(record).toMatchObject({ outcome: 'failed', stage: 'fetch' });
    expect(JSON.stringify(record)).not.toContain(canary);
    expect(JSON.stringify(record)).not.toContain('/var/lib/');
  });
}

function theRestoreDrillCases3() {
  describe('S0-3 drill target', () => {
    drillTargetCases1();
    drillTargetCases2();
  });
}

function drillTargetCases1() {
  // prettier-ignore
  it('restores only into its own networkless container of the production major, and records both majors', async () => {
      const { restoreDrill, docker } = await drillModule();
      const calls: string[][] = [];
      const record = await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
        scope: SCOPE,
        docker: (args, input) => {
          calls.push(args);
          return docker(args, input);
        },
      });
      expect(record).toMatchObject({
        event: 'restore drill',
        outcome: 'passed',
        target: 'throwaway container',
        sourceMajor: PRODUCTION_MAJOR,
        targetMajor: PRODUCTION_MAJOR,
        productionMajor: PRODUCTION_MAJOR,
        tables: 7,
        readAs: 'ops_astro_app',
      });
      const timings = record['timings'] as Record<string, number>;
      expect(Object.keys(timings)).toEqual(['fetch', 'open', 'start', 'restore', 'check']);

      const [first, ...rest] = calls;
      expect(first?.slice(0, 5)).toEqual(['run', '-d', '--rm', '--network', 'none']);
      expect(first?.at(-1)).toBe(IMAGE);
      expect(
        first?.some((arg) => /^(-p|--publish|-v|--volume|--mount|--add-host)$/u.test(arg)),
      ).toBe(false);
      const name = first?.[first.indexOf('--name') + 1] ?? '';
      expect(name.startsWith(DRILL_PREFIX)).toBe(true);
      for (const call of rest) {
        expect(['exec', 'rm']).toContain(call[0]);
        expect(call).toContain(name);
      }
      // Removed with its volumes, and its data kept in memory.
      expect(rest.at(-1)).toEqual(['rm', '-f', '-v', name]);
      expect(first?.[first.indexOf('--tmpfs') + 1]).toBe('/var/lib/postgresql/drill');
      expect(first).toContain('PGDATA=/var/lib/postgresql/drill');
      // No call names a host, a port or a connection string: there is no
      // target to point anywhere else.
      expect(calls.flat().join(' ')).not.toMatch(/postgres(ql)?:\/\/|--host|supabase/iu);
    }, 120_000);
}

function drillTargetCases2() {
  it('refuses an image of another major before restoring anything', async () => {
    const { restoreDrill } = await drillModule();
    const record = await restoreDrill({
      fetchArchive: async () => ({ takenAt, body: sealed }),
      privateKey: keys.privateKey,
      scope: SCOPE,
      image: OTHER_MAJOR_IMAGE,
    });
    expect(record).toMatchObject({
      outcome: 'failed',
      stage: 'target',
      productionMajor: PRODUCTION_MAJOR,
    });
    expect(record['targetMajor']).not.toBe(PRODUCTION_MAJOR);
    expect(record['tables']).toBeUndefined();
  }, 120_000);

  it('takes no target from its command line or environment', () => {
    const source = readFileSync(
      new URL('../../scripts/ops/restore-drill.mjs', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/DATABASE_URL|SUPABASE|--host|PGHOST/u);
    expect(source).toMatch(/--network none /u);
  });
}

function theRestoreDrillCases4() {
  describe('S0-3 drill scope', () => {
    drillScopeCases1();
    drillScopeCases2();
    drillScopeCases3();
    drillScopeCases4();
    drillScopeCases5();
    drillScopeCases6();
  });
}

function drillScopeCases1() {
  it('reads the restored copy only as the tenancy role, under the named business', async () => {
    const { restoreDrill, docker } = await drillModule();
    const calls: string[][] = [];
    const record = await restoreDrill({
      fetchArchive: async () => ({ takenAt, body: sealed }),
      privateKey: keys.privateKey,
      scope: SCOPE,
      docker: (args, input) => {
        calls.push(args);
        return docker(args, input);
      },
    });
    expect(record).toMatchObject({ outcome: 'passed', readAs: 'ops_astro_app', tables: 7 });
    // Every statement that reads the copy's tables runs as the tenancy role
    // under the named business; the owner session never reads one.
    const reads = calls.filter(
      (c) => c.includes('psql') && /from (public|ops)\./u.test(c.join(' ')),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const call of reads) {
      const text = call.join(' ');
      expect(text).toContain('set role ops_astro_app');
      expect(text).toContain(`set app.business_id = '${A.business}'`);
      expect(text.indexOf('set role ops_astro_app')).toBeLessThan(
        text.search(/from (public|ops)\./u),
      );
    }
    // No id or row reaches the record.
    for (const id of [...Object.values(A), ...Object.values(A2), ...Object.values(B)])
      expect(JSON.stringify(record)).not.toContain(id);
  }, 120_000);
}

function drillScopeCases2() {
  it('fails a person or a client of another business named under this one', async () => {
    const { restoreDrill } = await drillModule();
    for (const scope of [
      { ...A, person: B.person },
      { ...A, client: B.client },
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const record = await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
        scope,
      });
      expect(record).toMatchObject({ outcome: 'failed', stage: 'check' });
    }
  }, 180_000);
}

function drillScopeCases3() {
  it("accepts a person and client only through the person's current grant over that client", async () => {
    const { restoreDrill } = await drillModule();
    const drill = async (scope: Scope): Promise<DrillRecord> =>
      await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
        scope,
      });
    // The second pair passes on its own grant, and the people manager on the owning relationship.
    expect(
      await drill({ business: A.business, person: A2.manager, client: A2.client }),
    ).toMatchObject({
      outcome: 'passed',
    });
    expect(
      await drill({ business: A.business, person: A2.person, client: A2.client }),
    ).toMatchObject({
      outcome: 'passed',
    });
    for (const scope of [
      { business: A.business, person: A.person, client: A2.client }, // the other pair's client
      { business: A.business, person: A2.person, client: A.client }, // the other pair's person
      { business: A.business, person: A.person, client: A2.revoked }, // a revoked grant
      { business: A.business, person: A2.outsider, client: A.client }, // a grant but no membership
      { business: A.business, person: A.person, client: A2.derived }, // its granter's grant revoked
      { business: A.business, person: A.person, client: A2.wrongAction }, // a comment grant
      { business: A.business, person: A.person, client: A2.wrongCollection }, // another collection's read
      { business: A.business, person: A2.taskManager, client: A.client }, // a manager of another collection
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await drill(scope)).toMatchObject({ outcome: 'failed', stage: 'check' });
    }
  }, 300_000);
}

function drillScopeCases4() {
  it('S0-3 isolation: three crossings, each failed at the check, beside the one that passes', async () => {
    const { restoreDrill } = await drillModule();
    const drill = async (scope: Scope): Promise<DrillRecord> =>
      await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
        scope,
      });
    expect(await drill(A)).toMatchObject({ outcome: 'passed' });
    const crossings: Record<string, Scope> = {
      'another business': { ...A, client: B.client },
      'another client in the same business': { ...A, client: A2.client },
      'another person under a live delegation': { ...A, person: AGENT },
    };
    for (const [name, scope] of Object.entries(crossings)) {
      // oxlint-disable-next-line no-await-in-loop
      const record = await drill(scope);
      expect(record, name).toMatchObject({ outcome: 'failed', stage: 'check' });
      expect(record, name).not.toHaveProperty('tables');
    }
  }, 300_000);
}

function drillScopeCases5() {
  it('S0-3 canary: no record content, name or id reaches a passed or a failed receipt', async () => {
    const { restoreDrill } = await drillModule();
    const records = [];
    for (const scope of [A, { ...A, client: B.client }]) {
      // oxlint-disable-next-line no-await-in-loop
      const record = await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
        scope,
      });
      records.push(record);
    }
    expect(records.map((r) => r.outcome)).toStrictEqual(['passed', 'failed']);
    const text = JSON.stringify(records);
    for (const planted of [
      MADE_UP,
      'made-up',
      AGENT,
      ROOT,
      ...Object.values(A),
      ...Object.values(A2),
      ...Object.values(B),
    ]) {
      expect(text).not.toContain(planted);
    }
    expect(text).not.toMatch(/PRIVATE KEY|postgres:\/\/|\/Users\/|\/var\/|\/tmp\//u);
  }, 180_000);

  it('fails a copy where the business barrier did not survive', async () => {
    const { restoreDrill } = await drillModule();
    const { sealArchive } = await sealModule();
    const record = await restoreDrill({
      fetchArchive: async () => ({ takenAt, body: sealArchive(unbarred, keys.publicKey) }),
      privateKey: keys.privateKey,
      scope: SCOPE,
    });
    expect(record).toMatchObject({ outcome: 'failed', stage: 'check' });
  }, 120_000);
}

function drillScopeCases6() {
  it('refuses a scope that is not three ids before starting anything', async () => {
    const { restoreDrill, docker } = await drillModule();
    const calls: string[][] = [];
    const record = await restoreDrill({
      fetchArchive: async () => ({ takenAt, body: sealed }),
      privateKey: keys.privateKey,
      scope: { ...A, person: "x' or true --" },
      docker: (args, input) => {
        calls.push(args);
        return docker(args, input);
      },
    });
    expect(record).toMatchObject({ outcome: 'failed', stage: 'scope' });
    expect(calls).toEqual([]);
  });
}
