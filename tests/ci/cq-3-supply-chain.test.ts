// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-3: the supply-chain settings are stated, read back from both files, and
// refused when weakened. pnpm itself shows the exotic-source refusal and the
// frozen install; the trust downgrade is refused here as a weakened setting,
// because pnpm's own check needs registry trust evidence no offline test has.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const ROOT = join(import.meta.dirname, '../..');
const file = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const scratch = () => mkdtempSync(join(tmpdir(), 'cq3-'));
const AGE = { pnpm: String(3 * 24 * 60), renovate: '3 days' };
const WANT = {
  minimumReleaseAge: AGE.pnpm,
  trustPolicy: 'no-downgrade',
  blockExoticSubdeps: 'true',
};
const CANARY = `cq3-canary-${randomUUID()}`;
const PLANTED = { NODE_AUTH_TOKEN: CANARY, NPM_TOKEN: CANARY, CQ3_CANARY_SECRET: CANARY };
const GOTRUE = 'public.ecr.aws/supabase/gotrue:v2.192.0';
const GOTRUE_DIGEST = 'b252efb680be37d4a8bf77c210cf0439c19b63a4b51929233a65dd101d25bdab';

/** What is wrong with the two settings files; an unreadable file is a problem, never a pass. */
function settingsProblems(workspace: string | undefined, renovate: string | undefined): string[] {
  const problems: string[] = [];
  if (workspace === undefined) problems.push('pnpm-workspace.yaml: unreadable');
  for (const [key, value] of Object.entries(WANT)) {
    const lines = (workspace ?? '').split(/\r?\n/u).filter((l) => l.startsWith(`${key}:`));
    const stated = lines.map((l) =>
      l
        .slice(key.length + 1)
        .replace(/\s#.*$/u, '')
        .trim(),
    );
    if (stated.join() !== value) problems.push(`pnpm-workspace.yaml: ${key} is not ${value}`);
  }
  let config: { minimumReleaseAge?: unknown; packageRules?: { minimumReleaseAge?: unknown }[] };
  try {
    config = JSON.parse(renovate ?? '');
  } catch {
    return [...problems, 'renovate.json: unreadable'];
  }
  const rules = Array.isArray(config.packageRules) ? config.packageRules : [];
  if (rules.length === 0) problems.push('renovate.json: no package rules');
  for (const [i, rule] of [config, ...rules].entries()) {
    const where = i === 0 ? 'top level' : `package rule ${i}`;
    if (rule.minimumReleaseAge !== AGE.renovate)
      problems.push(`renovate.json ${where}: not 3 days`);
  }
  return problems;
}

interface Run {
  readonly status: number | null;
  readonly out: string;
}

/** Asynchronous, so a server in this process can answer the child. */
function run(command: string, args: string[], cwd: string, env: object = {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...PLANTED, ...env } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (status) => done({ status, out }));
  });
}

/** A tree holding the pins check, one recorded action, one record and one local script. */
function pinsTree(authImage: string, record: string): string {
  const tree = scratch();
  const action = 'actions/checkout@1111111111111111111111111111111111111111';
  for (const dir of ['scripts/local', '.github/workflows', 'docs'])
    mkdirSync(join(tree, dir), { recursive: true });
  cpSync(join(ROOT, 'scripts/pins-check.mjs'), join(tree, 'scripts/pins-check.mjs'));
  writeFileSync(
    join(tree, '.github/workflows/ci.yml'),
    `jobs:\n  a:\n    steps:\n      - uses: ${action}\n`,
  );
  writeFileSync(join(tree, 'scripts/local/auth-up.sh'), `AUTH_IMAGE=${authImage}\n`);
  writeFileSync(join(tree, 'docs/supply-chain-pins.md'), `${action.split('@')[1]}\n${record}\n`);
  return tree;
}

/** A project whose one dependency, `a`, asks for `b` by tarball URL: an exotic sub-dependency. */
async function exoticInstall(workspace: string): Promise<Run> {
  const tree = scratch();
  mkdirSync(join(tree, 'b/package'), { recursive: true });
  writeFileSync(join(tree, 'b/package/package.json'), '{"name":"b","version":"1.0.0"}');
  await run('tar', ['czf', 'b.tgz', '-C', 'b', 'package'], tree);
  const tarball = readFileSync(join(tree, 'b.tgz'));
  const server = createServer((_, response) => response.end(tarball)).listen(0, '127.0.0.1');
  await new Promise((ready) => {
    server.once('listening', ready);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/b.tgz`;
  const { packageManager } = JSON.parse(file('package.json')) as Record<string, string>;
  mkdirSync(join(tree, 'a'));
  writeFileSync(
    join(tree, 'a/package.json'),
    JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { b: url } }),
  );
  writeFileSync(
    join(tree, 'package.json'),
    JSON.stringify({ name: 'p', private: true, packageManager, dependencies: { a: 'file:./a' } }),
  );
  writeFileSync(join(tree, 'pnpm-workspace.yaml'), workspace);
  writeFileSync(join(tree, '.npmrc'), `//127.0.0.1/:_authToken=${CANARY}\n`);
  return await run('pnpm', ['install', '--ignore-scripts'], tree).finally(() => server.close());
}

describe('CQ-3 supply-chain settings', () => {
  const workspace = file('pnpm-workspace.yaml');
  const renovate = file('renovate.json');
  const runs: Run[] = [];

  it('CQ-3 pnpm settings: minimumReleaseAge, trustPolicy no-downgrade and blockExoticSubdeps stated', () => {
    expect(settingsProblems(workspace, '{}').filter((p) => p.startsWith('pnpm'))).toStrictEqual([]);
    expect(workspace).toMatch(/^minimumReleaseAgeExclude:\n {2}- vite@8\.3\.0$/mu);
  });

  it('CQ-3 renovate rules: every package rule carries a minimum release age', () => {
    expect(
      settingsProblems(undefined, renovate).filter((p) => p.startsWith('renovate')),
    ).toStrictEqual([]);
  });

  it('CQ-3 release age: 3 days, 4320 minutes in pnpm and 3 days in every Renovate rule', () => {
    expect(settingsProblems(workspace, renovate)).toStrictEqual([]);
  });

  it('CQ-3 frozen install: the lockfile installs offline, vite 8.3.0 included', async () => {
    const tree = scratch();
    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
      cpSync(join(ROOT, path), join(tree, path));
    for (const dir of ['apps', 'packages'].flatMap((d) =>
      readdirSync(join(ROOT, d)).map((p) => join(d, p)),
    )) {
      const manifest = join(dir, 'package.json');
      if (existsSync(join(ROOT, manifest))) cpSync(join(ROOT, manifest), join(tree, manifest));
    }
    const install = await run(
      'pnpm',
      ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
      tree,
    );
    runs.push(install);
    expect(install.status, install.out).toBe(0);
    expect(
      JSON.parse(readFileSync(join(tree, 'node_modules/vite/package.json'), 'utf8')).version,
    ).toBe('8.3.0');
  }, 180_000);

  it('CQ-3 auth image pin: a moved tag and an unrecorded digest are refused', async () => {
    const pinned = `${GOTRUE}@sha256:${GOTRUE_DIGEST}`;
    const cases = [
      [GOTRUE, GOTRUE_DIGEST, 1],
      [pinned, 'nothing recorded', 1],
      [`"${pinned}"`, GOTRUE_DIGEST, 0],
    ] as const;
    const checks = await Promise.all(
      cases.map(([image, record]) =>
        run('node', ['scripts/pins-check.mjs'], pinsTree(image, record)),
      ),
    );
    runs.push(...checks);
    expect(checks.map((c) => c.status)).toStrictEqual(cases.map(([, , want]) => want));
    expect(file('scripts/local/auth-up.sh')).toContain(`AUTH_IMAGE=${pinned}\n`);
    expect(file('docs/supply-chain-pins.md')).toContain(`sha256:${GOTRUE_DIGEST}`);
    const real = await run('node', ['scripts/pins-check.mjs'], ROOT);
    expect([real.status, /[1-9]\d* in local scripts/u.test(real.out)], real.out).toStrictEqual([
      0,
      true,
    ]);
  });

  it('CQ-3 supply-chain refusals: a trust downgrade, an exotic source and a scanner failure', async () => {
    for (const weaker of [
      'trustPolicy: off',
      'trustPolicy: no-downgrade\ntrustPolicy: off',
      '# trustPolicy: no-downgrade',
    ]) {
      const weakened = workspace.replace(/^trustPolicy: no-downgrade$/mu, weaker);
      expect(settingsProblems(weakened, renovate), weaker).toContain(
        'pnpm-workspace.yaml: trustPolicy is not no-downgrade',
      );
    }
    expect(
      settingsProblems(workspace, renovate.replace(/"minimumReleaseAge": "3 days",?/u, '')),
    ).not.toStrictEqual([]);
    const refused = await exoticInstall(workspace);
    const allowed = await exoticInstall(
      workspace.replace('blockExoticSubdeps: true', 'blockExoticSubdeps: false'),
    );
    runs.push(refused, allowed);
    expect(
      [refused.status !== 0, refused.out.includes('ERR_PNPM_EXOTIC_SUBDEP')],
      refused.out,
    ).toStrictEqual([true, true]);
    expect(allowed.status, allowed.out).toBe(0);
    const unreadable = Object.entries(WANT).map(
      ([k, v]) => `pnpm-workspace.yaml: ${k} is not ${v}`,
    );
    expect(settingsProblems(undefined, '{')).toStrictEqual([
      'pnpm-workspace.yaml: unreadable',
      ...unreadable,
      'renovate.json: unreadable',
    ]);
    // A local script the check cannot read stops it; it never reads as zero images.
    const tree = pinsTree(`${GOTRUE}@sha256:${GOTRUE_DIGEST}`, GOTRUE_DIGEST);
    mkdirSync(join(tree, 'scripts/local/unreadable.sh'));
    const scan = await run('node', ['scripts/pins-check.mjs'], tree);
    runs.push(scan);
    expect(scan.status, scan.out).not.toBe(0);
  }, 120_000);

  it('CQ-3 canary: a planted secret reaches no install log, check output or error', () => {
    expect(runs.length).toBeGreaterThanOrEqual(6);
    expect(runs.some((r) => r.status !== 0)).toBe(true);
    for (const { out } of runs) expect(out).not.toContain(CANARY);
  });
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('CQ-3 isolation', () => {
  let db: FreshDatabase;
  const parties: string[] = [];

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'cq3' });
    const party = async (key: string) => {
      const id = await insertBusiness(db.app, key);
      await installSpine(db.app, id);
      const member = await enrol(db.app, id, `${key}-member`);
      const client = await enrol(db.app, id, `${key}-client`);
      await db.app.withBusiness(id, async (tx) => {
        await grantTo(tx, member, 'write');
        await grantTo(tx, client, 'read');
      });
      return id;
    };
    // One after the other: installSpine and the grants read the shared catalogue.
    parties.push(await party('bravo'), await party('charlie'));
  }, 60_000);

  afterAll(async () => await db?.drop());

  it('CQ-3 isolation: two businesses, two clients, one grant each; the checks read, list and change none of it', async () => {
    const tables = await db.admin.execute<{ t: string }>(
      `select table_name as t from information_schema.columns
        where table_schema = 'public' and column_name = 'business_id' order by 1`,
    );
    const counts = async () =>
      await Promise.all(
        parties.map(async (id) => {
          const sql = tables.map(
            ({ t }) => `(select count(*)::int from public.${t} where business_id = $1) as ${t}`,
          );
          return (await db.admin.execute(`select ${sql.join(', ')}`, [id]))[0];
        }),
      );
    const before = await counts();
    const env = { DATABASE_URL: db.appUrl, DATABASE_ADMIN_URL: db.appUrl };
    const check = await run('node', ['scripts/pins-check.mjs'], ROOT, env);
    expect(check.status, check.out).toBe(0);
    expect(settingsProblems(file('pnpm-workspace.yaml'), file('renovate.json'))).toStrictEqual([]);
    expect(await counts()).toStrictEqual(before);
    for (const id of parties) expect(check.out).not.toContain(id);
  });
});
