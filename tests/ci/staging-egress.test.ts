// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 egress allow-list (ORCH40's egress ruling): the worker unit and the
// backup dump reach exactly the API host, the pooler's host and port, the
// watcher's heartbeat host and the error sink's host, each from a named
// setting, and nothing else. The table half reads the script and
// deploy/staging/compose.json; the live half brings the two egress hops up
// beside stand-ins for the four places and one place off the list.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKER_UNIT } from './staging-placeholders.fixture.ts';

type EgressModule = {
  allowList: (env: Record<string, string | undefined>) => [string, number][];
  serverName: (hello: Buffer) => string | undefined;
};
const EGRESS = '../../scripts/ops/egress.mjs';
const { allowList, serverName } = (await import(/* @vite-ignore */ EGRESS)) as EgressModule;

const ROOT = resolve(import.meta.dirname, '../..');
const CANARY = 'canary-egress-7f3c.example.test';
const LIST = {
  OPS_EGRESS_API_HOST: 'api.example.test',
  OPS_EGRESS_POOLER_HOST: 'pooler.example.test',
  OPS_EGRESS_POOLER_PORT: '6543',
  OPS_EGRESS_HEARTBEAT_HOST: 'beat.example.test',
  OPS_EGRESS_SINK_HOST: 'sink.example.test',
};

/** A TLS 1.3 ClientHello carrying `name` as its server name, as a client sends it. */
function hello(name: string): Buffer {
  const host = Buffer.from(name, 'latin1');
  const sni = Buffer.concat([
    Buffer.from([0, 0]),
    u16(host.length + 5),
    u16(host.length + 3),
    Buffer.from([0]),
    u16(host.length),
    host,
  ]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(sni.length),
    sni,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake]);
}
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

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
    noName[whole.length - 'api.example.test'.length - 6] = 0x10;
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
});

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const live = dockerUp || process.env['CI'] ? describe : describe.skip;
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', env, timeout: 180_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
};

live('S0-1 egress allow-list, live', () => {
  const project = `s01eg-${process.pid}`;
  const names = (suffix: string) => `${project}-${suffix}`;
  // The hops' own pinned image, the worker's.
  const node = String((load().services['worker'] as Record<string, unknown>)['image']);
  const override = resolve(ROOT, `.tmp-${project}.json`);
  // The shared placeholders name the same four places as LIST.
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
      "const s=require('net').connect(+process.env.P,process.env.H,()=>s.write(Buffer.from(process.env.B,'hex')));let o='';s.on('data',d=>o+=d);s.on('close',()=>{console.log('got:'+o);process.exit(0)});s.on('error',()=>{console.log('got:');process.exit(0)});setTimeout(()=>{console.log('got:'+o);process.exit(0)},8000)",
    ]).out;

  beforeAll(() => {
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
        "require('net').createServer(s=>s.once('data',()=>s.end('from-'+process.env.N))).listen(+process.env.P)",
      ]);
      expect(started.status, started.out).toBe(0);
    }
    spawnSync('sleep', ['2']);
  }, 300_000);

  afterAll(() => {
    for (const [who] of stand) docker(['rm', '-f', names(`stand-${who}`)]);
    compose(['down', '-v', '--timeout', '1']);
    rmSync(override, { force: true });
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
});
