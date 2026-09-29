// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: the journey command's own Postgres. What it refuses before starting
// anything (another stack's port, a port in use, an image not already on this
// machine: it never pulls, spike RN-03), the container it starts from the
// pinned digest and migrates at this head, and the stop of the process groups
// the run created, never by name and never by a plain pid.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
export const IMAGE =
  'postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
export const DOCKER: string = process.env['DOCKER'] ?? '/usr/local/bin/docker';
/** The live pair, the lanes' fixed stacks and the other proofs' own ports. */
const WEB_AND_API = [5190, 5197, 5198, 5199, 8790, 8793, 8796, 8797, 8798, 8799];
const DENIED = new Set([
  ...WEB_AND_API,
  ...Array.from({ length: 14 }, (_, index) => 54390 + index),
]);

export function run(
  command: string,
  commandArgs: readonly string[],
  env: Readonly<Record<string, string>> = {},
): { ok: boolean; out: string } {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function answers(port: number): Promise<boolean> {
  return await new Promise<boolean>((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/** Every reason not to start, all of them, before anything is started. */
export async function refusalsBeforeStarting(
  ports: Readonly<Record<string, string>>,
  container: string,
): Promise<string[]> {
  const refusals: string[] = [];
  for (const [name, value] of Object.entries(ports)) {
    // Digits only, in range: `0x1F90`, ` 54430` and `70000` are not ports, whatever Number says.
    const port = /^\d{1,5}$/u.test(value) ? Number(value) : 0;
    const label = name.replaceAll(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);
    if (port < 1 || port > 65_535) refusals.push(`${label} port ${value} is not a port number`);
    else if (DENIED.has(port)) refusals.push(`${label} port ${value} belongs to another stack`);
    // eslint-disable-next-line no-await-in-loop -- one probe at a time
    else if (await answers(port)) refusals.push(`${label} port ${value} is already in use`);
  }
  if (!run(DOCKER, ['image', 'inspect', IMAGE]).ok) {
    refusals.push(`the pinned image is not on this machine and this command never pulls: ${IMAGE}`);
  }
  if (run(DOCKER, ['inspect', container]).ok) {
    refusals.push(`a container named ${container} exists already`);
  }
  return refusals;
}

/** The container from the pinned digest, the application group role, the migrations. */
export async function startPostgres(options: {
  readonly container: string;
  readonly password: string;
  readonly port: string;
  readonly admin: string;
}): Promise<{ ok: boolean; detail: string; migrateMs: number | undefined }> {
  const { container, password, port, admin } = options;
  const publish = `127.0.0.1:${port}:5432`;
  const env = ['-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=journey'];
  const started = run(DOCKER, ['run', '-d', '--name', container, '-p', publish, ...env, IMAGE]);
  if (!started.ok) return { ok: false, detail: started.out.trim(), migrateMs: undefined };
  const ready = [
    'exec',
    container,
    ...'pg_isready -q -h 127.0.0.1 -U postgres -d journey'.split(' '),
  ];
  for (let attempt = 0; attempt < 60 && !run(DOCKER, ready).ok; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- waiting for one server
    await new Promise((done) => {
      setTimeout(done, 1000);
    });
  }
  const psql = ['exec', '-e', `PGPASSWORD=${password}`, container, 'psql', '-v', 'ON_ERROR_STOP=1'];
  const sql = ['-q', '-U', 'postgres', '-d', 'journey', '-c', 'create role ops_astro_app nologin'];
  const role = run(DOCKER, [...psql, ...sql]);
  const migrating = performance.now();
  const migrated = run(process.execPath, ['scripts/db-migrate.mjs'], { DATABASE_ADMIN_URL: admin });
  const migrateMs = Math.round(performance.now() - migrating);
  const last = migrated.out.trim().split('\n').at(-1) ?? '';
  const detail = `${container} on 127.0.0.1:${port}; ${role.ok ? last : role.out.trim()}`;
  // Timed only when the migrations applied: a refused or failed run measured nothing.
  return { ok: role.ok && migrated.ok, detail, migrateMs: migrated.ok ? migrateMs : undefined };
}

/** What a member of one of the journey's own process groups runs. */
const JOURNEY_COMMANDS = ['tests/journey/run.ts', 'apps/api/server.ts', 'apps/cli/main.ts', 'vite'];

/**
 * Stop the process groups the run created, and nothing else. An entry `-<pgid>`
 * is a group the run made (the journey's run, vite); a plain pid in the file
 * is evidence of what ran and is never signalled, because a pid that exited
 * forty minutes ago may be another process's now (29 September). A group is
 * signalled only while it still has a member running one of the journey's own
 * commands; a group id is not reused while any member lives.
 */
export function stopStarted(pidfile: string, say: (line: string) => void): void {
  if (!existsSync(pidfile)) return;
  const table = run('ps', ['-A', '-o', 'pid=,pgid=,command=']).out.split('\n');
  const members = (group: number): string[] =>
    table.filter((row) => Number(row.trim().split(/\s+/u)[1]) === group);
  for (const entry of readFileSync(pidfile, 'utf8').split('\n')) {
    const id = Number(entry.split(' ')[0]);
    if (!Number.isInteger(id) || id >= 0) continue;
    const running = members(-id);
    if (running.length === 0) continue;
    if (!running.some((row) => JOURNEY_COMMANDS.some((command) => row.includes(command)))) {
      say(`not stopped: group ${String(-id)} runs no journey command now (${entry})`);
      continue;
    }
    try {
      process.kill(id, 'SIGKILL');
      say(`stopped ${entry}`);
    } catch {
      // Gone between the listing and the signal, which is the ordinary case.
    }
  }
  rmSync(pidfile, { force: true });
}
