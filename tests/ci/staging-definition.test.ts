// SPDX-License-Identifier: AGPL-3.0-only
// S0-1a: the staging definition, the before-and-after service report and the
// credentials canary. The report is run as its CLI, the way the owner runs it
// on the machine, over fixture service lists written here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const REPORT = new URL('../../scripts/ops/service-report.mjs', import.meta.url).pathname;

type Service = {
  container_name?: string;
  image?: string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  networks?: string[];
  [key: string]: unknown;
};
type Definition = {
  name: string;
  'x-ops-astro': { ownPrefix: string; productionDatabaseMajor: number; artefact: string };
  services: Record<string, Service>;
  networks: Record<string, { name: string }>;
  volumes: Record<string, { name: string }>;
};
const definition = (): Definition => JSON.parse(read('deploy/staging/compose.json')) as Definition;

const PLACEHOLDER = /\$\{(?<name>[A-Z0-9_]+)(?::\?[^}]*)?\}/gu;
const CANARY = 'canary-7f3c1e0b9d-staging-secret';

// ---- fixtures: raw `docker inspect` and `launchctl list` output -----------

type Container = { name: string; started: string; running?: boolean; port?: string };
const inspect = (containers: Container[]): string =>
  JSON.stringify(
    containers.map((c) => ({
      Name: `/${c.name}`,
      Image: `sha256:${'a'.repeat(64)}`,
      Config: {
        Image: 'example/service:1',
        Env: [`SERVICE_PASSWORD=${CANARY}`, `DATABASE_URL=postgres://u:${CANARY}@db/x`],
        Cmd: ['serve', `--token=${CANARY}`],
      },
      State: { Running: c.running ?? true, StartedAt: c.started },
      HostConfig: {
        PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: c.port ?? '18080' }] },
      },
    })),
  );
const launchctl = (jobs: [string, string][]): string =>
  ['PID\tStatus\tLabel', ...jobs.map(([pid, label]) => `${pid}\t0\t${label}`)].join('\n');

const LIVE: Container[] = [
  { name: 'live-runner', started: '2026-09-20T01:00:00Z' },
  { name: 'live-workflows', started: '2026-09-20T01:00:05Z', port: '18081' },
];
const JOBS: [string, string][] = [
  ['411', 'org.example.live-connector'],
  ['-', 'org.example.nightly'],
  ['512', 'com.apple.noise'],
];

const scratch = mkdtempSync(join(tmpdir(), 's0-1a-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
const file = (text: string): string => {
  files += 1;
  const path = join(scratch, `f${files}`);
  writeFileSync(path, text);
  return path;
};
const run = (args: string[]) => {
  const result = spawnSync(process.execPath, [REPORT, ...args], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};
const snapshot = (containers: Container[], jobs: [string, string][]): string => {
  const result = run([
    'snapshot',
    '--docker-inspect',
    file(inspect(containers)),
    '--launchctl',
    file(launchctl(jobs)),
  ]);
  expect(result.status, result.out).toBe(0);
  return file(result.out);
};
const compare = (before: string, after: string) => run(['compare', before, after]);

// ---- S0-1 services unchanged (the invariant) -------------------------------

it('S0-1 services unchanged', () => {
  const before = snapshot(LIVE, JOBS);
  const own = { name: 'ops-astro-staging-db', started: '2026-09-29T02:00:00Z', port: '18090' };

  // Staging arriving beside the live services is green, and named as staging's.
  const green = compare(before, snapshot([...LIVE, own], [...JOBS, ['900', 'com.apple.more']]));
  expect(green.status, green.out).toBe(0);
  expect(green.out).toMatch(/staging's own: ops-astro-staging-db/u);
  expect(green.out).toMatch(/GREEN/u);

  // A planted restart of one live container goes red and names it.
  const restarted = LIVE.map((c, i) => (i === 0 ? { ...c, started: '2026-09-29T02:00:01Z' } : c));
  const red1 = compare(before, snapshot([...restarted, own], JOBS));
  expect(red1.status, red1.out).toBe(1);
  expect(red1.out).toMatch(/RESTARTED docker live-runner/u);

  // A changed port on a live container goes red.
  const moved = LIVE.map((c, i) => (i === 1 ? { ...c, port: '18082' } : c));
  const red2 = compare(before, snapshot(moved, JOBS));
  expect(red2.status, red2.out).toBe(1);
  expect(red2.out).toMatch(/PORT CHANGED docker live-workflows/u);

  // A launchd job with a new process is a restart; a stopped container and a
  // vanished job are red too.
  const red3 = compare(before, snapshot(LIVE, [['412', JOBS[0]![1]], JOBS[1]!]));
  expect(red3.out).toMatch(/RESTARTED launchd org\.example\.live-connector/u);
  const red4 = compare(before, snapshot([{ ...LIVE[0]!, running: false }, LIVE[1]!], JOBS));
  expect(red4.out).toMatch(/STOPPED docker live-runner/u);
  const red5 = compare(before, snapshot(LIVE, [JOBS[1]!]));
  expect(red5.out).toMatch(/GONE launchd org\.example\.live-connector/u);
  for (const red of [red3, red4, red5]) expect(red.status, red.out).toBe(1);

  // Apple's own on-demand jobs are not live services of this installation.
  expect(green.out).not.toMatch(/com\.apple/u);
});

it('S0-1 services unchanged: a report it cannot read is refused, never green', () => {
  const before = snapshot(LIVE, JOBS);
  const broken = run(['compare', before, file('not json')]);
  expect(broken.status).toBe(2);
  expect(broken.out).not.toMatch(/GREEN/u);
  expect(run(['compare', before]).status).toBe(2);
});

it('Sol proof, criterion 5: a live container configuration change makes the report red', () => {
  const container = JSON.parse(inspect(LIVE)) as Record<string, unknown>[];
  const before = run([
    'snapshot',
    '--docker-inspect',
    file(JSON.stringify(container)),
    '--launchctl',
    file(launchctl(JOBS)),
  ]);
  expect(before.status, before.out).toBe(0);
  const beforeFile = file(before.out);
  const changed = structuredClone(container);
  const live = changed[0] as { HostConfig: { Memory?: number } };
  live.HostConfig.Memory = 64 * 1024 * 1024;
  const after = run([
    'snapshot',
    '--docker-inspect',
    file(JSON.stringify(changed)),
    '--launchctl',
    file(launchctl(JOBS)),
  ]);
  expect(after.status, after.out).toBe(0);
  const report = compare(beforeFile, file(after.out));
  expect(report.status, report.out).toBe(1);
  expect(report.out).toMatch(/CONFIG|RECONFIGURED|MEMORY CHANGED/u);
});

it('Sol proof, criterion 5: a live network attachment change makes the report red', () => {
  const containers = JSON.parse(inspect(LIVE)) as Record<string, unknown>[];
  containers[0]!['NetworkSettings'] = { Networks: { live: { NetworkID: 'live-network' } } };
  const before = run([
    'snapshot',
    '--docker-inspect',
    file(JSON.stringify(containers)),
    '--launchctl',
    file(launchctl(JOBS)),
  ]);
  expect(before.status, before.out).toBe(0);
  const afterContainers = structuredClone(containers);
  afterContainers[0]!['NetworkSettings'] = {
    Networks: { live: { NetworkID: 'live-network' }, added: { NetworkID: 'other-network' } },
  };
  const after = run([
    'snapshot',
    '--docker-inspect',
    file(JSON.stringify(afterContainers)),
    '--launchctl',
    file(launchctl(JOBS)),
  ]);
  expect(after.status, after.out).toBe(0);
  const report = compare(file(before.out), file(after.out));
  expect(report.status, report.out).toBe(1);
  expect(report.out).toMatch(/RECONFIGURED docker live-runner/u);
});

it('Sol proof, criterion 5: a live network endpoint address change makes the report red', () => {
  const withAddress = (address: string): string => {
    const containers = JSON.parse(inspect(LIVE)) as Record<string, unknown>[];
    containers[0]!['NetworkSettings'] = {
      Networks: { live: { NetworkID: 'live-network', IPAddress: address } },
    };
    const result = run([
      'snapshot',
      '--docker-inspect',
      file(JSON.stringify(containers)),
      '--launchctl',
      file(launchctl(JOBS)),
    ]);
    expect(result.status, result.out).toBe(0);
    return file(result.out);
  };
  const report = compare(withAddress('172.20.0.10'), withAddress('172.20.0.11'));
  expect(report.status, report.out).toBe(1);
  expect(report.out).toMatch(/RECONFIGURED docker live-runner/u);
});

// ---- S0-1 credentials canary -------------------------------------------------

it('S0-1 credentials canary', () => {
  const before = snapshot(LIVE, JOBS);
  expect(readFileSync(before, 'utf8')).not.toContain(CANARY);
  const moved: Container[] = LIVE.map((c) =>
    Object.assign({}, c, { started: '2026-09-29T03:00:00Z' }),
  );
  const report = compare(before, snapshot(moved, JOBS));
  expect(report.status).toBe(1);
  expect(report.out).not.toContain(CANARY);

  // The definition carries no credential: each is a runbook placeholder.
  const text = read('deploy/staging/compose.json');
  for (const [name, service] of Object.entries(definition().services)) {
    for (const [key, value] of Object.entries(service.environment ?? {})) {
      if (!/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL/u.test(key)) continue;
      expect(value, `${name}.${key}`).toMatch(/^\$\{STAGING_[A-Z0-9_]+:\?[^}]+\}$/u);
    }
  }
  expect(text).not.toMatch(/ops_astro_local|conformance-throwaway|postgres:\/\/[^$]/u);
});

// ---- the definition: apart from the machine's live services ------------------

it('S0-1 staging apart: own names, own ports, own credentials, no layout', () => {
  const def = definition();
  const prefix = def['x-ops-astro'].ownPrefix;
  expect(prefix).toBe('ops-astro-staging');
  expect(def.name).toBe(prefix);
  expect(Object.keys(def.services).toSorted()).toEqual(['auth', 'db']);

  for (const [name, service] of Object.entries(def.services)) {
    expect(service.container_name, name).toBe(`${prefix}-${name}`);
    for (const shared of ['network_mode', 'pid', 'ipc', 'privileged', 'userns_mode'])
      expect(service[shared], `${name}.${shared}`).toBeUndefined();
    expect(service.networks, name).toEqual(['staging']);
    // Published on loopback only, on a port the runbook names, never a fixed one.
    for (const port of service.ports ?? [])
      expect(port, name).toMatch(/^127\.0\.0\.1:\$\{STAGING_[A-Z_]+_PORT:\?[^}]+\}:\d+$/u);
    // Named volumes only: no path on the machine.
    for (const volume of service.volumes ?? [])
      expect(volume, name).toMatch(/^ops-astro-staging-/u);
  }
  for (const network of Object.values(def.networks))
    expect(network.name).toMatch(/^ops-astro-staging/u);
  for (const volume of Object.values(def.volumes))
    expect(volume.name).toMatch(/^ops-astro-staging-/u);

  const text = read('deploy/staging/compose.json');
  const names = [...text.matchAll(PLACEHOLDER)].map((m) => m.groups!['name']!);
  expect(names.length).toBeGreaterThan(5);
  for (const name of names) expect(name).toMatch(/^STAGING_/u);
  // No machine layout: no address but loopback (and the auth server's listen-on-all
  // inside its own container), no host path, no user's home.
  expect(
    text
      .match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu)
      ?.filter((ip) => !['127.0.0.1', '0.0.0.0'].includes(ip)) ?? [],
  ).toEqual([]);
  expect(text).not.toMatch(/"\/(?:Users|home|srv|opt|var\/lib\/docker)\b/u);
});

// ---- S0-1 database majors ----------------------------------------------------

it('S0-1 database majors', () => {
  const def = definition();
  // LF-3, answered 28 September 2026: the hosted production major is 17.
  expect(def['x-ops-astro'].productionDatabaseMajor).toBe(17);
  const image = def.services['db']!.image!;
  const match = /^postgres:(?<major>\d+)-alpine@sha256:(?<digest>[0-9a-f]{64})$/u.exec(image);
  expect(match, image).not.toBeNull();
  expect(Number(match!.groups!['major'])).toBe(def['x-ops-astro'].productionDatabaseMajor);
  // The pin is recorded where every other image pin is.
  expect(read('docs/supply-chain-pins.md')).toMatch(
    new RegExp(
      `\\| \`postgres\`\\s+\\| \`17-alpine\`\\s+\\| \`sha256:${match!.groups!['digest']}\``,
      'u',
    ),
  );
  // The auth server is the same pinned build the local slice runs.
  const auth = def.services['auth']!.image!;
  expect(read('scripts/local/auth-up.sh')).toContain(`AUTH_IMAGE=${auth}\n`);
});
