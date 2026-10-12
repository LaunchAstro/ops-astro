// SPDX-License-Identifier: AGPL-3.0-only
//
// Production's backups and restore drill. With `--production`, the backup job
// and the drill reach production's backup store, on production's internal
// network, in throwaway containers named as production's own (so production's
// deploy never counts one as a live service of staging's). Without it, each
// reaches staging's store exactly as before. Production's backup refuses a
// source on staging's project, or on any project but production's. The drill
// still takes no target: it restores only into its own networkless container.
// `docker` here is a stand-in on PATH that logs each call and answers `1`.

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type Reach = (url: string, script: string) => Promise<string>;
type Ops = {
  reachFor: (environment: string) => Reach;
  stagingReach: Reach;
  pgDump: (source: string, environment?: string) => Promise<AsyncIterable<Buffer>>;
  sourceRefusal: (env: Record<string, string>, environment: string) => string | undefined;
  modeOf: (args: string[]) => { mode: string; environment: string };
  restoreDrill: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  sealArchive: (dump: Buffer, publicKey: string) => Buffer;
};
const load = async (file: string): Promise<Ops> =>
  (await import(
    /* @vite-ignore */
    `../../scripts/ops/${file}`
  )) as Ops;
const readDeploy = (file: string): string =>
  readFileSync(new URL(`../../deploy/${file}`, import.meta.url), 'utf8');

const bin = mkdtempSync(join(tmpdir(), 'production-backups-'));
const calls = join(bin, 'calls');
const path = process.env['PATH'];
beforeAll(() => {
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${calls}'`,
      'if [ "$1" = run ]; then cat > /dev/null; echo 1; fi',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  process.env['PATH'] = `${bin}:${path ?? ''}`;
});
beforeEach(() => writeFileSync(calls, ''));
afterAll(() => {
  process.env['PATH'] = path;
  rmSync(bin, { recursive: true, force: true });
});
const runs = (): string[] =>
  readFileSync(calls, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('run '));

const STORE = 'postgres://ops_astro_backup:fixture-only@backups:5432/ops_astro_backups';

describe("production's backups reach production's store, staging's reach staging's", () => {
  it("production's reach runs on production's network, in a container named as production's", async () => {
    const { reachFor } = await load('backup-store-reach.mjs');
    expect(await reachFor('production')(STORE, 'select 1;')).toBe('1');
    const [run] = runs();
    expect(run).toMatch(/ --network=ops-astro /u);
    expect(run).toMatch(/ --name=ops-astro-store-[0-9a-f]{16} /u);
    expect(run).not.toContain('staging');
  });

  it("staging's reach is unchanged", async () => {
    const { stagingReach } = await load('backup-store-reach.mjs');
    expect(await stagingReach(STORE, 'select 1;')).toBe('1');
    const [run] = runs();
    expect(run).toMatch(/ --network=ops-astro-staging /u);
    expect(run).toMatch(/ --name=ops-astro-staging-store-[0-9a-f]{16} /u);
  });

  it("production's dump runs on production's network, in a container named as production's", async () => {
    const { pgDump } = await load('backup-dump.mjs');
    const pieces = await pgDump('postgres://backup:fixture-only@source:5432/app', 'production');
    const drained: Buffer[] = [];
    for await (const piece of pieces) drained.push(piece);
    expect(drained).not.toStrictEqual([]);
    const [run] = runs();
    expect(run).toMatch(/ --network=ops-astro /u);
    expect(run).toMatch(/ --name=ops-astro-backup-[0-9a-f]{16} /u);
  });
});

describe("production's backup source is production's project alone", () => {
  const STAGING = 'abcdefghijabcdefghij';
  const PRODUCTION = 'zyxwvutsrqzyxwvutsrq';
  const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
  const source = (ref: string): string =>
    `postgres://ops_astro_backup_login.${ref}:fixture-only@${POOLER}:5432/postgres`;
  const env = (ref: string): Record<string, string> => ({
    STAGING_PROJECT_REF: STAGING,
    PRODUCTION_PROJECT_REF: PRODUCTION,
    BACKUP_SOURCE_URL: source(ref),
  });

  it("refuses staging's database, or any but production's; staging's job is unchanged", async () => {
    const { sourceRefusal } = await load('backup.mjs');
    expect(sourceRefusal(env(STAGING), 'production')).toBe(
      "BACKUP_SOURCE_URL reaches staging's project",
    );
    expect(sourceRefusal(env('qqqqqqqqqqqqqqqqqqqq'), 'production')).toBe(
      "BACKUP_SOURCE_URL is not production's project",
    );
    expect(sourceRefusal(env(PRODUCTION), 'production')).toBeUndefined();
    expect(sourceRefusal({}, 'staging')).toBeUndefined();
  });
});

describe("production's restore drill", () => {
  it('takes --production after any mode, and nothing else', async () => {
    const { modeOf } = await load('restore-drill.mjs');
    expect(modeOf(['--drill', '--production'])).toMatchObject({
      mode: 'drill',
      environment: 'production',
    });
    expect(modeOf(['--export', 'f', '--production'])).toMatchObject({ environment: 'production' });
    expect(modeOf(['--drill'])).toMatchObject({ environment: 'staging' });
    expect(() => modeOf(['--drill', '--staging'])).toThrow(/usage/u);
    expect(() => modeOf(['--production', '--drill'])).toThrow(/usage/u);
  });

  it("still takes no target: its one container has no network, named as production's", async () => {
    const { restoreDrill } = await load('drill-restore.mjs');
    const { sealArchive } = await load('archive-seal.mjs');
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const started: string[][] = [];
    const record = await restoreDrill({
      fetchArchive: () =>
        Promise.resolve({ takenAt: 'now', body: sealArchive(Buffer.from('x'), keys.publicKey) }),
      privateKey: keys.privateKey,
      scope: { business: randomUUID(), client: randomUUID(), person: randomUUID() },
      prefix: 'ops-astro',
      docker: (args: string[]) => {
        started.push(args);
        return Promise.resolve({ code: 1, stdout: Buffer.alloc(0) });
      },
    });
    expect(record).toMatchObject({ outcome: 'failed', target: 'throwaway container' });
    const run = started[0]?.join(' ') ?? '';
    expect(run).toMatch(/--network none .*--name ops-astro-drill-[0-9a-f]{8} /u);
  }, 60_000);
});

describe("production's scheduled jobs", () => {
  it.each([
    ['backup', 'run'],
    ['backup-expire', 'expire'],
  ])("the %s job is staging's, renamed, run with --production", (job, command) => {
    const staging = readDeploy(`staging/ops-astro-staging-${job}.plist`);
    const expected = staging
      .replaceAll('ops-astro-staging', 'ops-astro')
      .replaceAll('@STAGING_', '@PRODUCTION_')
      .replace(
        `<string>${command}</string>\n`,
        `<string>${command}</string>\n    <string>--production</string>\n`,
      );
    expect(readDeploy(`production/ops-astro-${job}.plist`)).toBe(expected);
    expect(expected).not.toMatch(/staging/iu);
  });
});

describe("production's deploy counts its own backup runs as its own", () => {
  it('a store, dump or drill run named as production’s is production’s; staging’s and launchd’s are not', async () => {
    const { unitOf } = await import('../../scripts/ops/deploy.ts');
    const unit = unitOf('production');
    const hex = 'a1b2c3d4e5f60718';
    expect(unit.owns(`ops-astro-store-${hex}`, 'docker')).toBe(true);
    expect(unit.owns(`ops-astro-backup-${hex}`, 'docker')).toBe(true);
    expect(unit.owns('ops-astro-drill-a1b2c3d4', 'docker')).toBe(true);
    expect(unit.owns(`ops-astro-staging-store-${hex}`, 'docker')).toBe(false);
    expect(unit.owns(`ops-astro-store-${hex}`, 'launchd')).toBe(false);
    expect(unit.owns('ops-astro-store-latest', 'docker')).toBe(false);
  });
});
