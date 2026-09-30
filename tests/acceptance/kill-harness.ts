// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d2: the kill harness for the two runtime proofs (F1, F2).
//
// Every kill is a real hard kill of the real node process, by its own pid,
// never a package-manager wrapper's. A worker parks itself at a named point
// (`tests/support/parking-worker.ts`); an API process is stopped here with
// SIGSTOP once its answer is back. Neither is killed on seeing a mark in the
// database (spike RN-02 ruled that out for every window). Four checks are
// recorded with every kill:
//   1. the stopped process has no child and its state is stopped (`T`);
//   2. the relevant backend, the API's (the worker has none), is idle at a
//      commit point or idle in a transaction, never mid-statement;
//   3. the process ended by SIGKILL;
//   4. the killed process's backends are gone from `pg_stat_activity`, polled
//      for, never assumed, before any sweep is waited on.
// The harness reads through its own admin connection (`connectAsAdmin`); the
// worker is never handed a database address (RN-04).

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { expect } from 'vitest';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

export interface Killable {
  readonly pid: number;
  /** What `pg_stat_activity` calls its backends: its `PGAPPNAME`. */
  readonly appName: string;
  /** Resolves with the signal it ended by. */
  exited(): Promise<NodeJS.Signals | null>;
  /** Sends the hard stop. */
  stop(): Promise<void>;
}

export interface KillRecord {
  readonly label: string;
  readonly pid: number;
  readonly state: string;
  readonly children: number;
  readonly relevant: readonly string[];
  readonly signal: NodeJS.Signals | null;
  readonly goneAfterMs: number;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** `ps`'s state letter for `pid` (macOS and Linux), or `''` if `ps` fails or runs past `ms`. */
export function processState(pid: number, ms?: number): string {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      ...(ms === undefined ? {} : { timeout: Math.max(1, Math.ceil(ms)), killSignal: 'SIGKILL' }),
    }).trim();
  } catch {
    return '';
  }
}

function childCount(pid: number): number {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .trim()
      .split('\n').length;
  } catch {
    // pgrep answers 1 when nothing matched.
    return 0;
  }
}

async function backends(admin: AdminConnection, appName: string): Promise<readonly string[]> {
  const rows = await admin.execute<{ state: string | null }>(
    'select state from pg_stat_activity where application_name = $1',
    [appName],
  );
  return rows.map((row) => row.state ?? 'none');
}

/** Polls `probe` every 10 ms until it holds or `ms` runs out. */
export async function until(probe: () => Promise<boolean> | boolean, ms: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    // eslint-disable-next-line no-await-in-loop
    if (await probe()) return Date.now() - started;
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
  throw new Error(`not within ${String(ms)} ms`);
}

/**
 * Probes `pid` until it reads stopped (`T`) before one monotonic deadline `ms`
 * away, which the readings spend too: each `ps` gets only the time left. A
 * reading that ends past the deadline, or gives no state, leaves the stop
 * unproven at once, never passed. Each reading is kept for the kill record.
 */
export async function awaitStopped(
  pid: number,
  ms: number,
  probe: (pid: number, left: number) => string = processState,
): Promise<{ readonly stopped: boolean; readonly probes: readonly string[] }> {
  const probes: string[] = [];
  const deadline = performance.now() + ms;
  for (;;) {
    const at = performance.now();
    const seen = probe(pid, deadline - at);
    const done = performance.now();
    probes.push(`${seen || '-'} in ${String(Math.round(done - at))} ms`);
    if (done > deadline) {
      probes.push(`unproven: read after the ${String(ms)} ms deadline`);
      return { stopped: false, probes };
    }
    if (seen === '') {
      probes.push('unproven: ps gave no state');
      return { stopped: false, probes };
    }
    if (seen.startsWith('T')) return { stopped: true, probes };
    // eslint-disable-next-line no-await-in-loop
    await sleep(Math.min(10, deadline - performance.now()));
  }
}

/**
 * Stop `target` (it may have parked itself already), take checks 1 and 2,
 * kill it hard, then take checks 3 and 4. `relevantApp` names the process
 * whose backend must be idle: the API's.
 */
export async function hardKill(
  label: string,
  target: Killable,
  admin: AdminConnection,
  relevantApp: string,
): Promise<KillRecord> {
  if (!processState(target.pid).startsWith('T')) process.kill(target.pid, 'SIGSTOP');
  const { stopped, probes } = await awaitStopped(target.pid, 2_000);
  if (!stopped) evidence({ notStopped: { label, pid: target.pid, probes } });
  expect(stopped, `${label}: stopped within 2 s: ${probes.join(', ')}`).toBe(true);
  const state = processState(target.pid);
  const children = childCount(target.pid);
  const relevant = await backends(admin, relevantApp);
  // A stop that has not ended the process in 5 s answers null, not a hang.
  const signal = await Promise.race([
    (async () => {
      await target.stop();
      return await target.exited();
    })(),
    sleep(5_000).then(() => null),
  ]);
  // -1: still there after 10 s, or the process never ended.
  const goneAfterMs =
    signal === null
      ? -1
      : await until(async () => (await backends(admin, target.appName)).length === 0, 10_000).catch(
          () => -1,
        );
  const record = { label, pid: target.pid, state, children, relevant, signal, goneAfterMs };
  evidence({ kill: record });
  expect(state, `${label}: stopped`).toMatch(/^T/u);
  expect(children, `${label}: no child`).toBe(0);
  expect(relevant.length, `${label}: the API's backends were seen`).toBeGreaterThan(0);
  for (const one of relevant) expect(one, `${label}: backend state`).toMatch(/^idle/u);
  expect(signal, `${label}: exit signal`).toBe('SIGKILL');
  expect(goneAfterMs, `${label}: its backends gone`).toBeGreaterThanOrEqual(0);
  return record;
}

const HEAD = ((): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

/** The revision, machine and date each proof was observed on. */
export const OBSERVED: { readonly head: string; readonly machine: string; readonly date: string } =
  {
    head: HEAD,
    machine: `${platform()} ${arch()} ${release()}`,
    date: new Date().toISOString(),
  };

/** One line of the run's evidence, when the proof script asked for a file. */
export function evidence(entry: Record<string, unknown>): void {
  const file = process.env['L5_RESTART_EVIDENCE'];
  if (file !== undefined && file !== '') {
    appendFileSync(file, `runtime-proof: ${JSON.stringify({ ...OBSERVED, ...entry })}\n`);
  }
}

export interface WorkerProcess extends Killable {
  /** Resolves with the point once the worker has written `parked <point>`. */
  parked(): Promise<string>;
  lines(): readonly string[];
  resume(): void;
}

/** The parking worker as its own node process, on `api`, under the agent's delegation. */
export function startWorker(options: {
  readonly api: string;
  readonly taskId: string;
  readonly token: string;
  readonly delegation: string;
  readonly parkAt: string;
  readonly leaseSeconds: number;
  readonly appName: string;
  /** A provider fault injected at construction (T3e1), or `none`. */
  readonly fault?: string;
}): WorkerProcess {
  const child = spawn(process.execPath, ['tests/support/parking-worker.ts'], {
    env: {
      PATH: process.env['PATH'] ?? '',
      OPS_ASTRO_API_URL: options.api,
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_TOKEN: options.token,
      OPS_ASTRO_DELEGATION: options.delegation,
      PARK_TASK: options.taskId,
      PARK_AT: options.parkAt,
      PARK_LEASE_SECONDS: String(options.leaseSeconds),
      PARK_FAULT: options.fault ?? 'none',
      PGAPPNAME: options.appName,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const pidFile = process.env['L5_RESTART_PIDFILE'];
  if (pidFile !== undefined && child.pid !== undefined) appendFileSync(pidFile, `${child.pid}\n`);
  const written: string[] = [];
  let partial = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const all = (partial + chunk.toString('utf8')).split('\n');
    partial = all.pop() ?? '';
    written.push(...all);
  });
  const ended = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('exit', (_code, signal) => resolve(signal));
  });
  return {
    pid: child.pid as number,
    appName: options.appName,
    exited: async () => await ended,
    stop: async () => {
      child.kill('SIGKILL');
      await Promise.resolve();
    },
    parked: async () => {
      await until(() => written.some((line) => line.startsWith('parked ')), 60_000);
      return String(written.find((line) => line.startsWith('parked '))?.slice(7));
    },
    lines: () => written,
    resume: () => {
      process.kill(child.pid as number, 'SIGCONT');
    },
  };
}
