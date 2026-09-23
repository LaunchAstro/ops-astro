// SPDX-License-Identifier: AGPL-3.0-only
//
// The API as a real process, for the half of W06 an in-process rebuild cannot
// close.
//
// `rebuildApi` builds a second `createApi` in the test's own process: nothing
// in memory carries across, but the process never ends. The contract ledger's
// evidence column for W06 asks for a **real process restart**, so this starts
// `apps/api/server.ts` — the composition root a person's browser reaches —
// with `node`, on a loopback port given by `L5_RESTART_API_PORT`, against the
// suite's own throwaway database. It is stopped with SIGTERM, observed to have
// exited and to have released its port, and started again as a new process.
//
// Split out of `restart-harness.ts` for the per-file cap, and like that file
// it asserts nothing about the product: it starts, stops and reads.

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { ACCEPTANCE_SECRET, serverUrl, type World } from './world.ts';

export const API_PORT_VARIABLE = 'L5_RESTART_API_PORT';

/** Ports this proof refuses to bind: the working slice's and other lanes'. */
const DENIED_PORTS: ReadonlySet<string> = new Set(['8790', '5190']);

export interface RunningApi {
  readonly pid: number;
  readonly port: string;
  stop(): Promise<void>;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

async function answers(port: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.status === 200;
  } catch {
    return false;
  }
}

/** The declared API port, or a thrown refusal carrying its reason. */
export function declaredApiPort(): string {
  const port = process.env[API_PORT_VARIABLE];
  if (port === undefined || !/^[0-9]{4,5}$/u.test(port)) {
    throw new Error(`api restart refused: set ${API_PORT_VARIABLE} to a spare loopback port`);
  }
  if (DENIED_PORTS.has(port)) {
    throw new Error(`api restart refused: ${port} is another stack's port`);
  }
  return port;
}

export async function startApi(world: World, port: string): Promise<RunningApi> {
  if (await answers(port)) throw new Error(`something already answers on 127.0.0.1:${port}`);
  const admin = new URL(serverUrl as string);
  admin.pathname = `/${world.db.name}`;
  const child: ChildProcess = spawn(process.execPath, ['apps/api/server.ts'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      API_PORT: port,
      DATABASE_URL: world.db.appUrl,
      DATABASE_ADMIN_URL: admin.toString(),
      SUPABASE_JWT_SECRET: ACCEPTANCE_SECRET,
      GATE_SIGNING_KEY_ID: process.env['GATE_SIGNING_KEY_ID'] ?? '',
      GATE_SIGNING_SECRET: process.env['GATE_SIGNING_SECRET'] ?? '',
    },
    stdio: 'ignore',
  });
  // Written down before anything can fail, so a runner that dies mid-case
  // still leaves `restart-proof.sh` the pid its exit trap must stop.
  const pidFile = process.env['L5_RESTART_PIDFILE'];
  if (pidFile !== undefined && child.pid !== undefined) appendFileSync(pidFile, `${child.pid}\n`);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (exited) break;
    // eslint-disable-next-line no-await-in-loop
    if (await answers(port)) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
  }
  if (exited || !(await answers(port))) {
    child.kill('SIGKILL');
    throw new Error(`the API process did not answer on 127.0.0.1:${port}`);
  }
  return {
    pid: child.pid as number,
    port,
    stop: async () => {
      const gone = new Promise<void>((resolve) => {
        if (exited) resolve();
        else child.once('exit', () => resolve());
      });
      child.kill('SIGTERM');
      await gone;
      // Exited is not the same as gone from the port. A process that left a
      // listener behind would let the "restarted" reads reach the old one.
      if (await answers(port)) throw new Error(`127.0.0.1:${port} still answers after exit`);
    },
  };
}

/** `task.read` over HTTP, as the browser reaches it. */
export async function readOverHttp(
  port: string,
  token: string,
  recordId: string,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/b/alpha/task/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ operationId: crypto.randomUUID(), recordId }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/**
 * The restarted process as the `api` the acceptance helpers drive.
 *
 * `call` builds `http://api.test/...` requests for an in-process app; this
 * sends each one over the loopback socket to the process on `port` instead, so
 * `asAda` and `asAgent` reach the real server and nothing in the test's own
 * memory answers them.
 */
export function overHttp(port: string): World['api'] {
  const fetchOverSocket = async (request: Request): Promise<Response> =>
    await fetch(request.url.replace('http://api.test', `http://127.0.0.1:${port}`), {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });
  return { fetch: fetchOverSocket } as unknown as World['api'];
}
