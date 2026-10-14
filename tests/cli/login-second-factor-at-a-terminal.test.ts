// SPDX-License-Identifier: AGPL-3.0-only
//
// `login --second-factor` typed at a terminal: the password at its hidden
// prompt, then the authenticator code at its own. The first prompt hands the
// terminal back paused, so the second must take it up again; otherwise the
// process runs out of work and exits before a request is sent. The command
// runs as its own process under a pseudo-terminal (`terminal.ts`); the sign-in
// service and the API are stand-ins on loopback.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { standInGoTrue, type StandIn } from '../support/stand-in-gotrue.ts';
import { underTerminal } from './terminal.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const TERMINAL = underTerminal(['true']) !== undefined;
const PASSWORD = 'terminal-password-canary-7c2a';
const STEPPED = 'terminal-stepped-up-token-canary-41d9';
const CODE = '135790';

let gotrue: StandIn;
let api: Server;
let apiUrl = '';
let folder: string;
/** What the stand-in API saw: route and body. */
const seen: { route: string; body: string }[] = [];

beforeAll(async () => {
  gotrue = await standInGoTrue({
    issue: async () => await Promise.resolve('terminal-password-only-token-canary-0b3e'),
    expiresIn: 3_600,
  });
  api = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const route = `${request.method ?? ''} ${request.url ?? ''}`;
      seen.push({ route, body });
      const verify = route === 'POST /api/b/alpha/account/factor/verify';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(verify ? { accessToken: STEPPED, otherSessions: 0 } : {}));
    });
  });
  await new Promise<void>((resolve) => {
    api.listen(0, '127.0.0.1', resolve);
  });
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  folder = mkdtempSync(join(tmpdir(), 'cli-login-second-factor-terminal-'));
});

afterAll(async () => {
  await gotrue?.close();
  api?.closeAllConnections();
  await new Promise<void>((resolve) => {
    api?.close(() => resolve());
  });
  rmSync(folder, { recursive: true, force: true });
});

// eslint-disable-next-line max-lines-per-function -- one terminal session, read top to bottom
describe.skipIf(!TERMINAL)('login --second-factor at a terminal', () => {
  // eslint-disable-next-line max-lines-per-function -- one terminal session, read top to bottom
  it('takes the code at its own hidden prompt after the password, and saves the stepped-up token', async () => {
    const tokenFile = join(folder, 'token');
    const argv = underTerminal([
      process.execPath,
      'apps/cli/main.ts',
      'login',
      '--email',
      'operator@example.test',
      '--second-factor',
    ]) as readonly string[];
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: ROOT,
      env: {
        PATH: process.env['PATH'] ?? '',
        OPS_ASTRO_GOTRUE_URL: gotrue.url,
        OPS_ASTRO_API_URL: apiUrl,
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_TOKEN_FILE: tokenFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let screen = '';
    let answered = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      screen += chunk.toString('utf8');
      // Each secret is typed only once its own prompt is up, so echo is already off.
      if (answered === 0 && screen.includes('password: ')) {
        answered = 1;
        child.stdin.write(`${PASSWORD}\r`);
      }
      if (answered === 1 && screen.includes('authenticator code: ')) {
        answered = 2;
        child.stdin.end(`${CODE}\r`);
      }
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('close', resolve);
    }).finally(() => child.kill());

    expect(answered, screen).toBe(2);
    expect(code, screen).toBe(0);
    expect(gotrue.signIns()).toBe(1);
    const verify = seen.find(({ route }) => route === 'POST /api/b/alpha/account/factor/verify');
    expect(verify?.body).toContain(CODE);
    expect(readFileSync(tokenFile, 'utf8')).toBe(`${STEPPED}\n`);
    for (const secret of [PASSWORD, CODE, STEPPED]) expect(screen.includes(secret)).toBe(false);
  }, 30_000);
});
