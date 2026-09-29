// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-3 store reach`, live (ticket S0-3, lines C1, C2 and C11;
// ORCH25-SL01-STORE). It brings the real `backups` service up from staging's
// definition, fresh, with TLS and no port, and runs the job's add, the drill's
// fetch and receipt, and the upkeep through the one route the job and the
// drill have, psql on staging's network (scripts/ops/backup-store-reach.mjs).
// It needs Docker: skipped where Docker is not running, never skipped in CI.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carriedThroughPsql } from './staging-backup-reach-carried.fixture.ts';
import {
  OPERATOR,
  importOps,
  reachOn,
  recordPassed,
  send,
  type DrillModule,
  type JobModule,
} from './staging-backup-reach-live.fixture.ts';
import { largeArchive, overTheCap } from './staging-backup-reach-large.fixture.ts';

const DEFINITION = new URL('../../deploy/staging/compose.json', import.meta.url).pathname;
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const image =
  (
    JSON.parse(read('deploy/staging/compose.json')) as {
      services: Record<string, { image?: string }>;
    }
  ).services['db']?.image ?? '';
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const live = dockerUp || process.env['CI'] ? describe : describe.skip;
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env, input?: string) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', env, input, timeout: 180_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() };
};

// eslint-disable-next-line max-lines-per-function -- one live store, the checks that share it
live('S0-3 store reach, live', () => {
  const project = `s03r-${process.pid}`;
  const scratch = mkdtempSync(join(tmpdir(), 's0-3r-'));
  const override = join(scratch, 'override.json');
  const names = (suffix: string) => `${project}-${suffix}`;
  const admin = `probe_${randomBytes(4).toString('hex')}`;
  const logins: Record<string, string> = {};
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const env = {
    ...process.env,
    STAGING_DB_ADMIN_USER: 'probe',
    STAGING_DB_ADMIN_PASSWORD: 'probe-only',
    STAGING_BACKUPS_ADMIN_USER: admin,
    STAGING_BACKUPS_ADMIN_PASSWORD: randomBytes(12).toString('hex'),
    STAGING_AUTH_URL: 'http://127.0.0.1',
    STAGING_SITE_URL: 'http://127.0.0.1',
    STAGING_AUTH_DATABASE_URL: 'postgres://unused',
    STAGING_JWT_SECRET: 'unused',
  };
  const compose = (args: string[]) =>
    docker(['compose', '-p', project, '-f', DEFINITION, '-f', override, ...args], env);
  const asAdmin = (script: string) =>
    docker(
      [
        'exec',
        '-i',
        names('backups'),
        'psql',
        '-X',
        '-q',
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        admin,
        '-d',
        'ops_astro_staging_backups',
        '-f',
        '-',
      ],
      process.env,
      script,
    );

  beforeAll(() => {
    writeFileSync(
      override,
      JSON.stringify({
        services: { backups: { container_name: names('backups') } },
        networks: { staging: { name: names('staging') } },
        volumes: {
          'ops-astro-staging-pgdata': { name: names('pgdata') },
          'ops-astro-staging-backups-data': { name: names('backups-data') },
          'ops-astro-staging-tls': { name: names('tls') },
        },
      }),
    );
    const tls = join(scratch, 'tls');
    mkdirSync(tls);
    const made = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-subj',
      '/CN=backups',
      '-days',
      '1',
      '-keyout',
      join(tls, 'server.key'),
      '-out',
      join(tls, 'server.crt'),
    ]);
    expect(made.status).toBe(0);
    const filled = docker([
      'run',
      '--rm',
      '-v',
      `${names('tls')}:/tls`,
      '-v',
      `${tls}:/src:ro`,
      image,
      'sh',
      '-c',
      'cp /src/server.crt /src/server.key /tls/ && chown 70:70 /tls/* && chmod 600 /tls/server.key',
    ]);
    expect(filled.status, filled.out).toBe(0);
    const up = compose(['up', '-d', '--wait', 'backups']);
    expect(up.status, up.out).toBe(0);
  }, 300_000);

  afterAll(() => {
    compose(['down', '-v', '--timeout', '1']);
    rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  it('a fresh store server takes backup-store.sql and makes its own backup identity', () => {
    expect(asAdmin(`select count(*) from pg_roles where rolname = 'ops_astro_backup'`).out).toBe(
      '0',
    );
    const made = asAdmin(read('deploy/staging/backup-store.sql'));
    expect(made.status, made.out).toBe(0);
    expect(
      asAdmin(
        `select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'ops_astro_backup'`,
      ).out,
    ).toBe('f|f|f');
    for (const [role, suffix] of [
      ['ops_astro_backup', 'bk'],
      ['ops_astro_backup_retention', 'rt'],
      ['ops_astro_backup_restore', 'rs'],
    ] as const) {
      const password = randomBytes(12).toString('hex');
      const login = `s03r_${suffix}`;
      const granted = asAdmin(
        `create role ${login} login password '${password}' noinherit in role ${role};` +
          `grant connect on database ops_astro_staging_backups to ${login};`,
      );
      expect(granted.status, granted.out).toBe(0);
      logins[role] = `postgres://${login}:${password}@backups:5432/ops_astro_staging_backups`;
    }
    // Installation, from the restore runbook: the operating business, and the
    // appointed operator's own store login, a member of the restore identity.
    const password = randomBytes(12).toString('hex');
    const installed = asAdmin(
      `create role s03r_op login password '${password}' noinherit in role ops_astro_backup_restore;` +
        'grant connect on database ops_astro_staging_backups to s03r_op;' +
        "insert into backups.installation (operating_business) values ('made-up');" +
        `insert into backups.appointed (login, person) values ('s03r_op', '${OPERATOR}');`,
    );
    expect(installed.status, installed.out).toBe(0);
    logins['operator'] = `postgres://s03r_op:${password}@backups:5432/ops_astro_staging_backups`;
  });

  it('the job adds, the drill fetches and records, and the upkeep expires, each through psql on the network', async () => {
    const reach = await reachOn(names('staging'));
    const { runBackup, expireBackups } = await importOps<JobModule>('backup.mjs');
    const { fetchLatest } = await importOps<DrillModule>('restore-drill.mjs');
    const { openArchive } = await importOps<{ openArchive: (b: Buffer, k: string) => Buffer }>(
      'archive-seal.mjs',
    );
    const dump = Buffer.from(`PGDMP made-up ${randomBytes(4).toString('hex')}`);

    const added = await runBackup({
      dump: () => Promise.resolve(dump),
      storeUrl: logins['ops_astro_backup'],
      publicKey: keys.publicKey,
      reach,
      send,
    });
    expect(added).toMatchObject({ event: 'backup run', outcome: 'recorded' });

    const file = join(scratch, 'fetched');
    const fetched = await fetchLatest(logins['operator'] ?? '', file, reach);
    expect(openArchive(readFileSync(file), keys.privateKey)).toStrictEqual(dump);
    rmSync(file);
    expect(Number.isNaN(Date.parse(fetched.takenAt))).toBe(false);

    const last = await recordPassed(logins['operator'] ?? '', fetched, reach);
    expect(Number.isNaN(Date.parse(last ?? ''))).toBe(false);

    const upkeep = await expireBackups({
      storeUrl: logins['ops_astro_backup_retention'],
      restoreHeartbeat: 'http://127.0.0.1/unused',
      reach,
      send,
    });
    expect(upkeep).toMatchObject({ outcome: 'recorded', count: 0, restoreFresh: true });

    expect(asAdmin("select string_agg(action, ',' order by id) from backups.receipts").out).toBe(
      // The header's read, then its one part's (REV158S2 criterion 12).
      'backup recorded,backup read,backup read',
    );
  }, 180_000);

  it('a refusal comes back as the step that failed, with no login in it', async () => {
    const { runBackup } = await importOps<JobModule>('backup.mjs');
    const refused = await runBackup({
      dump: () => Promise.resolve(Buffer.from('PGDMP')),
      storeUrl: logins['ops_astro_backup_retention'],
      publicKey: keys.publicKey,
      reach: await reachOn(names('staging')),
      send,
    });
    expect(refused).toMatchObject({ outcome: 'failed', stage: 'store' });
    expect(JSON.stringify(refused)).not.toMatch(/s03r_|postgres:\/\//u);
  }, 60_000);

  // REV158K criteria 13 and 14 (staging-backup-reach-carried.fixture.ts).
  it("the carried record goes through psql with its digest bound: a refused one leaves none in the store log, and the appointed operator's passes", async () => {
    await carriedThroughPsql({
      reach: await reachOn(names('staging')),
      logins,
      keys,
      asAdmin,
      scratch,
      operator: OPERATOR,
      storeLog: () => docker(['logs', names('backups')]).out,
    });
  }, 180_000);

  // REV158S criterion 5: an archive larger than the store container's memory
  // (512m in staging's definition) goes in and comes back out in parts, and
  // neither the job nor the drill ever holds it whole.
  it("an archive just over the store's memory limit is stored exactly and fetched back in fixed memory", async () => {
    await largeArchive({ reach: await reachOn(names('staging')), logins, keys, asAdmin, scratch });
  }, 900_000);

  it('an archive over the cap is refused (53400) part way through, and the store keeps nothing of it', async () => {
    await overTheCap({ reach: await reachOn(names('staging')), logins, keys, asAdmin, scratch });
  }, 300_000);

  it('a refused upload completion leaves no archive or challenge fingerprint in the store log', async () => {
    const archiveDigest = 'a'.repeat(64);
    const challengeDigest = 'b'.repeat(64);
    expect(
      asAdmin('update backups.settings set max_bytes = (select bytes from backups.stored) + 100')
        .status,
    ).toBe(0);
    const reach = await reachOn(names('staging'));
    await expect(
      reach(
        logins['ops_astro_backup'] ?? '',
        `set role ops_astro_backup;
begin;
select backups.add_part(0, decode('01', 'hex'));
select backups.complete_archive(2, '${archiveDigest}', '${challengeDigest}');
`,
      ),
    ).rejects.toThrow();
    const seen = docker(['logs', '--tail', '50', names('backups')]);
    expect(seen.status).toBe(0);
    const logged = seen.out;
    expect(logged).toMatch(/ERROR|STATEMENT/u);
    expect(logged).not.toContain(archiveDigest);
    expect(logged).not.toContain(challengeDigest);
  });
});
