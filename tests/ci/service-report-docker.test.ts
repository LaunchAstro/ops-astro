// SPDX-License-Identifier: AGPL-3.0-only
// The service report asks Docker itself (ticket S0-1, SNAPSHOTBUF). On the
// production machine 161 containers made one `docker inspect` of them all
// print 1.7 MB, past Node's default 1 MB output buffer, so the snapshot threw
// and the deploy, which takes the same snapshot before and after, would have
// stopped the same way. These run the report against a fake `docker` and
// `launchctl` put first on PATH, the way the machine runs it.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { deploy, type DeployEffects } from '../../scripts/ops/deploy.ts';
// @ts-expect-error -- the report is a plain JavaScript module, as the machine runs it
import * as report from '../../scripts/ops/service-report.mjs';
import { clean, effects, STAGED, store } from './staging-deploy.fixture.ts';

const snapshot = report.snapshot as DeployEffects['snapshot'];
const compare = report.compare as DeployEffects['compare'];
const REPORT = new URL('../../scripts/ops/service-report.mjs', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'service-report-docker-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Container = Record<string, unknown>;

// One container's `docker inspect` entry; `pad` makes its configuration large,
// the way a real container's environment, labels and mounts do.
const container = (n: number, pad = 0): Container => ({
  Id: id(n),
  Name: `/lane-db-${n}`,
  Image: `sha256:${'b'.repeat(64)}`,
  Config: { Image: 'postgres:17', Labels: { note: 'x'.repeat(pad) } },
  State: {
    Running: n % 2 === 0,
    StartedAt: `2026-10-05T00:00:${String(n % 60).padStart(2, '0')}Z`,
  },
  HostConfig: { PortBindings: {} },
  NetworkSettings: { Networks: {} },
});
const id = (n: number): string => n.toString(16).padStart(64, '0');

// A fake `docker` answering `ps -aq --no-trunc` with every id it holds and
// `inspect <id>...` with those entries, or failing as a broken daemon does.
// It is a script on PATH, so the report runs it exactly as it runs Docker.
function fakeTools(
  containers: Container[],
  { fail, listed = '', trailing = '' }: { fail?: string; listed?: string; trailing?: string } = {},
): string {
  const dir = mkdtempSync(join(scratch, 'bin-'));
  writeFileSync(join(dir, 'containers.json'), JSON.stringify(containers));
  const docker = `#!${process.execPath}
const { readFileSync } = require('node:fs');
const [command, ...rest] = process.argv.slice(2);
${fail ? `if (command === ${JSON.stringify(fail)}) { process.stderr.write('Error response from daemon: the fake is down\\n'); process.exit(1); }` : ''}
const all = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'containers.json'))}, 'utf8'));
if (command === 'ps') process.stdout.write(${JSON.stringify(listed)} + all.map((c) => c.Id + '\\n').join(''));
else if (command === 'inspect') process.stdout.write(JSON.stringify(rest.map((i) => all.find((c) => c.Id === i))) + ${JSON.stringify(trailing)});
else process.exit(64);
`;
  const launchctl = `#!/bin/sh\nprintf 'PID\\tStatus\\tLabel\\n411\\t0\\torg.example.live-connector\\n'\n`;
  writeFileSync(join(dir, 'docker'), docker);
  writeFileSync(join(dir, 'launchctl'), launchctl);
  chmodSync(join(dir, 'docker'), 0o755);
  chmodSync(join(dir, 'launchctl'), 0o755);
  return dir;
}

const withPath = (dir: string) => ({
  ...process.env,
  PATH: `${dir}${delimiter}${process.env['PATH']}`,
});
const run = (dir: string, args: string[]) => {
  const result = spawnSync(process.execPath, [REPORT, ...args], {
    encoding: 'utf8',
    env: withPath(dir),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
type Snapshot = { services: { manager: string; name: string }[] };

// Over 1 MB of inspect output: 200 containers of about 8 KB each.
const MANY = Array.from({ length: 200 }, (_, n) => container(n, 8_000));

// ---- S0-1 snapshot over a busy Docker --------------------------------------

it('S0-1 a snapshot over more than 1 MB of docker inspect lists every container once', () => {
  expect(JSON.stringify(MANY).length).toBeGreaterThan(1_048_576);
  const taken = run(fakeTools(MANY), ['snapshot']);
  expect(taken.status, taken.stderr).toBe(0);
  const { services } = JSON.parse(taken.stdout) as Snapshot;
  const docker = services.filter((s) => s.manager === 'docker').map((s) => s.name);
  expect(docker).toStrictEqual(MANY.map((c) => String(c['Name']).slice(1)));
});

it("S0-1 a known container's fields are the ones the report has always kept", () => {
  const known: Container = {
    Id: id(7),
    Name: '/live-runner',
    Image: `sha256:${'a'.repeat(64)}`,
    Config: { Image: 'example/service:1', Env: ['SERVICE_PASSWORD=canary-snapbuf'] },
    State: { Running: true, StartedAt: '2026-09-20T01:00:00Z' },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } },
    NetworkSettings: { Networks: { live: { IPAddress: '172.18.0.2' } } },
  };
  const taken = run(fakeTools([known]), ['snapshot']);
  expect(taken.status, taken.stderr).toBe(0);
  const { services } = JSON.parse(taken.stdout) as Snapshot;
  expect(services[0]).toStrictEqual({
    manager: 'docker',
    name: 'live-runner',
    running: true,
    started: '2026-09-20T01:00:00Z',
    image: `sha256:${'a'.repeat(64)}`,
    ports: ['127.0.0.1:18080->8080/tcp'],
    config: '93e5c1fcb62484bf',
  });
  expect(taken.stdout).not.toContain('canary-snapbuf');
});

it('S0-1 a docker call that fails stops the snapshot with its error and prints no snapshot', () => {
  for (const step of ['ps', 'inspect']) {
    const taken = run(fakeTools(MANY.slice(0, 3), { fail: step }), ['snapshot']);
    expect(taken.status).toBe(2);
    expect(taken.stdout).toBe('');
    expect(taken.stderr).toBe(
      `service-report: no snapshot: docker ${step} failed: Error response from daemon: the fake is down\n`,
    );
  }
  // The shell's `> before.json` still leaves an empty file; compare refuses it.
  const empty = join(scratch, 'before.json');
  writeFileSync(empty, '');
  const fine = join(scratch, 'after.json');
  writeFileSync(fine, run(fakeTools(MANY.slice(0, 3)), ['snapshot']).stdout);
  const compared = spawnSync(process.execPath, [REPORT, 'compare', empty, fine], {
    encoding: 'utf8',
  });
  expect(compared.status).toBe(2);
  expect(compared.stdout).not.toMatch(/GREEN/u);
});

it('S0-1 a container id that is not 64 hex digits is never passed to docker inspect', () => {
  for (const listed of ['--format={{json .}}\n', 'live-runner\n', `${id(0xab).toUpperCase()}\n`]) {
    const taken = run(fakeTools(MANY.slice(0, 3), { listed }), ['snapshot']);
    expect(taken.status).toBe(2);
    expect(taken.stdout).toBe('');
    expect(taken.stderr).toBe(
      'service-report: no snapshot: docker ps printed something other than container ids\n',
    );
  }
});

it('S0-1 inspect output that is not JSON stops the snapshot without quoting it', () => {
  const trailing = '\n{"Env":["SERVICE_PASSWORD=canary-snapbuf"]} garbage';
  const taken = run(fakeTools(MANY.slice(0, 3), { trailing }), ['snapshot']);
  expect(taken.status).toBe(2);
  expect(taken.stdout).toBe('');
  expect(taken.stderr).toBe(
    'service-report: no snapshot: docker inspect printed something other than JSON\n',
  );
});

describe('S0-6 services unchanged over a busy Docker', () => {
  const path = process.env['PATH'];
  afterEach(() => {
    process.env['PATH'] = path;
  });

  it("the deploy's before and after snapshots read more than 1 MB of docker inspect", async () => {
    process.env['PATH'] = withPath(fakeTools(MANY)).PATH;
    const watched = effects({ snapshot, compare });
    const outcome = await deploy({ version: STAGED, store: store() }, watched, clean);
    expect(outcome.kind, JSON.stringify(outcome)).toBe('deployed');
    expect(watched.calls.filter((c) => c === 'snapshot')).toHaveLength(2);
  });

  it('a docker call that fails stops the deploy before anything is started', async () => {
    process.env['PATH'] = withPath(fakeTools(MANY, { fail: 'inspect' })).PATH;
    const watched = effects({ snapshot, compare });
    await expect(deploy({ version: STAGED, store: store() }, watched, clean)).rejects.toThrow(
      'docker inspect failed: Error response from daemon: the fake is down',
    );
    expect(watched.calls).toStrictEqual(['snapshot']);
  });
});
