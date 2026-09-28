// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-3: the supply-chain settings, read back from both files and refused when weakened: by pnpm
// itself against a registry on 127.0.0.1, and by the Semgrep check when its scan fails.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { subjectDigest } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';

type Command = Parameters<typeof executeCommand>[4];

const ROOT = join(import.meta.dirname, '../..');
const file = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const scratch = () => mkdtempSync(join(tmpdir(), 'cq3-'));
const WANT = { minimumReleaseAge: String(7 * 24 * 60), trustPolicy: 'no-downgrade' };
const CANARY = `cq3-canary-${randomUUID()}`;
const PLANTED = { NODE_AUTH_TOKEN: CANARY, NPM_TOKEN: CANARY, CQ3_CANARY_SECRET: CANARY };
const GOTRUE = 'public.ecr.aws/supabase/gotrue:v2.192.0';
const GOTRUE_DIGEST = 'b252efb680be37d4a8bf77c210cf0439c19b63a4b51929233a65dd101d25bdab';
const BOTH = ['pnpm-workspace.yaml', 'renovate.json'];
const byUrl = (url: string) => `${url}/c.tgz`;
const UPDATE = { command: 'task.update', expectedRevision: 1, fields: { title: 'taken' } };

/** Every value `key` is stated with: twice or commented out never reads as one. */
const stated = (text: string, key: string) =>
  [...text.matchAll(/^(\w+): *(.*?)(?: +#.*)?$/gmu)].flatMap((m) => (m[1] === key ? [m[2]] : []));

/** The distinct release ages of Renovate's top level and each package rule; none without rules. */
function renovateAges(text: string): unknown[] {
  const c = JSON.parse(text) as { minimumReleaseAge?: unknown; packageRules?: (typeof c)[] };
  const rules = c.packageRules ?? [];
  return rules.length === 0 ? [] : [...new Set([c, ...rules].map((r) => r.minimumReleaseAge))];
}

/** `out` never holds the canary, so no failed assertion can print it; `leaked` says it was there. */
interface Run {
  readonly status: number | null;
  readonly out: string;
  readonly leaked: boolean;
}

/** Asynchronous, so a server in this process can answer the child. */
function run(command: string, args: string[], cwd: string, env: object = {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...PLANTED, ...env } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (status) =>
      done({ status, out: out.replaceAll(CANARY, '[canary]'), leaked: out.includes(CANARY) }),
    );
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

/** `c` 1.0.0 had provenance and a trusted publisher, 1.0.1 neither: a stolen token's shape. */
function packument(url: string): string {
  const provenance = { url, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } };
  const publisher = { trustedPublisher: { id: 'github', oidcConfigId: 'c' } };
  const v = (version: string, strong: boolean) => ({
    name: 'c',
    version,
    _npmUser: { name: 'c', ...(strong ? publisher : {}) },
    dist: { tarball: `${url}/c.tgz`, ...(strong ? { attestations: provenance } : {}) },
  });
  const [early, late] = ['2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z'];
  const versions = { '1.0.0': v('1.0.0', true), '1.0.1': v('1.0.1', false) };
  const time = { created: early, modified: late, '1.0.0': early, '1.0.1': late };
  return JSON.stringify({ name: 'c', 'dist-tags': { latest: '1.0.1' }, versions, time });
}

/** A project whose dependency `a` asks for `want(url)` from a registry on 127.0.0.1. */
async function install(workspace: string, want: (url: string) => string): Promise<Run> {
  const tree = scratch();
  mkdirSync(join(tree, 'c/package'), { recursive: true });
  writeFileSync(join(tree, 'c/package/package.json'), '{"name":"c","version":"1.0.1"}');
  await run('tar', ['czf', 'c.tgz', '-C', 'c', 'package'], tree);
  const tarball = readFileSync(join(tree, 'c.tgz'));
  const server = createServer((request, response) => {
    response.end(request.url?.endsWith('.tgz') === true ? tarball : packument(url));
  }).listen(0, '127.0.0.1');
  await new Promise((ready) => {
    server.once('listening', ready);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { packageManager } = JSON.parse(file('package.json')) as Record<string, string>;
  const a = { name: 'a', version: '1.0.0', dependencies: { c: want(url) } };
  const p = { name: 'p', private: true, packageManager, dependencies: { a: 'file:./a' } };
  mkdirSync(join(tree, 'a'));
  writeFileSync(join(tree, 'a/package.json'), JSON.stringify(a));
  writeFileSync(join(tree, 'package.json'), JSON.stringify(p));
  writeFileSync(join(tree, 'pnpm-workspace.yaml'), workspace);
  writeFileSync(join(tree, '.npmrc'), `registry=${url}/\n${url.slice(5)}/:_authToken=${CANARY}\n`);
  const args = ['install', '--ignore-scripts', '--store-dir', join(tree, 'store')];
  return await run('pnpm', args, tree).finally(() => server.close());
}

/** A Semgrep JSON report with `results` findings and `errors` errors, over `scanned`. */
const report = (results = 0, errors = 0, scanned = BOTH) =>
  JSON.stringify({
    results: Array.from({ length: results }),
    errors: Array.from({ length: errors }),
    paths: { scanned },
  });

/** The Semgrep check, with `docker` on PATH replaced by one that prints `out` and exits `exit`. */
async function semgrepWith([out, exit]: readonly [string, number]): Promise<Run> {
  const bin = scratch();
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nprintf '%s' "$FAKE_REPORT"\nexit ${exit}\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  const env = { PATH: `${bin}:${process.env['PATH'] ?? ''}`, FAKE_REPORT: out };
  return await run('bash', ['scripts/local/semgrep-settings.sh'], ROOT, env);
}

describe('CQ-3 supply-chain settings', () => {
  const workspace = file('pnpm-workspace.yaml');
  const renovate = file('renovate.json');
  const runs: Run[] = [];

  it('CQ-3 pnpm settings: minimumReleaseAge, trustPolicy no-downgrade and blockExoticSubdeps stated', () => {
    const want = { ...WANT, blockExoticSubdeps: 'true' };
    const keys = Object.keys(want);
    expect(keys.map((k) => stated(workspace, k))).toStrictEqual(
      Object.values(want).map((v) => [v]),
    );
    expect(workspace).toMatch(/^minimumReleaseAgeExclude:\n {2}- vite@8\.3\.0$/mu);
  });

  it('CQ-3 renovate rules: every package rule carries a minimum release age', () => {
    expect(renovateAges(renovate)).toStrictEqual(['7 days']);
    expect(renovateAges(renovate.replace(/"minimumReleaseAge": "7 days",/u, ''))).toHaveLength(2);
  });

  it('CQ-3 release age: 7 days, 10080 minutes in pnpm and 7 days in every Renovate rule', () => {
    const ages = [stated(workspace, 'minimumReleaseAge'), renovateAges(renovate)];
    expect(ages).toStrictEqual([[WANT.minimumReleaseAge], ['7 days']]);
  });

  it('CQ-3 frozen install: the lockfile installs, vite 8.3.0 included', async () => {
    const tree = scratch();
    for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
      cpSync(join(ROOT, path), join(tree, path));
    for (const dir of ['apps', 'packages'].flatMap((d) =>
      readdirSync(join(ROOT, d)).map((p) => join(d, p)),
    )) {
      const manifest = join(dir, 'package.json');
      if (existsSync(join(ROOT, manifest))) cpSync(join(ROOT, manifest), join(tree, manifest));
    }
    const frozen = await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], tree);
    runs.push(frozen);
    expect(frozen.status, frozen.out).toBe(0);
    const vite = readFileSync(join(tree, 'node_modules/vite/package.json'), 'utf8');
    expect(JSON.parse(vite).version).toBe('8.3.0');
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
    const local = /[1-9]\d* in local scripts/u.test(real.out);
    expect([real.status, local], real.out).toStrictEqual([0, true]);
  });

  it('CQ-3 supply-chain refusals: a trust downgrade, an exotic source and a scanner failure', async () => {
    const tried = await Promise.all([
      install(workspace, () => '1.0.1'),
      install(workspace, byUrl),
      install(workspace.replace('trustPolicy: no-downgrade', 'trustPolicy: off'), () => '1.0.1'),
      install(workspace.replace('Subdeps: true', 'Subdeps: false'), byUrl),
    ]);
    runs.push(...tried);
    const [downgrade, exotic] = tried;
    expect(downgrade.out).toMatch(/trust downgrade for "c@1\.0\.1"/u);
    expect(exotic.out).toContain('ERR_PNPM_EXOTIC_SUBDEP');
    // Refused by the setting, and installed by the same pnpm without it.
    expect(tried.map((t) => t.status === 0)).toStrictEqual([false, false, true, true]);
    const scans = await Promise.all(
      [
        ['', 125],
        ['not a report', 0],
        [report(), 2],
        [report(1), 0],
        [report(0, 1), 0],
        [report(0, 0, ['renovate.json']), 0],
        [report(), 0],
      ].map((c) => semgrepWith(c as [string, number])),
    );
    runs.push(...scans);
    expect(scans.map((s) => s.status)).toStrictEqual([1, 1, 1, 1, 1, 1, 0]);
  }, 120_000);

  it('CQ-3 canary: a planted secret reaches no install log, check output or error', async () => {
    const control = await run('node', ['-e', 'console.error(process.env.CQ3_CANARY_SECRET)'], ROOT);
    expect([control.leaked, control.out.includes(CANARY)]).toStrictEqual([true, false]);
    expect(runs.length).toBeGreaterThanOrEqual(15);
    expect(runs.some((r) => r.status !== 0)).toBe(true);
    expect(runs.filter((r) => r.leaked || r.out.includes(CANARY))).toHaveLength(0);
  });
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('CQ-3 isolation', () => {
  let db: FreshDatabase;
  const parties: string[] = [];
  /** Each business's task, made by its member (write); its client (read) is in `clients`. */
  const own = new Map<string, { task: string; title: string; member: Member }>();
  const clients: { businessId: string; member: Member }[] = [];

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
      const title = `${key}-${randomUUID()}`;
      const create = { command: 'task.create', operationId: randomUUID(), fields: { title } };
      const made = await executeCommand(db.app, id, member.presented, 'api', create as Command);
      own.set(id, { task: 'recordId' in made ? `${made.recordId}` : '', title, member });
      clients.push({ businessId: id, member: client });
      return id;
    };
    // One after the other: installSpine and the grants read the shared catalogue.
    parties.push(await party('bravo'), await party('charlie'));
  }, 60_000);

  afterAll(async () => await db?.drop());

  const checkIsolation = async () => {
    const check = await run('node', ['scripts/pins-check.mjs'], ROOT, { DATABASE_URL: db.appUrl });
    const named = parties.some((id) => check.out.includes(id));
    expect([check.status, named], check.out).toStrictEqual([0, false]);
    // Each client and member, under its own login and at either business, reads, lists (the board,
    // the people) and changes the other business's task. An answer that is not a refusal reaches
    // it when it carries that business, its task, title, member or client.
    const reached = async (who: Member, mine: string, theirs: string) => {
      const t = own.get(theirs);
      const [as, id, edit] = [who.presented, `${t?.task}`, { ...UPDATE, recordId: t?.task }];
      const answers = await Promise.all(
        [mine, theirs].flatMap((at) => [
          executeRead(db.app, at, as, { read: 'task.read', recordId: id }),
          executeRead(db.app, at, as, { read: 'task.board', board: null }),
          executeRead(db.app, at, as, { read: 'person.list' }),
          executeCommand(db.app, at, as, 'api', { ...edit, operationId: randomUUID() } as Command),
        ]),
      );
      const client = clients.find((c) => c.businessId === theirs)?.member;
      const marks = [theirs, id, `${t?.title}`, `${t?.member.personId}`, `${client?.personId}`];
      const text = answers.filter((a) => !('refused' in a)).map((a) => JSON.stringify(a));
      return text.filter((x) => marks.some((m) => x.includes(m))).length;
    };
    const tries = clients.flatMap(({ businessId: mine, member }) => {
      const theirs = `${parties.find((id) => id !== mine)}`;
      return [member, own.get(mine)?.member as Member].map((who) => reached(who, mine, theirs));
    });
    expect(await Promise.all(tries)).toStrictEqual([0, 0, 0, 0]);
    // The control: each client reads its own task, still under its own title.
    const mineRead = async ({ businessId: at, member }: (typeof clients)[number]) => {
      const answer = await executeRead(db.app, at, member.presented, {
        read: 'task.read',
        recordId: `${own.get(at)?.task}`,
      });
      return JSON.stringify(answer).includes(`${own.get(at)?.title}`);
    };
    expect(await Promise.all(clients.map(mineRead))).toStrictEqual([true, true]);
  };

  it(
    'CQ-3 isolation: two businesses, two clients, one grant each; neither reaches the other',
    checkIsolation,
  );

  it('Sol proof, criterion 4: both client bearers have an own task read and a foreign refusal', async () => {
    await checkIsolation();
    const reads = await db.admin.execute<{
      business_id: string;
      actor_id: string;
    }>(
      `select business_id::text, actor_id::text from public.audit_events
        where command = 'task.read' and outcome = 'applied'`,
    );
    const refusals = await db.admin.execute<{
      business_id: string;
      subject_digest: string;
    }>(
      `select business_id::text, subject_digest from public.authentication_attempts
        where refusal_code = 'AUTH_NO_MEMBERSHIP'`,
    );
    const observed = clients.map(({ businessId, member }) => ({
      ownTaskRead: reads.some(
        (row) => row.business_id === businessId && row.actor_id === member.actorId,
      ),
      foreignRefused: refusals.some(
        (row) =>
          row.business_id !== businessId && row.subject_digest === subjectDigest(member.presented),
      ),
    }));
    expect(observed).toStrictEqual([
      { ownTaskRead: true, foreignRefused: true },
      { ownTaskRead: true, foreignRefused: true },
    ]);
  });
});
