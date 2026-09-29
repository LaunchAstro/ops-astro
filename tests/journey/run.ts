// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: the journey's test-side run, spawned by `scripts/local/journey.mjs`
// (scripts may not import tests, so the command runs this as its own process,
// as T4a's snapshot is run). It builds the two-business world on the
// command's own Postgres, serves the API and the web app on the command's
// ports, and prints one `journey-case {json}` line per case: the served
// identity at the start, the journey twice with the facts compared, the
// separation, the live update, one command-line process per declaration, a
// full restart read back, the replay compared byte for byte, and the served
// identity again at the end. Every process it starts goes into the command's
// pid file first. The world's database is kept for inspection.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorld, type World } from '../acceptance/world.ts';
import { serveApi, type ServedApi } from '../cli/cli-process-harness.ts';
import { everyDeclaration, liveWithin2s } from './checks.ts';
import { castSeparation, crossings } from './separation.ts';
import { holdSecret, redact } from './redact.ts';
import { compareFacts, readFacts } from './facts.ts';
import { personOn, runPass, type PassContext, type PassResult } from './passes.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`journey run: ${name} is not set`);
  return value;
};
const API_PORT = Number(env('JOURNEY_API_PORT'));
const WEB_PORT = Number(env('JOURNEY_WEB_PORT'));
const CONTAINER = env('JOURNEY_PG_CONTAINER');
const PIDFILE = env('JOURNEY_PIDFILE');
const DOCKER = process.env['DOCKER'] ?? '/usr/local/bin/docker';
const WEB = `http://127.0.0.1:${String(WEB_PORT)}`;
const pause = async (ms: number): Promise<void> => {
  await new Promise((done) => {
    setTimeout(done, ms);
  });
};

let failed = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failed += 1;
  const line = { case: name, status: ok ? 'pass' : 'fail', detail: redact(detail) };
  console.log(`journey-case ${JSON.stringify(line)}`);
}

async function check(name: string, run: () => Promise<string> | string): Promise<void> {
  try {
    report(name, true, await run());
  } catch (error) {
    report(name, false, String(error).slice(0, 600));
  }
}

/** Vite in its own process group, so it and the pnpm above it stop by this one pid. */
async function serveWeb(api: string): Promise<() => void> {
  const vite = ['exec', 'vite', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'];
  const child = spawn('pnpm', ['--filter', '@launchastro/web', ...vite], {
    cwd: ROOT,
    env: { ...process.env, API_ORIGIN: api, WEB_PORT: String(WEB_PORT) },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  const group = -(child.pid as number);
  appendFileSync(PIDFILE, `${String(group)} vite (process group)\n`);
  const stop = (): void => {
    try {
      process.kill(group, 'SIGTERM');
    } catch {
      // Already gone.
    }
  };
  for (let attempt = 0; attempt < 300; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling one server
    const up = await fetch(`${WEB}/__identity`).then(
      (answer) => answer.ok,
      () => false,
    );
    if (up) return stop;
    // eslint-disable-next-line no-await-in-loop -- polling one server
    await pause(100);
  }
  stop();
  throw new Error(`the web server did not answer on ${WEB}`);
}

/** T2b's served-identity check, the web origin and the API compared with this tree. */
function identity(api: string): string {
  const run = spawnSync(process.execPath, ['scripts/local/identity-check.mjs'], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', API_ORIGIN: api, WEB_ORIGIN: WEB },
    encoding: 'utf8',
  });
  if (run.status !== 0) throw new Error(`identity: ${run.stdout}${run.stderr}`.trim());
  return run.stdout.trim();
}

/** The same JSON with its keys sorted: tells a key-order difference from a content one. */
function sortedKeys(text: string): string {
  return JSON.stringify(sortValue(JSON.parse(text)));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([key, item]) => [key, sortValue(item)]));
}

/** B27, then CQ-14's compare: every write sent again after the restart, bodies byte for byte. */
async function restartCases(world: World, passes: readonly PassResult[], context: PassContext) {
  const differ: string[] = [];
  const replays: string[] = [];
  let keyOrderOnly = 0;
  let count = 0;
  for (const pass of passes) {
    const { receipt } = pass.facts;
    // eslint-disable-next-line no-await-in-loop -- one pass at a time
    const reread = await readFacts(world.db.admin, world.alpha, pass.taskId, receipt);
    const compared = compareFacts(pass.facts, reread);
    if (!compared.ok) differ.push(`${pass.surface}: ${compared.failures.join('; ')}`);
    const person = personOn(pass.surface, context, world.ada.token);
    for (const sent of pass.sent) {
      count += 1;
      // eslint-disable-next-line no-await-in-loop -- replayed in the order sent
      const answer = await person(sent.name, sent.body);
      if (answer.text === sent.answer) continue;
      if (sortedKeys(answer.text) === sortedKeys(sent.answer)) keyOrderOnly += 1;
      else replays.push(`${pass.surface} ${sent.name}: ${sent.answer} then ${answer.text}`);
    }
  }
  const reread = `${String(passes.length)} tasks re-read, facts identical`;
  report(
    'B27: facts read back identically after an API and Postgres restart',
    differ.length === 0 && passes.length === 2,
    differ.join(' | ') || reread,
  );
  const order =
    keyOrderOnly === 0
      ? ''
      : `${String(keyOrderOnly)} of ${String(count)} replays differ in key order only (the stored answer is jsonb; product issue 58, CQ-14's fix)`;
  const detail = [order, ...replays].filter((part) => part !== '').join(' | ');
  report(
    'replay byte for byte after restart (CQ-14 compare)',
    detail === '' && count > 0,
    detail || `${String(count)} writes replayed by operation identity, bodies identical`,
  );
}

async function passCases(context: PassContext): Promise<PassResult[]> {
  const cast = await castSeparation(context);
  const passes: PassResult[] = [];
  for (const surface of ['app', 'cli'] as const) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the passes run in order
      passes.push(await runPass(surface, context));
    } catch (error) {
      report(`the ${surface} pass`, false, String(error).slice(0, 600));
    }
  }
  const find = (surface: string) => passes.find((pass) => pass.surface === surface)?.facts;
  const compared = compareFacts(find('app'), find('cli'));
  const same =
    'app and CLI facts identical: decisions, receipt, reservations, attempts, events, audit, alerts';
  report(
    'journey_twice_same_facts',
    compared.ok,
    compared.ok ? same : compared.failures.join(' | '),
  );
  await check('separation: business, client and delegation crossings refused', async () => {
    const leaks = await crossings(context, cast, passes);
    if (passes.length < 2) leaks.push('a pass did not run');
    if (leaks.length > 0) throw new Error(leaks.join(' | '));
    return 'bravo, an external party of alpha and the agent under another task delegation each refused both passes tasks beside a positive control; no answer carries the canary';
  });
  return passes;
}

async function main(): Promise<void> {
  const world = await createWorld('journey');
  for (const caller of [world.ada, world.mia, world.noah, world.orphan, world.bea, world.agent]) {
    holdSecret(caller.token);
  }
  const keys = mkdtempSync(join(tmpdir(), 'journey-keys-'));
  // A record of every process started, beside the pid file; only groups are ever stopped.
  process.env['CLI_PROCESS_PIDFILE'] = `${PIDFILE}.started`;
  const serve = async (): Promise<ServedApi> =>
    await serveApi(world, { port: API_PORT, keys, recovery: 'alpha,bravo' });
  let served = await serve();
  const stopWeb = await serveWeb(served.origin);
  const kept = `database ${world.db.name} kept for inspection; api ${served.origin}, web ${WEB}`;
  report('stack: API and web served by this run', true, kept);
  await check('identity at the start (T2b)', () => identity(served.origin));
  const title = `Journey ${new Date().toISOString()}`;
  const context: PassContext = { world, api: served.origin, app: WEB, title };
  const passes = await passCases(context);
  await check('live update within 2 s (RN-01)', async () => await liveWithin2s(context, WEB));
  await check(
    'one command-line process per declaration (RN-10)',
    async () => await everyDeclaration(context),
  );
  await served.stop();
  const restarted = spawnSync(DOCKER, ['restart', CONTAINER], { encoding: 'utf8' });
  if (restarted.status !== 0) throw new Error(`docker restart ${CONTAINER}: ${restarted.stderr}`);
  // Over TCP, as the start waits: the restarted server answers its socket first.
  const ready = ['exec', CONTAINER, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'];
  for (let attempt = 0; attempt < 60 && spawnSync(DOCKER, ready).status !== 0; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- waiting for one server
    await pause(500);
  }
  served = await serve();
  await restartCases(world, passes, context);
  await check('identity at the end (T2b)', () => identity(served.origin));
  await served.stop();
  stopWeb();
  await world.db.admin.close();
  await world.db.app.close();
}

try {
  await main();
} catch (error) {
  report('run', false, String(error).slice(0, 600));
}
process.exitCode = failed === 0 ? 0 : 1;
