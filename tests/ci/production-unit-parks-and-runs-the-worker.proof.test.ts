// SPDX-License-Identifier: AGPL-3.0-only
// Reviewer proofs at PR #1357's head. No product file is modified.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { readDefinition } from '../../scripts/ops/deploy.ts';
import { WORKER_UNIT } from './staging-placeholders.fixture.ts';

const scratch = mkdtempSync(join(tmpdir(), 'sol-1357-'));
const prefix = `sol1357-${process.pid}`;
const base = new URL('../../deploy/production/compose.json', import.meta.url).pathname;
const worker = new URL('../../deploy/production/worker.json', import.meta.url).pathname;
const staging = new URL('../../deploy/staging/compose.json', import.meta.url).pathname;
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
