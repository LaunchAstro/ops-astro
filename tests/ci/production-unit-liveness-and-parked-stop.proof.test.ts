// SPDX-License-Identifier: AGPL-3.0-only
// Independent review of 2ee177e. All Docker names and volumes belong to this run.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deploy, readDefinition } from '../../scripts/ops/deploy.ts';
import { compare, snapshot } from '../../scripts/ops/service-report.mjs';
import { clean, STAGED, store } from '../../tests/ci/staging-deploy.fixture.ts';
import { WORKER_UNIT } from '../../tests/ci/staging-placeholders.fixture.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 });

it('Sol proof, criterion 7: the new container proof is excluded while browser captures run', () => {
  const target = 'tests/ci/production-unit-parks-and-runs-the-worker.proof.test.ts';
  const listed = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'list', '--filesOnly', target,
  ], {
    env: { ...process.env, CONTAINER_SUITES: 'apart' },
    encoding: 'utf8', timeout: 90_000,
  });
  expect(listed.error).toBeUndefined();
  expect(listed.status, listed.stderr).toBe(0);
  expect(listed.stdout, 'the capture phase must not collect a suite that creates Docker networks')
    .not.toContain(target);
});

it('Sol proof, criterion 4: a worker in restart backoff with no process cannot be recorded as deployed', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sol1357-restarting-'));
  const prefix = `sol1357-restarting-${process.pid}`;
  const whole = readDefinition('production', true);
  const names = Object.keys(whole.services);
  const actual = (name: string) => `${prefix}-${name}`;
  const isolated = join(scratch, 'isolated.json');
  const base = new URL('../../deploy/production/compose.json', import.meta.url).pathname;
  const worker = new URL('../../deploy/production/worker.json', import.meta.url).pathname;
  const env = Object.fromEntries(Object.entries(WORKER_UNIT)
    .map(([key, value]) => [key.replace('STAGING_', 'PRODUCTION_'), value]));
  Object.assign(env, { PRODUCTION_BACKUPS_ADMIN_USER: 'probe', PRODUCTION_BACKUPS_ADMIN_PASSWORD: 'probe-only' });
  writeFileSync(isolated, JSON.stringify({
    name: prefix,
    services: Object.fromEntries(names.map((name) => [name, {
      container_name: actual(name),
      entrypoint: ['sh', '-c', name === 'worker' ? 'sleep 2; exit 1' : 'exec sleep 3600'],
      command: [],
      ...(name === 'backups' ? { healthcheck: { disable: true } } : {}),
    }])),
    networks: Object.fromEntries(['production', 'egress-link', 'egress'].map(name => [name, { name: actual(name) }])),
    volumes: Object.fromEntries(['backups-data', 'tls', 'app'].map(name => [`ops-astro-${name}`, { name: actual(name) }])),
  }));
  const compose = (files: string[], args: string[]) => execFileSync('docker',
    ['compose', ...[...files, isolated].flatMap(file => ['--file', file]), ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, timeout: 60_000, stdio: 'pipe' });
  const normalise = (output: string) => {
    for (const name of names) output = output.replaceAll(actual(name), String(whole.services[name]?.container_name));
    return output;
  };
  const dockerFile = join(scratch, 'inspect.json');
  const launchdFile = join(scratch, 'launchctl.txt');
  writeFileSync(launchdFile, 'PID\tStatus\tLabel\n');
  const containers = names.map(actual);
  const take = () => {
    const report = spawnSync('docker', ['inspect', ...containers], { encoding: 'utf8' });
    writeFileSync(dockerFile, normalise(report.status === 0 ? report.stdout : '[]'));
    return snapshot({ dockerFile, launchdFile });
  };
  const body = read('scripts/ops/deploy.mjs').match(/const effects = (\{[\s\S]*?\n\});/u)?.[1];
  expect(body).toBeDefined();
  const effects = new Function('snapshot', 'compare', 'execFileSync', 'spawnSync', 'containers', `return (${body});`)(
    take, compare,
    (_command: string, args: string[]) => {
      const at = args.indexOf('up');
      compose(args.slice(1, at).filter(arg => arg !== '--file'), args.slice(at));
    },
    (command: string, args: string[], options: object) => {
      const result = spawnSync(command, args, options);
      if (typeof result.stdout === 'string') result.stdout = normalise(result.stdout);
      return result;
    }, containers,
  );
  const inspectImages = effects.runningImages;
  effects.runningImages = () => {
    const deadline = Date.now() + 40_000;
    let state;
    do {
      const inspected = docker(['inspect', '--format', '{{.RestartCount}} {{json .State}}', actual('worker')]);
      const at = inspected.indexOf(' ');
      const restarts = Number(inspected.slice(0, at));
      state = JSON.parse(inspected.slice(at + 1));
      // Docker's first backoff is only 100 ms. The sixth is long enough to
      // bracket the CLI's real inspection with two control observations.
      if (restarts >= 6 && state.Restarting && state.Pid === 0) break;
    } while (Date.now() < deadline);
    expect(state, 'control: the worker has exited and is waiting to restart').toMatchObject({
      Running: true, Restarting: true, Pid: 0,
    });
    const images = inspectImages();
    const after = JSON.parse(docker(['inspect', '--format', '{{json .State}}', actual('worker')]));
    expect(after, 'the restart-backoff state lasted through the actual CLI inspection').toMatchObject({ Restarting: true, Pid: 0 });
    return images;
  };
  try {
    const outcome = await deploy({ version: STAGED, store: store(), worker: true }, effects, clean, 'production');
    expect(outcome, 'an exited worker in restart backoff does not run its pinned image').toMatchObject({ kind: 'failed' });
  } finally {
    compose([base, worker], ['down', '-v', '--timeout', '0']);
    rmSync(scratch, { recursive: true, force: true });
  }
});

it('Sol proof, criterion correctness: the gated stop records success when production has a forwarder and no worker', async () => {
  const prefix = `sol1357-parked-stop-${process.pid}`;
  const forwarder = `${prefix}-forwarder`;
  const absentWorker = `${prefix}-worker`;
  const image = String(readDefinition('production').services.forwarder?.image);
  docker(['run', '--detach', '--name', forwarder, image, 'sleep', '3600']);
  const records: unknown[] = [];
  const failures: string[] = [];
  let exitCode = 0;
  const source = read('scripts/ops/stop-production.mjs').replace(/^import .*;\n/gmu, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('spawnSync', 'recordDeployment', 'requireOperatingOperator', 'process', 'console', source);
  try {
    await run(
      (command: string, args: string[]) => {
        expect(command).toBe('docker');
        const isolatedArgs = args.map(arg => arg === 'ops-astro-worker' ? absentWorker
          : arg === 'ops-astro-forwarder' ? forwarder : arg);
        if (isolatedArgs[0] === 'stop') isolatedArgs.splice(1, 0, '--time', '0');
        return spawnSync(command, isolatedArgs, { encoding: 'utf8' });
      },
      async (_gate: unknown, record: unknown) => { records.push(record); return record; },
      async () => ({ ok: true }),
      { argv: ['node', 'stop-production.mjs'], exit: (code: number) => { exitCode = code; throw new Error(`exit ${code}`); } },
      { error: (message: string) => failures.push(message), log: () => {} },
    ).catch((error: Error) => { if (!/^exit [0-9]+$/u.test(error.message)) throw error; });
    expect(docker(['inspect', '--format', '{{.State.Running}}', forwarder]).trim()).toBe('false');
    expect({ exitCode, records: records.length, failures }, 'the sole running member was stopped and the absent member was already stopped').toMatchObject({ exitCode: 0, records: 1 });
  } finally {
    docker(['rm', '--force', '--volumes', forwarder]);
  }
});
