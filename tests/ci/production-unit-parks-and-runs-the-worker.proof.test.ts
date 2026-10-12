// SPDX-License-Identifier: AGPL-3.0-only
// Reviewer proofs at PR #1357's head. No product file is modified.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { deploy, readDefinition, type DeployEffects } from '../../scripts/ops/deploy.ts';
// @ts-expect-error -- production imports this JavaScript module directly too
import { compare, snapshot } from '../../scripts/ops/service-report.mjs';
import { clean, STAGED, store } from './staging-deploy.fixture.ts';
import { WORKER_UNIT } from './staging-placeholders.fixture.ts';

const scratch = mkdtempSync(join(tmpdir(), 'sol-1357-'));
const prefix = `sol1357-${process.pid}`;
const base = new URL('../../deploy/production/compose.json', import.meta.url).pathname;
const worker = new URL('../../deploy/production/worker.json', import.meta.url).pathname;
const staging = new URL('../../deploy/staging/compose.json', import.meta.url).pathname;
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

it('Sol proof, criterion 1: Compose parses the base with every worker setting absent', () => {
  const parked = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('PRODUCTION_WORKER_')),
  );
  const definition = JSON.parse(compose([base], ['config', '--format', 'json'], parked));
  expect(Object.keys(definition.services).sort()).toEqual([
    'backups',
    'egress',
    'egress-out',
    'forwarder',
  ]);
  expect(definition.services.forwarder.depends_on).toBeUndefined();
});

it('Sol proof, criterion 2: the real Compose merge equals staging after renaming', () => {
  const stagedEnv = {
    ...WORKER_UNIT,
    STAGING_BACKUPS_ADMIN_USER: 'probe',
    STAGING_BACKUPS_ADMIN_PASSWORD: 'probe-only',
  };
  const staged = compose([staging], ['config', '--format', 'json'], stagedEnv);
  const renamed = staged
    .replaceAll('ops-astro-staging', 'ops-astro')
    .replaceAll('ops_astro_staging', 'ops_astro')
    .replaceAll('"staging"', '"production"')
    .replace('"madeUpDataOnly": true', '"madeUpDataOnly": false');
  expect(JSON.parse(compose([base, worker], ['config', '--format', 'json']))).toEqual(
    JSON.parse(renamed),
  );
});

it('Sol proof, criterion 1: the actual base processes start without worker settings', () => {
  const run = `${prefix}-base`;
  const isolated = join(scratch, 'base-isolated.json');
  const root = new URL('../../', import.meta.url).pathname;
  const parked = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('PRODUCTION_WORKER_')),
  );
  const definition = readDefinition('production');
  const names = Object.keys(definition.services);
  writeFileSync(
    isolated,
    JSON.stringify({
      name: run,
      services: Object.fromEntries(
        names.map((name) => [name, { container_name: `${run}-${name}` }]),
      ),
      networks: Object.fromEntries(
        ['production', 'egress-link', 'egress'].map((name) => [name, { name: `${run}-${name}` }]),
      ),
      volumes: {
        'ops-astro-backups-data': { name: `${run}-data` },
        'ops-astro-tls': { name: `${run}-tls` },
        'ops-astro-app': {
          name: `${run}-app`,
          driver_opts: { type: 'none', o: 'bind', device: root },
        },
      },
    }),
  );
  const tls = join(scratch, 'tls');
  mkdirSync(tls);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-subj',
      '/CN=proof',
      '-days',
      '1',
      '-keyout',
      join(tls, 'server.key'),
      '-out',
      join(tls, 'server.crt'),
    ],
    { stdio: 'pipe' },
  );
  const image = String(definition.services.backups?.image);
  try {
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${run}-tls:/tls`,
        '-v',
        `${tls}:/src:ro`,
        image,
        'sh',
        '-c',
        'cp /src/server.crt /src/server.key /tls/ && chown 70:70 /tls/* && chmod 600 /tls/server.key',
      ],
      { stdio: 'pipe' },
    );
    compose([base, isolated], ['up', '-d', '--wait', '--wait-timeout', '60'], parked);
    const created = JSON.parse(
      execFileSync('docker', ['inspect', ...names.map((name) => `${run}-${name}`)], {
        encoding: 'utf8',
      }),
    );
    expect(
      created.every((container: { State: { Running: boolean } }) => container.State.Running),
    ).toBe(true);
    expect(created.map((container: { Config: { Cmd: string[] } }) => container.Config.Cmd)).toEqual(
      names.map((name) => definition.services[name]?.command),
    );
  } finally {
    compose([base, isolated], ['down', '-v', '--timeout', '0'], parked);
  }
}, 120_000);

it('Sol proof, criterion 4: a worker stopped after Compose waits cannot be recorded as running', async () => {
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
  // stop after up --wait, modelling the worker ending before inspection.
  const source = readFileSync(new URL('../../scripts/ops/deploy.mjs', import.meta.url), 'utf8');
  const body = source.match(/const effects = (\{[\s\S]*?\n\});/)?.[1];
  expect(body).toBeDefined();
  const exec = (command: string, args: string[], options: object) => {
    if (command === 'docker' && args[0] === 'compose') {
      const at = args.indexOf('up');
      compose([...args.slice(1, at).filter((arg) => arg !== '--file'), override], args.slice(at));
      execFileSync('docker', ['stop', '--time', '0', actual('worker')], { stdio: 'pipe' });
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
    expect(
      execFileSync('docker', ['inspect', '--format', '{{.State.Running}}', actual('worker')], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('false');
    expect(
      outcome,
      'a stopped worker must fail, even when its retained image matches the pin',
    ).toMatchObject({ kind: 'failed' });
  } finally {
    compose([base, worker, override], ['down', '-v', '--timeout', '0']);
  }
}, 180_000);
