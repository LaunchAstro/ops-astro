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
// tests/db/backup-identity.test.ts under the same name.)
//
// Runs wherever Docker runs, CI's hosted runner included. The fixture is a
// real pg_dump of made-up rows, taken in a container of staging's own image.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type DrillRecord = Record<string, unknown> & { outcome: string; stage?: string };
type Docker = (args: string[], input?: Buffer) => Promise<{ code: number; stdout: string }>;
type Archive = { takenAt: string; body: Buffer };

const drillModule = async (): Promise<{
  restoreDrill: (options: {
    fetchArchive: () => Promise<Archive>;
    privateKey: string;
    docker?: Docker;
    image?: string;
  }) => Promise<DrillRecord>;
  docker: Docker;
}> => {
  const path = '../../scripts/ops/restore-drill.mjs';
  return await import(/* @vite-ignore */ path);
};
const sealModule = async (): Promise<{
  sealArchive: (dump: Buffer, publicKey: string) => Buffer;
  openArchive: (sealed: Buffer, privateKey: string) => Buffer;
}> => {
  const path = '../../scripts/ops/archive-seal.mjs';
  return await import(/* @vite-ignore */ path);
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

/** A real custom-format dump of made-up rows, as the backup job takes one. */
async function fixtureDump(): Promise<Buffer> {
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
      await new Promise((r) => setTimeout(r, 500));
    }
    const sql = `
      create schema ops;
      create table ops.schema_migrations (version text primary key, checksum text not null);
      insert into ops.schema_migrations values ('0033', 'a'), ('0034', 'b');
      create table public.businesses (id int primary key, name text not null);
      insert into public.businesses select g, '${MADE_UP}-' || g from generate_series(1, 2000) g;
      create table public.tasks (id int primary key, business_id int references public.businesses, title text);
      insert into public.tasks select g, 1 + g % 2000, repeat('made-up task ', 20) from generate_series(1, 4000) g;`;
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
    return dump.stdout;
  } finally {
    await run(['rm', '-f', name]);
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

describe.skipIf(!hasDocker)('the restore drill', () => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const takenAt = '2026-09-29T02:00:00.000Z';
  let dump: Buffer;
  let sealed: Buffer;

  beforeAll(async () => {
    dump = await fixtureDump();
    sealed = (await sealModule()).sealArchive(dump, keys.publicKey);
  }, 180_000);

  afterAll(async () => {
    expect(await drillContainers()).toBe('');
  });

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
        docker: (args, input) => {
          calls.push(args);
          return docker(args, input);
        },
      });
      expect(plain).toMatchObject({ outcome: 'failed', stage: 'open' });
      expect(calls).toEqual([]);
    }, 180_000);
  });

  describe('S0-3 bad archive red', () => {
    it('fails an archive cut after sealing, and starts no container', async () => {
      const { restoreDrill } = await drillModule();
      const record = await restoreDrill({
        fetchArchive: async () => ({
          takenAt,
          body: sealed.subarray(0, Math.floor(sealed.length / 2)),
        }),
        privateKey: keys.privateKey,
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

    it('fails when the archive cannot be fetched, naming the stage and nothing else', async () => {
      const { restoreDrill } = await drillModule();
      const canary = `canary-${randomBytes(6).toString('hex')}`;
      const record = await restoreDrill({
        fetchArchive: async () => {
          throw new Error(`password ${canary} rejected at /var/lib/ops-keys/restore.pem`);
        },
        privateKey: keys.privateKey,
      });
      expect(record).toMatchObject({ outcome: 'failed', stage: 'fetch' });
      expect(JSON.stringify(record)).not.toContain(canary);
      expect(JSON.stringify(record)).not.toContain('/var/lib/');
    });
  });

  describe('S0-3 drill target', () => {
    it('restores only into its own networkless container of the production major, and records both majors', async () => {
      const { restoreDrill, docker } = await drillModule();
      const calls: string[][] = [];
      const record = await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
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
        tables: 3,
        migration: '0034',
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
      expect(rest.at(-1)).toEqual(['rm', '-f', name]);
      // No call names a host, a port or a connection string: there is no
      // target to point anywhere else.
      expect(calls.flat().join(' ')).not.toMatch(/postgres(ql)?:\/\/|--host|supabase/iu);
    }, 120_000);

    it('refuses an image of another major before restoring anything', async () => {
      const { restoreDrill } = await drillModule();
      const record = await restoreDrill({
        fetchArchive: async () => ({ takenAt, body: sealed }),
        privateKey: keys.privateKey,
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
      expect(source).toMatch(/'--network',\s*'none'/u);
    });
  });
});
