// SPDX-License-Identifier: AGPL-3.0-only
//
// The backup's child processes against real Docker, pg_dump and psql (#489,
// #491, OW-062.2 to OW-062.4): a refused consumer stops the store's psql and a
// stalled dump's container, a dump whose client dies by a signal fails rather
// than waiting, the dump reads an encoded database name as psql does, and a
// bound value reaches the server as the same text whatever it holds. Only the
// network is remapped, to this suite's own internal one.
/* oxlint-disable max-lines, max-lines-per-function, no-await-in-loop, no-unmodified-loop-condition, no-underscore-dangle, promise/always-return, require-await, no-inline-comments -- the review's OW-062 proof cases, kept as written */
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  dumps: [] as string[],
  children: [] as ChildProcess[],
  network: '',
}));
// Only remap the staging network to this proof's isolated network. Docker,
// pg_dump, psql and their signal handling are all real.
vi.mock('node:child_process', async (original) => {
  const child = await original<typeof import('node:child_process')>();
  return {
    ...child,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const rewritten = args.includes('pg_dump')
        ? args.map((arg) => (arg.startsWith('--network=') ? `--network=${captured.network}` : arg))
        : args;
      if (args.includes('pg_dump')) {
        const name = args.find((arg) => arg.startsWith('--name='));
        if (name !== undefined) captured.dumps.push(name.slice('--name='.length));
      }
      const spawned = child.spawn(command, rewritten, options);
      if (args.includes('pg_dump')) captured.children.push(spawned);
      return spawned;
    },
  };
});

const suffix = randomBytes(5).toString('hex');
const server = `backup-route-pg-${suffix}`;
const scratch = mkdtempSync(join(tmpdir(), 'backup-route-'));
const image = JSON.parse(readFileSync('deploy/staging/compose.json', 'utf8')).services.backups
  .image;
const url = 'postgres://postgres@source:5432/postgres';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function docker(args: string[], input?: string): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 20_000 });
  if (result.status !== 0) throw new Error(`proof Docker step failed: ${result.stderr}`);
  return result.stdout.trim();
}

const sql = (statement: string): string =>
  docker(
    [
      'exec',
      '-i',
      server,
      'psql',
      '-X',
      '-Atq',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    statement,
  );
const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

beforeAll(async () => {
  captured.network = `backup-route-net-${suffix}`;
  docker(['network', 'create', '--internal', captured.network]);
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    server,
    '--network',
    captured.network,
    '--network-alias',
    'source',
    '--tmpfs',
    '/var/lib/postgresql/data',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    image,
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    ready =
      spawnSync('docker', ['exec', server, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], {
        stdio: 'ignore',
      }).status === 0;
    if (!ready) await delay(100);
  }
  expect(ready).toBe(true);
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-subj',
      '/CN=source',
      '-days',
      '1',
      '-keyout',
      join(scratch, 'server.key'),
      '-out',
      join(scratch, 'server.crt'),
    ],
    { stdio: 'ignore' },
  );
  expect(made.status).toBe(0);
  docker(['cp', join(scratch, 'server.key'), `${server}:/tmp/server.key`]);
  docker(['cp', join(scratch, 'server.crt'), `${server}:/tmp/server.crt`]);
  docker([
    'exec',
    server,
    'sh',
    '-c',
    'chown postgres:postgres /tmp/server.* && chmod 600 /tmp/server.key',
  ]);
  sql("alter system set ssl_cert_file = '/tmp/server.crt';");
  sql("alter system set ssl_key_file = '/tmp/server.key';");
  sql('alter system set ssl = on;');
  sql('select pg_reload_conf();');
  await delay(200);
  sql(`create role ops_astro_backup nologin bypassrls;
    grant usage on schema public to ops_astro_backup;
    create table public.slow_dump as
      select i, repeat(md5(i::text), 32) as payload from generate_series(1, 250000) i;
    grant select on public.slow_dump to ops_astro_backup;`);
}, 60_000);

afterAll(() => {
  for (const name of captured.dumps)
    spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
  spawnSync('docker', ['rm', '-f', '-v', server], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', captured.network], { stdio: 'ignore' });
  rmSync(scratch, { recursive: true, force: true });
});

it('a refused backup removes its pg_dump container even when the source stalls', async () => {
  const path = '../../scripts/ops/backup.mjs';
  const { runBackup, pgDump } = await import(/* @vite-ignore */ path);
  const dump = await pgDump(url);
  const backend = sql("select pid from pg_stat_activity where application_name = 'pg_dump'");
  expect(backend).toMatch(/^\d+$/u);
  // A stalled source is realistic. Freeze only this proof's backend after
  // the first dump bytes, so it cannot finish merely because stop drains it.
  docker(['exec', server, 'kill', '-STOP', backend]);
  try {
    const result = await runBackup({
      dump: async () => dump,
      storeUrl: url,
      publicKey: keys.publicKey,
      reach: async () => {
        throw new Error('store refused');
      },
      send: async () => 'sent',
    });
    expect(result).toMatchObject({ outcome: 'failed', stage: 'store' });
    const name = captured.dumps.at(-1);
    expect(name).toBeDefined();
    const stillRunning = docker(['ps', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
    const heldLocks = Number(
      sql(`select count(*) from pg_locks where pid = ${backend}
      and mode = 'AccessShareLock' and granted`),
    );
    expect(
      stillRunning,
      `stop returned with the pg_dump container alive and ${heldLocks} source locks held`,
    ).toBe('');
  } finally {
    docker(['exec', server, 'kill', '-CONT', backend]);
    for (const name of captured.dumps)
      spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
  }
}, 20_000);

it('an archive consumer error ends the store psql without waiting for its next query', async () => {
  const path = '../../scripts/ops/backup-store-reach.mjs';
  const { psqlOn } = await import(/* @vite-ignore */ path);
  let called = false;
  let settled = false;
  let refusal: unknown;
  const marker = `backup-route-ready-${suffix}`;
  let markReady: (line: string) => void;
  const ready = new Promise<string>((resolve) => {
    markReady = resolve;
  });
  const refused = psqlOn(captured.network)(
    url,
    [`select '${marker}';\n`, 'select 1;\nselect pg_sleep(30);\n'],
    (line: string) => {
      if (line === marker) {
        markReady(line);
        return;
      }
      expect(line).toBe('1');
      called = true;
      throw new Error('archive part rejected');
    },
  ).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      refusal = error;
    },
  );
  try {
    expect(
      await Promise.race([ready, refused]),
      'psql must finish setup before its row timer',
    ).toBe(marker);
    for (let attempt = 0; attempt < 50 && !called; attempt += 1) await delay(20);
    expect(called, 'psql must deliver a row before the consumer rejects it').toBe(true);
    await delay(750);
    expect(settled, 'consumer refusal left psql running and reach waiting on pg_sleep').toBe(true);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toHaveProperty('message', 'archive part rejected');
    expect(
      Number(
        sql(
          "select count(*) from pg_stat_activity where application_name = 'psql' and pid <> pg_backend_pid()",
        ),
      ),
      'returning an error must also stop the reader session',
    ).toBe(0);
  } finally {
    sql(
      "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'psql' and pid <> pg_backend_pid()",
    );
    await refused;
  }
}, 10_000);

it('a dump whose Docker client dies by a signal fails instead of waiting forever', async () => {
  const path = '../../scripts/ops/backup-dump.mjs';
  const { pgDump } = await import(/* @vite-ignore */ path);
  const dump = await pgDump(url);
  const child = captured.children.at(-1);
  if (child === undefined) throw new Error('the proof did not start a dump client');
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  expect(child.kill('SIGKILL')).toBe(true);
  await closed;
  let settled = false;
  let failed: unknown;
  void (async () => {
    for await (const _piece of dump) {
      /* drain printed bytes */
    }
  })().then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failed = error;
    },
  );
  try {
    await delay(250);
    expect(settled, 'close(null, SIGKILL) was mistaken for a dump that is still running').toBe(
      true,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed).toHaveProperty('message', 'pg_dump failed');
  } finally {
    const name = captured.dumps.at(-1);
    if (name !== undefined) spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' });
  }
}, 10_000);

// The name is percent-encoded but plain once decoded: a dump refuses any other
// (#999), so a name with a space (#491) is refused, not mangled.
it('the dump reads a percent-encoded database name decoded', async () => {
  sql('create database backup_route_source;');
  const control = spawnSync('docker', [
    'exec',
    server,
    'pg_dump',
    '-U',
    'postgres',
    '--role=ops_astro_backup',
    '--format=custom',
    '--schema=public',
    '-d',
    'backup_route_source',
  ]);
  expect(
    control.status,
    'the decoded database name and backup role work with the same pg_dump',
  ).toBe(0);
  expect(control.stdout.subarray(0, 5).toString()).toBe('PGDMP');
  const path = '../../scripts/ops/backup-dump.mjs';
  const { pgDump } = await import(/* @vite-ignore */ path);
  let outcome: unknown;
  try {
    const dump = await pgDump('postgres://postgres@source:5432/backup%5Froute%5Fsource');
    const pieces: Buffer[] = [];
    for await (const piece of dump) pieces.push(piece);
    outcome = Buffer.concat(pieces).subarray(0, 5).toString();
  } catch (error) {
    outcome = error instanceof Error ? error.message : 'unknown failure';
  }
  expect(outcome, 'the database exists under its decoded URL name').toBe('PGDMP');
}, 10_000);

it('a bound value reaches the server as the same text, whatever it holds', async () => {
  const path = '../../scripts/ops/backup-store-reach.mjs';
  const { psqlOn, bound, param } = await import(/* @vite-ignore */ path);
  const awkward = "it's \\ a 'value'\n\\g select 1; \\! true -- ünïcode";
  const printed = await psqlOn(captured.network)(
    url,
    bound(`select encode(convert_to(${param(1, 'text')}, 'UTF8'), 'hex')`, [awkward]),
  );
  expect(Buffer.from(printed, 'hex').toString('utf8')).toBe(awkward);
}, 10_000);
