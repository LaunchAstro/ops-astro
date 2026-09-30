// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 egress allow-list: the worker unit and the backup dump reach exactly
// the API, pooler, heartbeat and sink hosts, each a setting. Table half: the
// script and compose.json; live half: both hops beside stand-ins for the four
// and one place off the list.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASK_SCRIPT, hello, IDLE_SCRIPT, STAND_SCRIPT } from './staging-egress.fixture.ts';
import { WORKER_UNIT } from './staging-placeholders.fixture.ts';

type EgressModule = {
  allowList: (env: Record<string, string | undefined>) => [string, number][];
  serverName: (hello: Buffer) => string | undefined;
};
const EGRESS = '../../scripts/ops/egress.mjs';
const { allowList, serverName } = (await import(
  /* @vite-ignore */
  EGRESS
)) as EgressModule;

const ROOT = resolve(import.meta.dirname, '../..');
const CANARY = 'canary-egress-7f3c.example.test';
const LIST = {
  STAGING_WEB_URL: 'https://api.example.test',
  OPS_EGRESS_POOLER_HOST: 'pooler.example.test',
  OPS_EGRESS_POOLER_PORT: '6543',
  OPS_EGRESS_HEARTBEAT_HOST: 'beat.example.test',
  OPS_EGRESS_SINK_HOST: 'sink.example.test',
};

type Service = { networks?: string[] | Record<string, { aliases?: string[] }> };
type Definition = {
  services: Record<string, Service>;
  networks: Record<string, { name: string; internal?: boolean }>;
};
const load = (): Definition =>
  JSON.parse(readFileSync(resolve(ROOT, 'deploy/staging/compose.json'), 'utf8')) as Definition;
const netsOf = (s: Service): string[] =>
  Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {});

describe('S0-1 egress allow-list', () => {
  listCases();
  nameAndRouteCases();
});

function listCases() {
  it('the allow-list is exactly the four named destinations', () => {
    expect(allowList(LIST)).toEqual([
      ['api.example.test', 443],
      ['pooler.example.test', 6543],
      ['beat.example.test', 443],
      ['sink.example.test', 443],
    ]);
  });

  it('each setting unset or malformed is refused by its name, never its value', () => {
    for (const name of Object.keys(LIST)) {
      for (const bad of [undefined, '', `x/${CANARY}`, `${CANARY}:1`, '1.2.3.4:5', 'ab..cd']) {
        const env = { ...LIST, [name]: bad };
        let message = '';
        try {
          allowList(env);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, `${name}=${String(bad)}`).toContain(name);
        expect(message.includes(CANARY)).toBe(false);
      }
    }
    expect(() => allowList({ ...LIST, OPS_EGRESS_POOLER_PORT: '443' })).toThrow(
      'OPS_EGRESS_POOLER_PORT',
    );
    const run = spawnSync(process.execPath, ['scripts/ops/egress.mjs', 'out'], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'] ?? '', ...LIST, OPS_EGRESS_SINK_HOST: `x/${CANARY}` },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('OPS_EGRESS_SINK_HOST');
    expect(run.stderr.includes(CANARY)).toBe(false);
  });
}

function nameAndRouteCases() {
  it("the relay reads the hello's server name; a short or malformed hello names nothing", () => {
    expect(serverName(hello('API.example.test'))).toBe('api.example.test');
    const whole = hello('api.example.test');
    for (const cut of [0, 5, 20, 43, whole.length - 3]) {
      expect(serverName(whole.subarray(0, cut)), `cut ${cut}`).not.toBe('api.example.test');
    }
    expect(serverName(Buffer.from('GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n'))).toBe(
      undefined,
    );
    const noName = Buffer.from(whole);
    // The extension's type made ALPN (16): a hello with no server name extension.
    noName[whole.length - 'api.example.test'.length - 8] = 0x10;
    expect(serverName(noName)).toBe(undefined);
  });

  it('egress-out is the one service with a route out, alone on its network, and the relay answers for the four', () => {
    const def = load();
    const out = Object.entries(def.services).flatMap(([name, s]) =>
      netsOf(s)
        .filter((n) => def.networks[n]?.internal !== true)
        .map((n) => `${name} -> ${n}`),
    );
    expect(out).toEqual(['egress-out -> egress']);
    expect(def.networks['egress']?.internal).toBe(false);
    expect(def.networks['egress-link']?.internal).toBe(true);
    expect(netsOf(def.services['egress-out']!).toSorted()).toEqual(['egress', 'egress-link']);
    expect(netsOf(def.services['egress']!).toSorted()).toEqual(['egress-link', 'staging']);
    const others = Object.entries(def.services).filter(([name]) => !name.startsWith('egress'));
    for (const [name, s] of others) expect(netsOf(s), name).toEqual(['staging']);
    const relay = def.services['egress']!.networks as Record<string, { aliases?: string[] }>;
    expect(relay['staging']?.aliases).toEqual([
      '${STAGING_EGRESS_API_HOST:?set from the staging runbook}',
      '${STAGING_EGRESS_POOLER_HOST:?set from the staging runbook}',
      '${STAGING_EGRESS_HEARTBEAT_HOST:?set from the staging runbook}',
      '${STAGING_EGRESS_SINK_HOST:?set from the staging runbook}',
    ]);
  });
}

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const live = dockerUp || process.env['CI'] ? describe : describe.skip;
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', env, timeout: 180_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};

const project = `s01eg-${process.pid}`;
const names = (suffix: string) => `${project}-${suffix}`;
// The hops' own pinned image, the worker's.
const node = String((load().services['worker'] as Record<string, unknown>)['image']);
const override = resolve(ROOT, `.tmp-${project}.json`);
const env = {
  ...process.env,
  STAGING_BACKUPS_ADMIN_USER: 'probe',
  STAGING_BACKUPS_ADMIN_PASSWORD: 'probe-only',
  ...WORKER_UNIT,
};
const compose = (args: string[]) =>
  docker(
    ['compose', '-p', project, '-f', 'deploy/staging/compose.json', '-f', override, ...args],
    env,
  );
const stand = [
  ['api', 'api.example.test', '443'],
  ['pooler', 'pooler.example.test', '6543'],
  ['beat', 'beat.example.test', '443'],
  ['sink', 'sink.example.test', '443'],
  ['elsewhere', 'elsewhere.example.test', '443'],
] as const;
/** From a container on staging: connect, send `bytes`, print what comes back. */
const ask = (host: string, port: string, bytes: Buffer) =>
  docker([
    'run',
    '--rm',
    '--network',
    names('staging'),
    '-e',
    `H=${host}`,
    '-e',
    `P=${port}`,
    '-e',
    `B=${bytes.toString('hex')}`,
    node,
    'node',
    '-e',
    ASK_SCRIPT,
  ]).out;

/** The override naming this run's hops, networks and volumes; the app volume filled. */
function prepare(): void {
  const staging = names('staging');
  const out = names('egress');
  const app = names('app');
  const overrideDef = {
    services: {
      egress: { container_name: names('relay') },
      'egress-out': { container_name: names('out') },
    },
    networks: {
      staging: { name: staging },
      'egress-link': { name: names('egress-link') },
      egress: { name: out },
    },
    volumes: {
      'ops-astro-staging-app': { name: app },
      'ops-astro-staging-backups-data': { name: names('backups-data') },
      'ops-astro-staging-tls': { name: names('tls') },
    },
  };
  writeFileSync(override, JSON.stringify(overrideDef));
  // The checkout the hops run from: this script alone, in the app volume.
  const filled = docker([
    'run',
    '--rm',
    '-v',
    `${app}:/app`,
    '-v',
    `${resolve(ROOT, 'scripts/ops/egress.mjs')}:/src/egress.mjs:ro`,
    node,
    'sh',
    '-c',
    'mkdir -p /app/scripts/ops && cp /src/egress.mjs /app/scripts/ops/',
  ]);
  expect(filled.status, filled.out).toBe(0);
}

/** Both hops up, and a stand-in for each listed place and one off the list. */
function bringUp(): void {
  prepare();
  const out = names('egress');
  const up = compose(['up', '-d', 'egress', 'egress-out']);
  expect(up.status, up.out).toBe(0);
  for (const [who, host, port] of stand) {
    const started = docker([
      'run',
      '-d',
      '--name',
      names(`stand-${who}`),
      '--network',
      out,
      '--network-alias',
      host,
      '-e',
      `N=${who}`,
      '-e',
      `P=${port}`,
      node,
      'node',
      '-e',
      STAND_SCRIPT,
    ]);
    expect(started.status, started.out).toBe(0);
  }
  spawnSync('sleep', ['2']);
}

function tearDown(): void {
  for (const [who] of stand) docker(['rm', '-f', names(`stand-${who}`)]);
  compose(['down', '-v', '--timeout', '1']);
  docker(['volume', 'rm', '-f', names('app')]);
  rmSync(override, { force: true });
}

live('S0-1 egress allow-list, live', () => {
  beforeAll(bringUp, 300_000);
  afterAll(tearDown, 120_000);
  liveCases();
});

function liveCases() {
  it('a pooled connection may idle past the first-bytes limit and still carry bytes', () => {
    const idle = docker([
      'run',
      '--rm',
      '--network',
      names('staging'),
      node,
      'node',
      '-e',
      IDLE_SCRIPT,
    ]);
    expect(idle.out).toBe('twice');
  }, 120_000);

  it('each listed destination is reachable from staging through the relay, by its own name', () => {
    expect(ask('api.example.test', '443', hello('api.example.test'))).toBe('got:from-api');
    expect(ask('beat.example.test', '443', hello('beat.example.test'))).toBe('got:from-beat');
    expect(ask('sink.example.test', '443', hello('sink.example.test'))).toBe('got:from-sink');
    expect(ask('pooler.example.test', '6543', Buffer.from('ssl?'))).toBe('got:from-pooler');
  }, 120_000);

  it('a host off the list is refused, though it answers on the outside', () => {
    // The control: from the outside network, the off-list stand-in answers.
    const control = docker([
      'run',
      '--rm',
      '--network',
      names('egress'),
      node,
      'node',
      '-e',
      "const s=require('net').connect(443,'elsewhere.example.test',()=>s.write('x'));s.on('data',d=>{console.log(String(d));process.exit(0)})",
    ]);
    expect(control.out).toBe('from-elsewhere');
    // Asked of the relay by name, and straight by name: nothing comes back.
    expect(ask('api.example.test', '443', hello('elsewhere.example.test'))).toBe('got:');
    expect(ask('elsewhere.example.test', '443', hello('elsewhere.example.test'))).toBe('got:');
    expect(ask('api.example.test', '6543', Buffer.from('ssl?'))).toBe('got:from-pooler');
    expect(ask('api.example.test', '80', Buffer.from('GET /'))).toBe('got:');
  }, 120_000);
}
