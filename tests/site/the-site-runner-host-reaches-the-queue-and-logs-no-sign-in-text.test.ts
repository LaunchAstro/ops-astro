// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's own process (`apps/site-runner/main.ts`), launched as
// launchd launches it, against a sign-in server and an agent API served over
// loopback. The API answers as the agent envelope does before a pickup: only
// the operations in `BEFORE_PICKUP` are reached, and every other one is
// refused `DELEGATION_EXCLUDES_OPERATION`. A signed-in host reaches the queue
// and asks nothing a pickup has not delegated; a sign-in refusal, or a queue
// refused or faulted with an answer that echoes the password, leaves no trace
// of it in what the host prints.

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BEFORE_PICKUP } from '../../packages/core-commands/src/commands/agent-envelope.ts';

const PASSWORD = 'fixture-canary-password-7e21c9';

interface Hosted {
  readonly code: number | null;
  readonly printed: string;
  /** Every path the API and the sign-in server were asked, in order. */
  readonly asked: readonly string[];
}

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  closing.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Reply {
  readonly status: number;
  readonly body: object;
}

const EMPTY: Reply = { status: 200, body: { ok: true, detail: { queue: [] } } };

const json = (response: ServerResponse, status: number, body: object): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

/**
 * The agent API before a pickup: `task.queue` answers `queue`, the rest of
 * `BEFORE_PICKUP` answers, anything else undelegated is refused.
 */
function agentApi(asked: string[], queued: () => void, queue: Reply): Server {
  return createServer((request, response) => {
    const path = request.url ?? '';
    asked.push(path);
    request.resume();
    const command = path.split('/').slice(5).join('.');
    const delegated = typeof request.headers['x-agent-delegation'] === 'string';
    if (!delegated && !BEFORE_PICKUP.has(command as never)) {
      const code = 'DELEGATION_EXCLUDES_OPERATION';
      json(response, 403, { refused: true, code, names: [command], fixes: [] });
      return;
    }
    const reply = command === 'task.queue' ? queue : EMPTY;
    json(response, reply.status, reply.body);
    if (command === 'task.queue') queued();
  });
}

/** A settings file and a custody credentials file, each only its owner can read. */
function settingsIn(folder: string, api: string, gotrue: string): string {
  const credentialsFile = join(folder, 'credentials.json');
  const entries = (['source_control', 'hosting'] as const).map((ref) => ({
    ref,
    kind: 'api_key',
    account: `${ref}-fixture`,
    destination: ref,
    header: 'authorization',
    value: `fixture-${ref}`,
  }));
  writeFileSync(credentialsFile, JSON.stringify(entries), { mode: 0o600 });
  const settingsFile = join(folder, 'settings.json');
  const settings = {
    OPS_ASTRO_API_URL: api,
    OPS_ASTRO_BUSINESS: 'agency',
    OPS_ASTRO_BUSINESS_ID: '6f1c2a54-9d0b-4c1e-8a7f-3b2d1e0f9a8c',
    OPS_ASTRO_EMAIL: 'site-runner@example.com',
    OPS_ASTRO_PASSWORD: PASSWORD,
    OPS_ASTRO_GOTRUE_URL: gotrue,
    // Unreachable: the locate reads it each pass and fails on its own, the claims still run. The
    // site's holder is the business, so start-up reads nothing.
    SITE_RUNNER_DATABASE_URL: 'postgres://site_runner:unused@127.0.0.1:9/postgres?sslmode=require',
    SITE_RUNNER_CREDENTIALS_FILE: credentialsFile,
    SITE_RUNNER_SITE: JSON.stringify({
      business: '6f1c2a54-9d0b-4c1e-8a7f-3b2d1e0f9a8c',
      holder: '6f1c2a54-9d0b-4c1e-8a7f-3b2d1e0f9a8c',
      repository: 'LaunchAstro/agency-astro-astro',
      defaultBranch: 'main',
      project: 'prj_agency',
      pages: [{ pageUrl: 'https://agencyastro.com/about', path: 'src/pages/about.astro' }],
    }),
  };
  writeFileSync(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  chmodSync(settingsFile, 0o600);
  return settingsFile;
}

/**
 * The host run against `token` as the sign-in answer and `queue` as the
 * queue's, until the API is asked for the queue (then SIGTERM, as `launchctl
 * bootout` sends) or it exits.
 */
async function host(token: Reply, queue: Reply = EMPTY): Promise<Hosted> {
  const asked: string[] = [];
  const stopping = new AbortController();
  const gotrue = createServer((request, response) => {
    asked.push(request.url ?? '');
    request.resume();
    json(response, token.status, token.body);
  });
  const folder = mkdtempSync(join(tmpdir(), 'site-runner-main-'));
  closing.push(() => rmSync(folder, { recursive: true, force: true }));
  const api = await listen(agentApi(asked, () => stopping.abort(), queue));
  const settingsFile = settingsIn(folder, api, await listen(gotrue));
  const child = spawn(process.execPath, ['apps/site-runner/main.ts'], {
    env: { PATH: process.env['PATH'] ?? '', SITE_RUNNER_SETTINGS: settingsFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stopping.signal.addEventListener('abort', () => child.kill('SIGTERM'));
  let printed = '';
  child.stdout.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
  });
  return { code, printed, asked };
}

describe('the site runner host, launched as launchd launches it', () => {
  it('signs in, reaches the queue, asks nothing undelegated, and stops cleanly on SIGTERM', async () => {
    const hosted = await host({
      status: 200,
      body: { access_token: 'fixture-bearer', expires_in: 3600, token_type: 'bearer' },
    });
    expect(
      hosted.asked.some((path) => path.endsWith('/task/queue')),
      hosted.printed,
    ).toBe(true);
    expect(hosted.asked.filter((path) => path.includes('/session/'))).toEqual([]);
    // The locate's fault is named and nothing else is printed.
    expect(hosted.code).toBe(0);
    expect(hosted.printed).toMatch(/^(?:site-runner: the locate failed: [A-Za-z]+\n)+$/u);
  }, 120_000);

  it('prints a fixed line on a sign-in refusal that echoes the password, never its text', async () => {
    const hosted = await host({
      status: 400,
      body: { error: 'invalid_grant', error_description: `rejected ${PASSWORD}` },
    });
    expect({ code: hosted.code, printed: hosted.printed }).toEqual({
      code: 1,
      printed: 'site-runner: sign-in refused\n',
    });
    expect(hosted.asked.some((path) => path.startsWith('/api/'))).toBe(false);
  }, 120_000);

  it('prints the code alone when the queue is refused or faulted with the password echoed', async () => {
    const signedIn: Reply = {
      status: 200,
      body: { access_token: 'fixture-bearer', expires_in: 3600, token_type: 'bearer' },
    };
    const echoed = `the session for site-runner@example.com (${PASSWORD}) has expired`;
    const refused = await host(signedIn, {
      status: 401,
      body: { refused: true, code: 'AUTH_SESSION_EXPIRED', message: echoed, fixes: [echoed] },
    });
    const faulted = await host(signedIn, { status: 500, body: { error: echoed } });
    expect([refused, faulted].map(({ code, printed }) => ({ code, printed }))).toEqual([
      { code: 0, printed: 'site-runner: the queue was refused: AUTH_SESSION_EXPIRED\n' },
      { code: 0, printed: 'site-runner: a pass failed: QueueFault\n' },
    ]);
    for (const { asked } of [refused, faulted])
      expect(asked.filter((path) => path.startsWith('/api/'))).toEqual([
        expect.stringMatching(/\/task\/queue$/u),
      ]);
  }, 120_000);
});
