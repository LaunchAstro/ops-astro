// SPDX-License-Identifier: AGPL-3.0-only
//
// `apps/api/server.ts` started as its own OS process, the production entry,
// on a free port over a fresh database, with the settings a case adds. It is
// ready once `/api/health` answers; its stdout and stderr are kept, so a case
// can read what the server logged, and look for what it must never log.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseUrlFromEnvironment, type FreshDatabase } from './fresh-database.ts';
import { sharedKeySetUrl } from './sign-in.ts';

const ROOT = join(import.meta.dirname, '..', '..');

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** Polls health until it answers or the process has exited. */
async function answers(port: number, hasExited: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 200 && !hasExited(); attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling one server
    const ok = await fetch(`http://127.0.0.1:${String(port)}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling one server
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  return false;
}

export interface Served {
  readonly ready: boolean;
  /** The server's own origin, on loopback. */
  readonly origin: string;
  output(): string;
  /** SIGTERM, then the exit code once it has exited. */
  stop(): Promise<number | null>;
}

/** The production entry over `database`, recovering `businessKeys`, with `settings` added. */
export async function serveApi(
  database: Pick<FreshDatabase, 'name' | 'appUrl'>,
  businessKeys: string,
  settings: Readonly<Record<string, string>>,
): Promise<Served> {
  const port = await freePort();
  const admin = new URL(databaseUrlFromEnvironment() as string);
  admin.pathname = `/${database.name}`;
  const keys = mkdtempSync(join(tmpdir(), 'served-api-keys-'));
  const child = spawn(process.execPath, ['apps/api/server.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      API_PORT: String(port),
      DATABASE_URL: database.appUrl,
      DATABASE_ADMIN_URL: admin.toString(),
      SUPABASE_KEY_SET_URL: await sharedKeySetUrl(),
      GOTRUE_URL: 'http://127.0.0.1:54391',
      GATE_SIGNING_KEY_ID: '',
      GATE_SIGNING_SECRET: '',
      DELEGATION_CREDENTIAL_KEY_FILE: join(keys, 'delegation-keys.json'),
      RECOVERY_BUSINESS_KEYS: businessKeys,
      ...settings,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`served api: started apps/api/server.ts pid ${String(child.pid)}`);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  let exited = false;
  const done = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      exited = true;
      resolve(code);
    });
  });
  return {
    ready: await answers(port, () => exited),
    origin: `http://127.0.0.1:${String(port)}`,
    output: () => output,
    stop: async () => {
      if (!exited) child.kill('SIGTERM');
      const code = await done;
      rmSync(keys, { recursive: true, force: true });
      return code;
    },
  };
}
