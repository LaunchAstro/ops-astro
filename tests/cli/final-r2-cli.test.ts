// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-CLI: the command line as its own process, with
// no database and no API. An HTTP stand-in plays the API and records every body.
//
//  - **R2-SURFACE-43.** An agent pickup whose credential cannot be saved never
//    exits 1, which reads as refused (`docs/local/CLI.md`, exit codes). A
//    location it cannot write is a usage error before anything is sent (exit
//    2); a save that fails after the claim committed is a fault (exit 4) that
//    names the operationId, so a replay with that id gets the credential back.
//    The credential is never printed.
//  - **R2-SURFACE-65.** A body with no canonical form, such as a number too
//    large for a double, is a usage error with no request sent (exit 2). It is
//    never re-serialised as null (`docs/local/API.md`, `COMMAND_BODY_INVALID`).

import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `apps/cli/main.ts` as its own process, once. Kept here rather than taken
 * from `cli-process-harness.ts`, which reaches the database harness: this file
 * opens no database.
 */
async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Run> {
  const child = spawn(process.execPath, ['apps/cli/main.ts', ...args], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

type Handler = (request: IncomingMessage, raw: string, response: ServerResponse) => void;

interface StandIn {
  readonly origin: string;
  readonly seen: { readonly path: string; readonly raw: string }[];
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
      state.seen.push({ path: request.url ?? '', raw });
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

const CREDENTIAL = 'a-delegation-credential-from-the-stand-in';

function answerPickup(response: ServerResponse): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ detail: { leaseId: 'L', fence: 1, credential: CREDENTIAL } }));
}

// eslint-disable-next-line max-lines-per-function -- one stand-in, the calls that share it
describe('R2-SURFACE-43: a pickup whose credential cannot be saved is never read as refused', () => {
  let api: StandIn;
  let scratch: string;
  const env = (delegationFile: string) => ({
    OPS_ASTRO_API_URL: api.origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: 'a-bearer-for-the-stand-in',
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: delegationFile,
    OPS_ASTRO_AGENT: '1',
  });
  const pickup = ['task.pickup', '--json', JSON.stringify({ reservationId: 'R' })];

  beforeAll(async () => {
    api = await standIn();
    scratch = mkdtempSync(join(tmpdir(), 'final-r2-cli-'));
  });

  afterAll(async () => {
    await api.close();
    chmodSync(scratch, 0o700);
    rmSync(scratch, { recursive: true, force: true });
  });

  it('a location it cannot write is exit 2 with nothing sent', async () => {
    const locked = mkdtempSync(join(scratch, 'locked-'));
    chmodSync(locked, 0o500);
    api.seen.length = 0;
    api.handle = (_request, _raw, response) => answerPickup(response);
    try {
      const run = await runCli(pickup, env(join(locked, 'delegation')));
      expect(run.code, run.stderr).toBe(2);
      expect(api.seen).toHaveLength(0);
      expect(run.stderr).toMatch(/^cli: .*delegation/u);
      expect(run.stderr).not.toMatch(/\n\s+at /u);
    } finally {
      chmodSync(locked, 0o700);
    }
  }, 30_000);

  // eslint-disable-next-line max-lines-per-function -- lost save, then the replay that recovers it
  it('a save that fails after the claim committed is exit 4, names the id, and that id replays', async () => {
    const dir = mkdtempSync(join(scratch, 'revoked-'));
    const file = join(dir, 'delegation');
    api.seen.length = 0;
    // The location is writable when the command line checks it and is taken
    // away while the API commits the claim.
    api.handle = (_request, _raw, response) => {
      chmodSync(dir, 0o500);
      answerPickup(response);
    };
    const lost = await runCli(pickup, env(file));
    chmodSync(dir, 0o700);
    expect(lost.code, lost.stderr).toBe(4);
    expect(api.seen).toHaveLength(1);
    const sent = (JSON.parse(api.seen[0]?.raw ?? '{}') as { operationId?: unknown }).operationId;
    expect(typeof sent).toBe('string');
    expect(namedId(lost.stderr)).toBe(sent);
    expect(lost.stderr).toContain(`could not be saved to ${file}`);
    expect(lost.stderr).not.toMatch(/\n\s+at /u);
    expect(lost.stdout).not.toContain(CREDENTIAL);
    expect(lost.stderr).not.toContain(CREDENTIAL);

    api.handle = (_request, _raw, response) => answerPickup(response);
    const replay = await runCli(
      [
        'task.pickup',
        '--json',
        JSON.stringify({ reservationId: 'R', operationId: namedId(lost.stderr) }),
      ],
      env(file),
    );
    expect(replay.code, replay.stderr).toBe(0);
    const resent = (JSON.parse(api.seen[1]?.raw ?? '{}') as { operationId?: unknown }).operationId;
    expect(resent).toBe(sent);
    expect(readFileSync(file, 'utf8').trim()).toBe(CREDENTIAL);
    expect(replay.stdout).not.toContain(CREDENTIAL);
  }, 30_000);
});

describe('R2-SURFACE-65: a body with no canonical form is exit 2 with nothing sent', () => {
  let api: StandIn;
  const env = () => ({
    OPS_ASTRO_API_URL: api.origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: 'a-bearer-for-the-stand-in',
  });

  beforeAll(async () => {
    api = await standIn();
    api.handle = (_request, _raw, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ detail: { value: null } }));
    };
  });

  afterAll(async () => {
    await api.close();
  });

  it.each([
    ['settings.set_four_eyes_threshold', '{"value":1e400}'],
    ['settings.set_four_eyes_threshold', '{"value":-1e400}'],
    ['task.create', '{"fields":{"title":"x","estimate":-1e400}}'],
    ['task.create', '{"fields":{"title":"x","subtasks":[{"estimate":1e999}]}}'],
  ])(
    '%s %s',
    async (verb, json) => {
      api.seen.length = 0;
      const run = await runCli([verb, '--json', json], env());
      expect(run.code, run.stderr).toBe(2);
      expect(api.seen).toHaveLength(0);
      expect(run.stderr).toMatch(/^cli: the body has no canonical form/u);
      expect(run.stdout).toBe('');
    },
    30_000,
  );

  it('a finite body still goes out as typed', async () => {
    api.seen.length = 0;
    const run = await runCli(
      ['settings.set_four_eyes_threshold', '--json', '{"value":1e300}'],
      env(),
    );
    expect(run.code, run.stderr).toBe(0);
    expect(api.seen).toHaveLength(1);
    expect((JSON.parse(api.seen[0]?.raw ?? '{}') as { value?: unknown }).value).toBe(1e300);
  }, 30_000);
});
