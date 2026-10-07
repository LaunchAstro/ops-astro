// SPDX-License-Identifier: AGPL-3.0-only
//
// `S0-3 store reach` (ticket S0-3, lines C1, C2 and C11; ORCH25-SL01-STORE).
// The backup store publishes no port and sits only on staging's internal
// network, so the scheduled job and the restore drill never connect to it from
// the machine: each sends one psql script, in a throwaway container of
// staging's pinned Postgres image on that network (scripts/ops/backup-store-
// reach.mjs). The login travels in the container's environment, never its
// command line, and every value inside the script is hex, so nothing a caller
// passes is read as SQL. The live half, staging-backup-reach-live.test.ts,
// runs the job and the drill through that one route against the real store.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Reach = (url: string, script: string) => Promise<string>;
type ReachModule = {
  psqlOn: (network: string) => Reach;
  stagingReach: Reach;
  reachArgs: (network: string) => string[];
  reachEnv: (url: string) => Record<string, string>;
  value: (v: unknown, type: string) => string;
  bound: (sql: string, params: unknown[]) => string;
  param: (n: number, type: string) => string;
};
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const load = () =>
  JSON.parse(read('deploy/staging/compose.json')) as {
    services: Record<string, { image?: string }>;
    networks: { staging: { name: string } };
  };
const importOps = async <T>(name: string): Promise<T> => {
  const path = `../../scripts/ops/${name}`;
  return (await import(
    /* @vite-ignore */
    path
  )) as T;
};

describe('S0-3 store reach', () => {
  reachCases1();
  reachCases2();
  reachCases3();
  reachCases4();
  dotSegmentCases();
});

function reachCases1() {
  it('the job, the drill and its receipt open no connection to the store from the machine', () => {
    const drill = ['restore-drill.mjs', 'carried-archive.mjs'];
    const reaching = ['backup.mjs', 'drill-acts.mjs', 'drill-receipt.mjs'];
    for (const file of [...drill, ...reaching]) {
      const text = read(`scripts/ops/${file}`);
      expect(text, file).not.toMatch(/from 'postgres'|\bpostgres\(/u);
      if (reaching.includes(file)) expect(text, file).toContain("from './backup-store-reach.mjs'");
    }
  });

  it("the one route is psql in staging's pinned image, on staging's network, the login in its environment", async () => {
    const { reachArgs } = await importOps<ReachModule>('backup-store-reach.mjs');
    const def = load();
    const args = reachArgs(def.networks.staging.name);
    expect(args.slice(0, 3)).toStrictEqual(['run', '--rm', '-i']);
    // Nothing psql prints reaches the daemon's log on the host's disk (o2-4).
    expect(args).toContain('--log-driver=none');
    expect(args).toContain(`--network=${def.networks.staging.name}`);
    expect(args).toContain(def.services['backups']?.image);
    expect(args.slice(args.indexOf(def.services['backups']?.image ?? '') + 1)).toStrictEqual([
      'psql',
      '-X',
      '-q',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ]);
    for (const name of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'])
      expect(args).toContain(`--env=${name}`);
    expect(args.join(' ')).not.toMatch(/--publish|-p |--network=host|=[^ ]*:\/\//u);
  });
}

function reachCases2() {
  it('the login goes to psql as named variables, TLS required, the password decoded', async () => {
    const { reachEnv } = await importOps<ReachModule>('backup-store-reach.mjs');
    expect(reachEnv('postgres://job%40x:p%2Fw@backups:5433/store')).toStrictEqual({
      PGHOST: 'backups',
      PGPORT: '5433',
      PGUSER: 'job@x',
      PGPASSWORD: 'p/w',
      PGDATABASE: 'store',
      PGSSLMODE: 'require',
    });
  });

  it('a value is hex inside the script, whatever it holds', async () => {
    const { value } = await importOps<ReachModule>('backup-store-reach.mjs');
    const hostile = `x'); drop table backups.archives; --\\:'v' \\gexec`;
    const sql = value(hostile, 'text');
    expect(sql).toBe(
      `convert_from(decode('${Buffer.from(hostile).toString('hex')}', 'hex'), 'UTF8')::text`,
    );
    expect(value(null, 'uuid')).toBe('null::uuid');
    expect(() => value('1', 'text; drop')).toThrow();
  });
}

function reachCases3() {
  it('a login address outside the one shape psql is given is refused, and the refusal holds no part of it', async () => {
    const { reachEnv } = await importOps<ReachModule>('backup-store-reach.mjs');
    for (const address of [
      'postgres://job:s3cret@backups/store?sslmode=disable',
      'postgres://job:s3cret@backups/store?options=-c%20role%3Dpostgres',
      'postgres://job:s3cret@backups/store#x',
      'mysql://job:s3cret@backups/store',
      'postgres://job:s3cret@backups/store/extra',
      'postgres://job:s3cret@backups/',
      'postgres://:s3cret@backups/store',
      'postgres://job:s3cret@[backups/store',
      'postgres://job:s3cret@backups,other/store',
      'postgres://job:s3cret@backups/store?sslmode=prefer',
      'postgres://job:s3cret@backups/store?sslmode=require&sslmode=disable',
      'postgres://job:s3cret@backups/store?sslmode=require&target_session_attrs=any',
    ]) {
      let message = 'accepted';
      try {
        reachEnv(address);
      } catch (error) {
        message = `${(error as Error).message} ${JSON.stringify(error)}`;
      }
      expect(message, address).not.toBe('accepted');
      expect(message, address).not.toMatch(/s3cret|job|backups/u);
    }
  });

  it('a bound value goes to psql as hex, so no quoting, newline or meta-command can end it', async () => {
    const { bound, param } = await importOps<ReachModule>('backup-store-reach.mjs');
    const hostile = `x' \\g\n\\! touch /tmp/owned\r`;
    const line = bound(`select ${param(1, 'text')}, ${param(2, 'integer')}`, [hostile, null]);
    expect(line).toBe(
      `select nullif(convert_from(decode($1, 'hex'), 'UTF8'), '')::text, ` +
        `nullif(convert_from(decode($2, 'hex'), 'UTF8'), '')::integer ` +
        `\\bind '${Buffer.from(hostile).toString('hex')}' '' \\g\n`,
    );
    expect(() => param(1, 'text; drop')).toThrow();
    expect(() => bound('select 1', [Symbol('x')])).toThrow();
  });
}

function reachCases4() {
  it('every address staging-logins writes is one a reach takes, at its TLS mode', async () => {
    const { reachEnv } = await importOps<ReachModule>('backup-store-reach.mjs');
    const { loginAddresses } = await importOps<{
      loginAddresses: (admin: string, staging: string, step: string) => { address: string }[];
    }>('staging-logins.ts');
    const admin =
      'postgresql://postgres.stagingref:example@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';
    const addresses = ['before-reset', 'after-reset'].flatMap((step) =>
      loginAddresses(admin, 'stagingref', step).map(({ address }) => address),
    );
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      expect(reachEnv(address)['PGSSLMODE'], 'its TLS mode').toBe('require');
    }
    expect(reachEnv('postgres://job:pw@backups/store?sslmode=verify-full')['PGSSLMODE']).toBe(
      'verify-full',
    );
  });
}

function dotSegmentCases() {
  it('an address the parser would read as another one, by its dot segments, is refused', async () => {
    const { reachEnv } = await importOps<ReachModule>('backup-store-reach.mjs');
    for (const address of [
      'postgres://job:s3cret@backups/store/../other?sslmode=require',
      'postgres://job:s3cret@backups/store/%2e%2e/other',
      'postgres://job:s3cret@backups/./other',
      'postgres://job:s3cret@backups/x/%2E%2E/other',
    ]) {
      let env: Record<string, string> | undefined;
      let message = 'accepted';
      try {
        env = reachEnv(address);
      } catch (error) {
        message = `${(error as Error).message} ${JSON.stringify(error)}`;
      }
      expect(env?.['PGDATABASE'], address).toBeUndefined();
      expect(message, address).not.toMatch(/s3cret|job|backups/u);
    }
  });
}
