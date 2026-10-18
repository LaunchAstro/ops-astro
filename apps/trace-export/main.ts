// SPDX-License-Identifier: AGPL-3.0-only
//
// The trace export's own process on the M5 (#1708): production's API is the
// Vercel function, which never starts the exporter, and the pinned target
// answers on the M5's loopback alone (`docs/local/LANGFUSE.md`). launchd runs
// this with `deploy/m5/ops-astro-trace-export.plist`; it starts nothing else.
//
// **Off unless the settings say on.** Every setting is in one file only its
// owner may read, named by `TRACE_EXPORT_SETTINGS_FILE`, so no secret is in an
// argument, the plist or a log. `TRACE_EXPORT` unset or `off` there: the
// process says so and exits 0, having opened no connection. On, the export's
// own settings (`traceExportSettings`) and two more: `DATABASE_TRACE_URL`, a
// login that is a member of `ops_astro_trace` alone, and
// `TRACE_EXPORT_BUSINESSES`, the business ids it exports. A problem names
// the setting, never its value.
//
// **No recorder attaches.** It runs only as `node --disable-sigusr1`, with no
// other runtime flag and no `NODE_OPTIONS` or `NODE_V8_COVERAGE`: an inspector,
// a preloaded module or a coverage writer would see the trace key and the
// login. Anything else exits 2 before the settings file is opened, and the
// flag keeps a running process from opening an inspector on SIGUSR1.
//
// **A run never waits on it.** It reads `run_events` by its own cursor on its
// own login; stopped, its gap is the cursor, and it catches up when started.

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { url as inspectorUrl } from 'node:inspector';
import { parseEnv } from 'node:util';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import type { TraceDatabase } from '../../packages/core-runtime/src/index.ts';
import { startTraceExporter, traceExportSettings } from '../api/trace-exporter.ts';

export const SETTINGS_FILE = 'TRACE_EXPORT_SETTINGS_FILE';
export const DATABASE_SETTING = 'DATABASE_TRACE_URL';
export const BUSINESSES_SETTING = 'TRACE_EXPORT_BUSINESSES';
/** The group the login is a member of (migration 20261018222300), taken in each transaction. */
export const TRACE_ROLE = 'ops_astro_trace';
/** The one runtime flag it runs with. */
export const NO_SIGNAL_INSPECTOR = '--disable-sigusr1';

type Settings = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TLS = new Set(['require', 'verify-ca', 'verify-full']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Why a recorder could attach, or undefined: exactly the one flag, and no preload by environment. */
export function recorderProblem(execArgv: readonly string[], env: Settings): string | undefined {
  if (execArgv.length !== 1 || execArgv[0] !== NO_SIGNAL_INSPECTOR) {
    return `a recorder could attach: run as node ${NO_SIGNAL_INSPECTOR} with no other flag`;
  }
  for (const name of ['NODE_OPTIONS', 'NODE_V8_COVERAGE']) {
    if ((env[name] ?? '') !== '') return `a recorder could attach: ${name} is set`;
  }
  if (inspectorUrl() !== undefined) return 'a recorder could attach: an inspector is open';
  return undefined;
}

/** The settings file's contents, or why not: opened once, so the mode checked is the file read. */
export function settingsFrom(file: string | undefined): Settings | string {
  if (file === undefined || file === '') return `${SETTINGS_FILE} names no file`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, 'r');
    if ((fstatSync(descriptor).mode & 0o077) !== 0)
      return 'the settings file is readable by others';
    return { ...parseEnv(readFileSync(descriptor, 'utf8')) };
  } catch {
    return 'the settings file is unreadable';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The login's address: postgres, over TLS unless the database is on this machine. */
export function databaseProblem(raw: string | undefined): string | undefined {
  const url = URL.parse(raw ?? '');
  if (url === null || !/^postgres(?:ql)?:$/u.test(url.protocol)) {
    return `${DATABASE_SETTING} is not a database login (postgres://...)`;
  }
  const modes = url.searchParams.getAll('sslmode');
  const tls = modes.length === 1 && TLS.has(modes[0] ?? '') && !url.searchParams.has('ssl');
  if (!tls && !LOOPBACK.has(url.hostname)) {
    return `${DATABASE_SETTING} does not require TLS (add ?sslmode=require or stricter)`;
  }
  return undefined;
}

/** The business ids, comma separated, lower-case uuids, at least one; repeats once. */
export function businessesFrom(raw: string | undefined): readonly string[] | string {
  const ids = (raw ?? '').split(',').map((entry) => entry.trim());
  if (ids.some((id) => !UUID.test(id))) {
    return `${BUSINESSES_SETTING} is not a comma-separated list of lower-case business ids`;
  }
  return [...new Set(ids)];
}

/** Each of the exporter's transactions as `ops_astro_trace`, the login's one group. */
export function asTraceRole(database: Pick<Database, 'withBusiness'>): TraceDatabase {
  return {
    withBusiness: async (businessId, run) =>
      await database.withBusiness(businessId as never, async (tx) => {
        await tx.query(`select set_config('role', $1, true)`, [TRACE_ROLE]);
        return await run(tx);
      }),
  };
}

const say = (line: string): void => void process.stdout.write(`trace export: ${line}\n`);
const refuse = (line: string): number => {
  process.stderr.write(`trace export: ${line}\n`);
  return 2;
};

export async function main(execArgv: readonly string[], env: Settings): Promise<number> {
  const recorder = recorderProblem(execArgv, env);
  if (recorder !== undefined) return refuse(recorder);
  const settings = settingsFrom(env[SETTINGS_FILE]);
  if (typeof settings === 'string') return refuse(settings);
  const trace = traceExportSettings(settings);
  if (trace.kind === 'off') {
    say('off');
    return 0;
  }
  if (trace.kind === 'invalid') return refuse(trace.problem);
  const database = databaseProblem(settings[DATABASE_SETTING]);
  if (database !== undefined) return refuse(database);
  const businesses = businessesFrom(settings[BUSINESSES_SETTING]);
  if (typeof businesses === 'string') return refuse(businesses);

  const connection = connect(settings[DATABASE_SETTING] as string, { source: 'trace-export' });
  const exporter = await startTraceExporter(
    trace,
    asTraceRole(connection),
    async () => await Promise.resolve(businesses),
  );
  say(`on for ${String(businesses.length)} business${businesses.length === 1 ? '' : 'es'}`);
  // The export's intervals are unreferenced: this holds the process until it is told to stop.
  const awake = setInterval(() => undefined, 1 << 30);
  await new Promise<void>((done) => {
    process.once('SIGTERM', done);
    process.once('SIGINT', done);
  });
  clearInterval(awake);
  await exporter.stop();
  await connection.close();
  say('stopped');
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.execArgv, process.env);
