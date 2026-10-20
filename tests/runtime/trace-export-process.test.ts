// SPDX-License-Identifier: AGPL-3.0-only
//
// #1708: the M5's trace export process (`apps/trace-export/main.ts`), run as
// launchd runs it, against a counting stand-in for the database and the trace
// target on loopback. Off (unset or `off`), it opens no connection to either.
// Run with any runtime flag beyond `--disable-sigusr1`, or with a preload or
// coverage writer in its environment, it refuses before its settings file is
// read; running, SIGUSR1 opens no inspector. A settings file others may read is
// refused, and a problem names its setting, never the value. The plist runs it
// with the one flag and only the settings file's path.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const ENTRY = 'apps/trace-export/main.ts';
const BUSINESS = '4f1c2a9e-6b1d-4c3a-9e2f-0a1b2c3d4e5f';
const CANARY = `trace-canary-${String(process.pid)}-${String(Date.now())}`;

let folder = '';
let database: Server;
let target: HttpServer;
let databasePort = 0;
let targetPort = 0;
let connections = 0;
let requests = 0;
const running: ReturnType<typeof spawn>[] = [];

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'trace-export-process-'));
  database = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  target = createHttpServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((done) => {
    database.listen(0, '127.0.0.1', done);
  });
  await new Promise<void>((done) => {
    target.listen(0, '127.0.0.1', done);
  });
  databasePort = (database.address() as AddressInfo).port;
  targetPort = (target.address() as AddressInfo).port;
});

afterEach(() => {
  for (const child of running.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

afterAll(async () => {
  await new Promise<void>((done) => {
    database.close(() => done());
  });
  await new Promise<void>((done) => {
    target.close(() => done());
  });
  rmSync(folder, { recursive: true, force: true });
});

let files = 0;
function file(text: string, mode = 0o600): string {
  files += 1;
  const path = join(folder, `file-${String(files)}`);
  writeFileSync(path, text, { mode });
  return path;
}

/** A complete settings file: the given switch, the stand-ins, and owner-only key files. */
function settings(toggle: string | undefined, extra: Record<string, string> = {}, mode = 0o600) {
  const credentials = file(
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'trace-process',
        destination: 'trace_target',
        header: 'authorization',
        scheme: 'basic',
        value: `public:${CANARY}`,
      },
    ]),
  );
  const lines = {
    ...(toggle === undefined ? {} : { TRACE_EXPORT: toggle }),
    TRACE_EXPORT_ORIGIN: `http://127.0.0.1:${String(targetPort)}`,
    TRACE_EXPORT_CREDENTIALS_FILE: credentials,
    TRACE_EXPORT_KEY_FILE: file('ab'.repeat(32)),
    DATABASE_TRACE_URL: `postgres://trace:${CANARY}@127.0.0.1:${String(databasePort)}/ops`,
    TRACE_EXPORT_BUSINESSES: BUSINESS,
    ...extra,
  };
  const text = Object.entries(lines)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
  return file(text, mode);
}

interface Run {
  readonly child: ReturnType<typeof spawn>;
  readonly out: () => string;
  readonly exited: Promise<number | null>;
}

function start(
  settingsFile?: string,
  flags: readonly string[] = ['--disable-sigusr1'],
  env: Record<string, string> = {},
): Run {
  let out = '';
  const child = spawn(process.execPath, [...flags, ENTRY], {
    cwd: ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      ...(settingsFile === undefined ? {} : { TRACE_EXPORT_SETTINGS_FILE: settingsFile }),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const exited = new Promise<number | null>((done) => {
    child.once('exit', (code) => done(code));
  });
  return { child, out: () => out, exited };
}

async function until(done: () => boolean, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out');
    // eslint-disable-next-line no-await-in-loop -- polling the child's output
    await sleep(25);
  }
}

it('with export unset or off the process opens no database connection and sends nothing', async () => {
  const before = { connections, requests };
  for (const toggle of [undefined, 'off']) {
    const run = start(settings(toggle));
    // eslint-disable-next-line no-await-in-loop -- one run after another
    expect(await run.exited).toBe(0);
    expect(run.out()).toBe('trace export: off\n');
  }
  await sleep(200);
  expect({ connections, requests }).toStrictEqual(before);
}, 120_000);

it.each([
  ['no flag', [], {}],
  ['an inspector flag', ['--disable-sigusr1', '--inspect=0'], {}],
  ['a preload', ['--disable-sigusr1', '--import=data:text/javascript,0'], {}],
  ['NODE_OPTIONS', ['--disable-sigusr1'], { NODE_OPTIONS: '--max-old-space-size=200' }],
  ['a coverage writer', ['--disable-sigusr1'], { NODE_V8_COVERAGE: '' }],
] as const)(
  'a recorder cannot attach: %s is refused before the settings are read',
  async (_name, flags, env) => {
    const coverage = 'NODE_V8_COVERAGE' in env ? { NODE_V8_COVERAGE: join(folder, 'cov') } : env;
    const before = { connections, requests };
    const run = start(settings('on'), flags, coverage);
    expect(await run.exited).toBe(2);
    expect(run.out()).toContain('trace export: a recorder could attach');
    expect(run.out()).not.toContain(CANARY);
    expect({ connections, requests }).toStrictEqual(before);
  },
  120_000,
);

it('a running exporter opens no inspector on SIGUSR1 and stops cleanly on SIGTERM', async () => {
  const run = start(settings('on'));
  await until(() => run.out().includes('trace export: on for 1 business'));
  run.child.kill('SIGUSR1');
  await sleep(1_000);
  expect(run.child.exitCode).toBeNull();
  expect(run.out()).not.toMatch(/debugger|inspector/iu);
  const inspector = await new Promise<boolean>((done) => {
    const socket = connect(9229, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
  expect(inspector).toBe(false);
  run.child.kill('SIGTERM');
  expect(await run.exited).toBe(0);
  expect(run.out()).toContain('trace export: stopped');
  expect(run.out()).not.toContain(CANARY);
}, 120_000);

it('a settings file others may read is refused, and nothing is opened', async () => {
  const before = { connections, requests };
  const run = start(settings('on', {}, 0o644));
  expect(await run.exited).toBe(2);
  expect(run.out()).toBe('trace export: the settings file is readable by others\n');
  expect({ connections, requests }).toStrictEqual(before);
}, 120_000);

it('no settings file named is refused', async () => {
  const run = start();
  expect(await run.exited).toBe(2);
  expect(run.out()).toBe('trace export: TRACE_EXPORT_SETTINGS_FILE names no file\n');
}, 120_000);

it.each([
  [
    'a login off this machine without TLS',
    { DATABASE_TRACE_URL: `postgres://trace:${CANARY}@db.example.test:5432/ops` },
    'trace export: DATABASE_TRACE_URL does not require TLS (add ?sslmode=require or stricter)\n',
  ],
  [
    'a login that is no database address',
    { DATABASE_TRACE_URL: `https://trace:${CANARY}@db.example.test/` },
    'trace export: DATABASE_TRACE_URL is not a database login (postgres://...)\n',
  ],
  [
    'a business that is no id',
    { TRACE_EXPORT_BUSINESSES: `${BUSINESS},${CANARY}` },
    'trace export: TRACE_EXPORT_BUSINESSES is not a comma-separated list of lower-case business ids\n',
  ],
] as const)(
  '%s is refused, naming the setting and never its value',
  async (_name, extra, said) => {
    const before = { connections, requests };
    const run = start(settings('on', extra));
    expect(await run.exited).toBe(2);
    expect(run.out()).toBe(said);
    expect({ connections, requests }).toStrictEqual(before);
  },
  120_000,
);

it('the plist runs the entry with the one flag and no setting but the settings file', () => {
  const plist = readFileSync(join(ROOT, 'deploy/m5/ops-astro-trace-export.plist'), 'utf8');
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist)?.[1];
  expect([...(program ?? '').matchAll(/<string>([^<]*)<\/string>/gu)].map((m) => m[1])).toEqual([
    '@NODE@',
    '--disable-sigusr1',
    ENTRY,
  ]);
  const environment = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(
    plist,
  )?.[1];
  expect([...(environment ?? '').matchAll(/<key>([^<]*)<\/key>/gu)].map((m) => m[1])).toEqual([
    'PATH',
    'TRACE_EXPORT_SETTINGS_FILE',
  ]);
  expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
  expect(plist).not.toMatch(/TRACE_EXPORT\b(?!_)|DATABASE_TRACE_URL|postgres:/u);
});
