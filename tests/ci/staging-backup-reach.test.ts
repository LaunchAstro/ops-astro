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
