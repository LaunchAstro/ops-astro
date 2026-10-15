// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { AutomationWorld } from './world.ts';

export interface StartedProcess {
  readonly output: string;
  readonly gone: boolean;
  readonly code: number | null;
  stop(): Promise<void>;
}

function launch(w: AutomationWorld, firing: string | undefined, folder: string): ChildProcess {
  const server = databaseUrlFromEnvironment();
  if (server === undefined) throw new Error('process-firing: no test database server');
  const admin = new URL(server);
  admin.pathname = `/${w.db.name}`;
  return spawn(process.execPath, ['apps/api/server.ts'], {
    cwd: join(import.meta.dirname, '../..'),
    env: {
      PATH: process.env['PATH'] ?? '',
      API_PORT: '0',
      DATABASE_URL: w.db.appUrl,
      DATABASE_ADMIN_URL: admin.toString(),
      GOTRUE_URL: 'http://127.0.0.1:9',
      SUPABASE_KEY_SET_URL: 'http://127.0.0.1:9/.well-known/jwks.json',
      DELEGATION_CREDENTIAL_KEY_FILE: join(folder, 'keys.json'),
      RECOVERY_BUSINESS_KEYS: 'alpha',
      ...(firing === undefined ? {} : { AUTOMATION_FIRING: firing }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface ProcessState {
  output: string;
  gone: boolean;
  code: number | null;
}

function observe(child: ChildProcess): { state: ProcessState; done: Promise<void> } {
  const state: ProcessState = { output: '', gone: false, code: null };
  const collect = (chunk: Buffer): void => {
    state.output += chunk.toString('utf8');
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => {
      state.gone = true;
      state.code = exitCode;
      resolve();
    });
  });
  void done.catch(() => {});
  return { state, done };
}

async function terminate(child: ChildProcess, observed: ReturnType<typeof observe>): Promise<void> {
  if (!observed.state.gone) child.kill('SIGTERM');
  await Promise.race([observed.done, delay(10_000)]);
  if (!observed.state.gone) {
    child.kill('SIGKILL');
    await observed.done;
    throw new Error('process-firing: API did not stop within ten seconds');
  }
}

/** The actual API process, with only this fixture's settings. */
export async function startProcess(w: AutomationWorld, firing?: string): Promise<StartedProcess> {
  const folder = mkdtempSync(join(tmpdir(), 'process-firing-'));
  const child = launch(w, firing, folder);
  const observed = observe(child);
  const { state } = observed;
  const stop = async (): Promise<void> => {
    try {
      await terminate(child, observed);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };
  try {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (state.gone || state.output.includes('api: listening')) break;
      // oxlint-disable-next-line no-await-in-loop -- wait for this process's startup
      await delay(50);
    }
    if (state.gone || !state.output.includes('api: listening')) {
      throw new Error(`process-firing: API did not listen\n${state.output}`);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    get output() {
      return state.output;
    },
    get gone() {
      return state.gone;
    },
    get code() {
      return state.code;
    },
    stop,
  };
}
