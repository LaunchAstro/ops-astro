// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the local runner (`apps/local-agent`), speaking only the
// contract in LA-1's plan: `POST /v1/local-claude/complete` with a bearer and
// `{ model, fields }`, answered `{ text, model, usage, code, costUsd }`. It
// never runs `claude`; the runner's own tests do that with a fake binary.
// Custody is started on it with a planted canary as the runner's key.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import { plantedKey } from '../custody/custody-world.ts';

export type StubMode = 'answer' | 'cap';

export interface StubRunner {
  readonly custody: Custody;
  /** The runner's planted key: custody presents it; nothing else may show it. */
  readonly canary: string;
  readonly seen: {
    readonly path: string;
    readonly authorization: string | undefined;
    readonly body: string;
  }[];
  mode(next: StubMode): void;
  close(): Promise<void>;
}

export const LOCAL_REPLY = 'Local reply.';
export const LOCAL_MODEL = 'claude-haiku-4-5-20251001';
export const SEAT_ACCOUNT = 'seat-hey';

const ANSWERS: Record<StubMode, unknown> = {
  answer: {
    text: LOCAL_REPLY,
    model: LOCAL_MODEL,
    usage: { input: 10, output: 4 },
    code: null,
    costUsd: 0.0003,
  },
  cap: {
    text: '',
    model: null,
    usage: { input: 0, output: 0 },
    code: 'LOCAL_CAP_REACHED',
    costUsd: 0,
  },
};

/** The runner's key, filed for custody as the local session's route carries it. */
function writeRunnerCredential(folder: string, canary: string): string {
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'local_runner',
        kind: 'api_key',
        account: SEAT_ACCOUNT,
        destination: 'local_claude',
        header: 'authorization',
        value: canary,
      },
    ]),
    { mode: 0o600 },
  );
  return credentialsFile;
}

/** The loopback server: records each request, answers in the current mode. */
async function listen(
  seen: StubRunner['seen'],
  mode: () => StubMode,
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      seen.push({
        path: request.url ?? '',
        authorization: request.headers['authorization'],
        body: Buffer.concat(parts).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(ANSWERS[mode()]));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export async function startStubRunner(): Promise<StubRunner> {
  let current: StubMode = 'answer';
  const seen: StubRunner['seen'] = [];
  const server = await listen(seen, () => current);
  const folder = mkdtempSync(join(tmpdir(), 'la1-runner-'));
  const canary = plantedKey();
  const custody = await startCustody({
    credentialsFile: writeRunnerCredential(folder, canary),
    destinations: [{ key: 'local_claude', origin: server.origin }],
  }).catch(async (error: unknown) => {
    await server.close();
    rmSync(folder, { recursive: true, force: true });
    throw error;
  });
  return {
    custody,
    canary,
    seen,
    mode: (next) => {
      current = next;
    },
    close: async () => {
      await custody.stop();
      await server.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
