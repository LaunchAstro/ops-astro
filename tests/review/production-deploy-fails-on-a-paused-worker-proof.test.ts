// SPDX-License-Identifier: AGPL-3.0-only
// Reviewer proofs at PR #1357's head. No product file is modified.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { deploy, readDefinition, type DeployEffects } from '../../scripts/ops/deploy.ts';
// @ts-expect-error -- production imports this JavaScript module directly too
import { compare, snapshot } from '../../scripts/ops/service-report.mjs';
import { clean, STAGED, store } from '../ci/staging-deploy.fixture.ts';
import { WORKER_UNIT } from '../ci/staging-placeholders.fixture.ts';

const scratch = mkdtempSync(join(tmpdir(), 'sol-1357-'));
const prefix = `sol1357-paused-${process.pid}`;
const base = new URL('../../deploy/production/compose.json', import.meta.url).pathname;
const worker = new URL('../../deploy/production/worker.json', import.meta.url).pathname;
const override = join(scratch, 'isolated.json');
const env = Object.fromEntries(
  Object.entries(WORKER_UNIT).map(([key, value]) => [
    key.replace('STAGING_', 'PRODUCTION_'),
    value,
  ]),
);
Object.assign(env, {
  PRODUCTION_BACKUPS_ADMIN_USER: 'probe',
  PRODUCTION_BACKUPS_ADMIN_PASSWORD: 'probe-only',
});
const compose = (files: string[], args: string[], settings = env) =>
  execFileSync('docker', ['compose', ...files.flatMap((file) => ['-f', file]), ...args], {
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'], ...settings },
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it('Sol proof, criterion 4: a paused worker before inspection cannot be recorded as running', async () => {
  const whole = readDefinition('production', true);
  const names = Object.keys(whole.services);
  const actual = (service: string) => `${prefix}-${service}`;
  writeFileSync(
    override,
    JSON.stringify({
      name: prefix,
      services: Object.fromEntries(
        names.map((name) => [
          name,
          {
            container_name: actual(name),
            // Stand-ins preserve pins and containment. Postgres's real TLS provisioning
            // and external sign-ins are outside this liveness proof.
            entrypoint: ['sh', '-c', 'exec sleep 3600'],
            command: [],
            ...(name === 'backups' ? { healthcheck: { disable: true } } : {}),
          },
        ]),
      ),
      networks: Object.fromEntries(
        ['production', 'egress-link', 'egress'].map((name) => [
          name,
          { name: `${prefix}-${name}` },
        ]),
      ),
      volumes: Object.fromEntries(
        ['backups-data', 'tls', 'app'].map((name) => [
          `ops-astro-${name}`,
          { name: `${prefix}-${name}` },
        ]),
      ),
    }),
  );
  const containers = names.map(actual);
  const normalise = (output: string) => {
    for (const name of names)
      output = output.replaceAll(actual(name), String(whole.services[name]?.container_name));
    return output;
  };
  const launchdFile = join(scratch, 'launchctl.txt');
  const dockerFile = join(scratch, 'inspect.json');
  writeFileSync(launchdFile, 'PID\tStatus\tLabel\n');
  const take = () => {
    const ids = spawnSync('docker', ['inspect', ...containers], { encoding: 'utf8' });
    // Before up, all proof containers are absent.
    writeFileSync(dockerFile, normalise(ids.status === 0 ? ids.stdout : '[]'));
    return snapshot({ dockerFile, launchdFile });
  };
  // Evaluate the exact CLI effects object, including its real image inspection.
  // The only command adapter adds this run's isolation override and a deterministic
  // pause after up --wait, freezing the worker before inspection.
  const source = readFileSync(new URL('../../scripts/ops/deploy.mjs', import.meta.url), 'utf8');
  const body = source.match(/const effects = (\{[\s\S]*?\n\});/)?.[1];
  expect(body).toBeDefined();
  const exec = (command: string, args: string[], options: object) => {
    if (command === 'docker' && args[0] === 'compose') {
      const at = args.indexOf('up');
      compose([...args.slice(1, at).filter((arg) => arg !== '--file'), override], args.slice(at));
      execFileSync('docker', ['pause', actual('worker')], { stdio: 'pipe' });
      return;
    }
    return execFileSync(command, args, options);
  };
  const spawn: typeof spawnSync = ((...args: Parameters<typeof spawnSync>) => {
    const result = spawnSync(...args);
    if (typeof result.stdout === 'string') result.stdout = normalise(result.stdout);
    return result;
  }) as typeof spawnSync;
  const effects = new Function(
    'snapshot',
    'compare',
    'execFileSync',
    'spawnSync',
    'containers',
    `return (${body});`,
  )(take, compare, exec, spawn, containers) as DeployEffects;
  try {
    const outcome = await deploy(
      { version: STAGED, store: store(), worker: true },
      effects,
      clean,
      'production',
    );
    const state = JSON.parse(execFileSync('docker', [
      'inspect', '--format', '{{json .State}}', actual('worker'),
    ], { encoding: 'utf8' }));
    expect(state, 'control: the worker is frozen before the deploy is judged').toMatchObject({
      Running: true, Restarting: false, Paused: true,
    });
    expect(state.Pid).toBeGreaterThan(0);
    expect(
      outcome,
      'a paused worker must fail because its process cannot execute, even though its image matches the pin',
    ).toMatchObject({ kind: 'failed' });
  } finally {
    compose([base, worker, override], ['down', '-v', '--timeout', '0']);
  }
}, 180_000);
