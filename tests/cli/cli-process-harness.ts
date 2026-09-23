// SPDX-License-Identifier: AGPL-3.0-only
//
// Separate OS processes for the command-line proof: the real `apps/api/server.ts`
// on a free loopback port, and `apps/cli/main.ts` run once per call.
//
// Every PID started here is printed, and appended to `CLI_PROCESS_PIDFILE`
// when that is set, and only those PIDs are ever signalled. The ports other
// local stacks use are refused even if the kernel hands one out.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPTANCE_SECRET, serverUrl, type World } from '../acceptance/world.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/** Ports that belong to other stacks on this machine (lane brief, Runtime). */
const DENIED_PORTS: ReadonlySet<number> = new Set([
  5190, 5197, 5198, 5199, 8790, 8797, 8798, 8799, 54390, 54391, 54392, 54393, 54394, 54395, 54396,
  54397, 54398, 54399, 54400, 54401, 54402, 54403,
]);

export function recordPid(what: string, pid: number | undefined): void {
  if (pid === undefined) return;
  console.log(`cli-process: started ${what} pid ${String(pid)}`);
  const file = process.env['CLI_PROCESS_PIDFILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${String(pid)} ${what}\n`);
}

/** A loopback port nothing listens on at the moment of asking, never a denied one. */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- one probe at a time
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const found = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(found));
      });
    });
    if (port !== 0 && !DENIED_PORTS.has(port)) return port;
  }
  throw new Error('cli-process: no free loopback port');
}

async function health(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/api/health`)).status === 200;
  } catch {
    return false;
  }
}

export interface ServedApi {
  readonly origin: string;
  readonly pid: number;
  stop(): Promise<void>;
}

/** The production server entry, on its own port, against the world's database. */
export async function serveApi(world: World): Promise<ServedApi> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  const admin = new URL(serverUrl as string);
  admin.pathname = `/${world.db.name}`;
  const keys = mkdtempSync(join(tmpdir(), 'cli-process-keys-'));
  const child = spawn(process.execPath, ['apps/api/server.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env['PATH'] ?? '',
      API_PORT: String(port),
      DATABASE_URL: world.db.appUrl,
      DATABASE_ADMIN_URL: admin.toString(),
      SUPABASE_JWT_SECRET: ACCEPTANCE_SECRET,
      GATE_SIGNING_KEY_ID: process.env['GATE_SIGNING_KEY_ID'] ?? '',
      GATE_SIGNING_SECRET: process.env['GATE_SIGNING_SECRET'] ?? '',
      DELEGATION_CREDENTIAL_KEY_FILE: join(keys, 'delegation-keys.json'),
    },
    stdio: 'ignore',
  });
  recordPid('apps/api/server.ts', child.pid);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const hasExited = (): boolean => exited;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling one server
    if (hasExited() || (await health(origin))) break;
    // eslint-disable-next-line no-await-in-loop -- polling one server
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  if (exited || !(await health(origin))) {
    child.kill('SIGKILL');
    throw new Error(`cli-process: the API did not answer on ${origin}`);
  }
  return {
    origin,
    pid: child.pid as number,
    stop: async () => {
      const gone = new Promise<void>((resolve) => {
        if (exited) resolve();
        else child.once('exit', () => resolve());
      });
      child.kill('SIGTERM');
      await gone;
      console.log(`cli-process: stopped apps/api/server.ts pid ${String(child.pid)}`);
      rmSync(keys, { recursive: true, force: true });
    },
  };
}

export interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The stdout parsed as one JSON value, or undefined when it is not one. */
  readonly json: Record<string, unknown> | undefined;
}

/**
 * One command-line process: `node apps/cli/main.ts ...args` (or the package
 * script, `pnpm cli ...args`, when `via` says so), with the given
 * environment and nothing inherited but `PATH`, so a stray `OPS_ASTRO_*` in the
 * shell cannot change what is proved.
 */
export async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  stdin = '',
  via: 'node' | 'pnpm' = 'node',
): Promise<Run> {
  const [command, prefix] =
    via === 'pnpm' ? ['pnpm', ['cli']] : [process.execPath, ['apps/cli/main.ts']];
  const child = spawn(command, [...prefix, ...args], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  recordPid(`cli ${args[0] ?? ''}`, child.pid);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolve) => {
    child.once('close', resolve);
  });
  let json: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    json = undefined;
  }
  return { code, stdout, stderr, json };
}
