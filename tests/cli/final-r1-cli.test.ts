// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-CLI: the command line as its own process, with
// no database and no API. HTTP stand-ins play the API and the identity provider.
//
//  - **R1-SURFACE-38.** A write whose answer never arrives (exit 3), or comes
//    back as a fault (exit 4), names the operationId the command line chose, so
//    the caller can send it again and get the replay (`docs/local/CLI.md`,
//    retries; `docs/local/RUNTIME.md`, a lost pickup answered again).
//  - **R1-SURFACE-39.** `login` at a terminal prompts for the password with
//    echo off, as `docs/local/CLI.md` reads ("When unset, the first line of
//    stdin"). The terminal is a pseudo-terminal from `script(1)`.
//  - **R1-SURFACE-40.** `pnpm cli` prints one JSON value on stdout and nothing
//    of its own, so it pipes to `jq`; and the check bites when something ahead
//    of the entry writes a line.

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordPid, runCli } from './cli-process-harness.ts';

const ROOT = join(import.meta.dirname, '..', '..');

type Handler = (request: IncomingMessage, raw: string, response: ServerResponse) => void;

interface StandIn {
  readonly origin: string;
  readonly seen: { readonly path: string; readonly body: Record<string, unknown> }[];
  handle: Handler;
  close(): Promise<void>;
}

async function standIn(): Promise<StandIn> {
  const state: StandIn = {
    origin: '',
    seen: [],
    handle: (_request, _raw, response) => response.end('{}'),
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      state.seen.push({
        path: request.url ?? '',
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      state.handle(request, raw, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return Object.assign(state, { origin: `http://127.0.0.1:${String(port)}` });
}

/** The operationId the command line says it chose, from its stderr. */
function namedId(stderr: string): string | undefined {
  return /operationId (\S+); send it again with this operationId to replay/u.exec(stderr)?.[1];
}

// eslint-disable-next-line max-lines-per-function -- one stand-in, the calls that share it
describe('R1-SURFACE-38: a write with no answer or a fault names the operationId it was sent with', () => {
  let api: StandIn;
  let scratch: string;
  const env = () => ({
    OPS_ASTRO_API_URL: api.origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: 'a-bearer-for-the-stand-in',
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
  });

  beforeAll(async () => {
    api = await standIn();
    scratch = mkdtempSync(join(tmpdir(), 'final-r1-cli-'));
  });

  afterAll(async () => {
    await api.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('a pickup whose connection drops exits 3, names its id, and that id replays', async () => {
    api.seen.length = 0;
    api.handle = (request) => request.socket.destroy();
    const lost = await runCli(
      ['task.pickup', '--agent', '--json', JSON.stringify({ reservationId: 'R' })],
      env(),
    );
    expect(lost.code, lost.stderr).toBe(3);
    const sent = api.seen[0]?.body['operationId'];
    expect(typeof sent).toBe('string');
    expect(namedId(lost.stderr)).toBe(sent);
    expect(lost.stdout).toBe('');

    api.handle = (_request, _raw, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ detail: { leaseId: 'L', fence: 1, credential: 'held' } }));
    };
    const replay = await runCli(
      [
        'task.pickup',
        '--agent',
        '--json',
        JSON.stringify({ reservationId: 'R', operationId: namedId(lost.stderr) }),
      ],
      env(),
    );
    expect(replay.code, replay.stderr).toBe(0);
    expect(api.seen[1]?.path).toBe('/api/a/b/alpha/task/pickup');
    expect(api.seen[1]?.body['operationId']).toBe(sent);
    expect(namedId(replay.stderr)).toBeUndefined();
  }, 30_000);

  it('a person write answered with a fault exits 4 and names its id', async () => {
    api.seen.length = 0;
    api.handle = (_request, _raw, response) => {
      response.statusCode = 503;
      response.end('Service Unavailable');
    };
    const run = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title: 't' } })],
      env(),
    );
    expect(run.code, run.stderr).toBe(4);
    expect(namedId(run.stderr)).toBe(api.seen[0]?.body['operationId']);
  }, 30_000);

  it('an id the caller brought, a refusal and a person read are not named', async () => {
    api.handle = (request) => request.socket.destroy();
    const own = await runCli(
      ['task.create', '--json', JSON.stringify({ operationId: 'caller-own-1', fields: {} })],
      env(),
    );
    expect(own.code).toBe(3);
    expect(namedId(own.stderr)).toBeUndefined();

    const read = await runCli(['person.list'], env());
    expect(read.code).toBe(3);
    expect(namedId(read.stderr)).toBeUndefined();

    api.handle = (_request, _raw, response) => {
      response.statusCode = 403;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [] }));
    };
    const refused = await runCli(['task.create', '--json', '{"fields":{}}'], env());
    expect(refused.code).toBe(1);
    expect(namedId(refused.stderr)).toBeUndefined();
  }, 30_000);
});

/**
 * `script(1)` gives the command a pseudo-terminal; its flags differ by platform.
 * `cat` puts a real pipe in front of it: macOS `script` refuses the socket
 * pair Node hands a child as stdin.
 */
function underTerminal(command: readonly string[]): readonly string[] | undefined {
  if (!existsSync('/usr/bin/script')) return undefined;
  if (process.platform === 'darwin') {
    return ['/bin/sh', '-c', 'cat | exec /usr/bin/script -q /dev/null "$@"', 'sh', ...command];
  }
  if (process.platform === 'linux') {
    const quoted = command.map((part) => `'${part.replaceAll("'", String.raw`'\''`)}'`).join(' ');
    return ['/bin/sh', '-c', 'cat | exec /usr/bin/script -qec "$1" /dev/null', 'sh', quoted];
  }
  return undefined;
}

const TERMINAL = underTerminal(['node']) !== undefined;

// eslint-disable-next-line max-lines-per-function -- one terminal session, read top to bottom
describe.skipIf(!TERMINAL)('R1-SURFACE-39: login at a terminal prompts with echo off', () => {
  // eslint-disable-next-line max-lines-per-function -- one terminal session, read top to bottom
  it('reads the password typed at the prompt, never echoes it, and saves the bearer', async () => {
    const gotrue = await standIn();
    gotrue.handle = (_request, _raw, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ access_token: 'a-bearer-from-the-stand-in' }));
    };
    const scratch = mkdtempSync(join(tmpdir(), 'final-r1-cli-tty-'));
    const tokenFile = join(scratch, 'token');
    try {
      const argv = underTerminal([
        process.execPath,
        'apps/cli/main.ts',
        'login',
        '--email',
        'ada@alpha.local',
      ]) as readonly string[];
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: ROOT,
        env: {
          PATH: process.env['PATH'] ?? '',
          OPS_ASTRO_GOTRUE_URL: `${gotrue.origin}/auth/v1`,
          OPS_ASTRO_TOKEN_FILE: tokenFile,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      recordPid('sh script cli login', child.pid);
      let screen = '';
      let typed = false;
      child.stdout.on('data', (chunk: Buffer) => {
        screen += chunk.toString('utf8');
        // Type only once the prompt is up, so echo is already off.
        if (!typed && screen.includes('password: ')) {
          typed = true;
          child.stdin.end('typed-at-the-terminal\r');
        }
      });
      const code = await new Promise<number | null>((resolve) => {
        child.once('close', resolve);
      });
      expect(typed, screen).toBe(true);
      expect(code, screen).toBe(0);
      expect(gotrue.seen[0]?.body).toStrictEqual({
        email: 'ada@alpha.local',
        password: 'typed-at-the-terminal',
      });
      expect(screen).not.toContain('typed-at-the-terminal');
      expect(readFileSync(tokenFile, 'utf8').trim()).toBe('a-bearer-from-the-stand-in');
    } finally {
      await gotrue.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('R1-SURFACE-40: `pnpm cli` stdout is one JSON value and nothing of its own', () => {
  it('an unknown verb through the package script prints exactly one JSON value', async () => {
    const run = await runCli(['task.teleport'], {}, '', 'pnpm');
    expect(run.code, run.stderr).toBe(2);
    expect(run.json, run.stdout).toBeDefined();
    expect(run.json).toMatchObject({ code: 'COMMAND_UNKNOWN', names: ['task.teleport'] });
  }, 30_000);

  it('the same check fails when anything ahead of the entry writes a line on stdout', async () => {
    // A stand-in `pnpm` first on PATH that prints a header, then runs the real one.
    const bin = mkdtempSync(join(tmpdir(), 'final-r1-cli-pnpm-'));
    try {
      const real = (process.env['PATH'] ?? '')
        .split(':')
        .map((dir) => join(dir, 'pnpm'))
        .find((candidate) => existsSync(candidate)) as string;
      const stub = join(bin, 'pnpm');
      writeFileSync(stub, `#!/bin/sh\necho '> ops-astro@0.0.0 cli'\nexec '${real}' "$@"\n`);
      chmodSync(stub, 0o755);
      const run = await runCli(
        ['task.teleport'],
        { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
        '',
        'pnpm',
      );
      expect(run.stdout).toContain('COMMAND_UNKNOWN');
      expect(run.json).toBeUndefined();
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);
});
