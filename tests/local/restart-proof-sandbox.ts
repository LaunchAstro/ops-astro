// SPDX-License-Identifier: AGPL-3.0-only
//
// `scripts/local/restart-proof.sh` copied into a directory of its own, with
// stand-ins on PATH for everything it reaches outside the shell: `docker`
// (no container is started), `nc` (every port free), `git` (a fixed head),
// `pnpm` (the suite: a shell that starts a long-lived "API" and records both
// pids with their process groups) and `scripts/db-migrate.mjs` (writes a
// marker). Each stand-in appends what it was asked to a file in the sandbox.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export const NAME = 'restart-sandbox-pg';
export const PORT = '64051';
const API_PORT = '64052';

/** The stand-in Docker: no container named NAME, the image present, one id, this run's port. */
export const DOCKER = `
case "$1" in
  inspect) exit 1 ;;
  image) exit 0 ;;
  run) echo standin-cid ;;
  port) echo "127.0.0.1:$STANDIN_PORT" ;;
esac
exit 0
`;

/** The stand-in suite. STANDIN_SUITE is what it does once its API is up and recorded. */
const SUITE = `
sleep 30 >/dev/null 2>&1 &
api=$!
printf '%s %s\\n' "$$" "$(ps -o pgid= -p $$ | tr -d ' ')" >>"$STANDIN_DIR/suite"
printf '%s %s\\n' "$api" "$(ps -o pgid= -p "$api" | tr -d ' ')" >>"$STANDIN_DIR/api"
eval "\${STANDIN_SUITE:-exit 0}"
`;

export interface Ran {
  readonly status: number | null;
  readonly out: string;
}

export interface Sandbox {
  readonly dir: string;
  readonly evidence: string;
  /** restart-proof.sh started with these extra arguments and environment. */
  start(args?: readonly string[], env?: Readonly<Record<string, string>>): ChildProcess;
  /** Started and run to its end. */
  run(args?: readonly string[], env?: Readonly<Record<string, string>>): Promise<Ran>;
  /** What `docker` was asked, one call a line. */
  docker(): string[];
  /** The pid and process group of each process a stand-in recorded in `file` ("suite" or "api"). */
  recorded(file: string): { pid: number; pgid: number }[];
  remove(): void;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

/** The copied script and its stand-ins under `dir`; returns the script's path. */
function populate(dir: string, docker: string): string {
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  for (const path of [join(repo, 'scripts/local'), bin]) mkdirSync(path, { recursive: true });
  const script = join(repo, 'scripts/local/restart-proof.sh');
  copyFileSync(join(root, 'scripts/local/restart-proof.sh'), script);
  writeFileSync(
    join(repo, 'scripts/db-migrate.mjs'),
    "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(`${process.env.STANDIN_DIR}/migrated`, 'migrated\\n');\n",
  );
  executable(join(bin, 'docker'), `printf '%s\\n' "$*" >>"$STANDIN_DIR/docker.log"\n${docker}`);
  executable(join(bin, 'nc'), 'exit 1\n');
  executable(join(bin, 'git'), 'echo 0123456789abcdef0123456789abcdef01234567\n');
  executable(join(bin, 'pnpm'), SUITE);
  return script;
}

/** Everything a stand-in wrote to `file`, a line each. */
function lines(dir: string, file: string): string[] {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

/** Resolves when `child` has closed, with its exit status, and everything it printed. */
async function finished(child: ChildProcess): Promise<Ran> {
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  const status = await new Promise<number | null>((done) => {
    child.once('close', done);
  });
  return { status, out };
}

export function sandbox(docker: string = DOCKER): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'restart-proof-'));
  const script = populate(dir, docker);
  const evidence = join(dir, 'evidence.txt');
  const own = ['--name', NAME, '--port', PORT, '--api-port', API_PORT, '--evidence', evidence];
  const start = (args: readonly string[] = [], env: Readonly<Record<string, string>> = {}) =>
    spawn('bash', [script, ...own, ...args], {
      env: {
        ...process.env,
        DOCKER: join(dir, 'bin/docker'),
        PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
        STANDIN_DIR: dir,
        STANDIN_PORT: PORT,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  return {
    dir,
    evidence,
    start,
    run: async (args, env) => await finished(start(args, env)),
    docker: () => lines(dir, 'docker.log'),
    recorded: (file) =>
      lines(dir, file).map((line) => {
        const [pid = 0, pgid = 0] = line.split(' ').map(Number);
        return { pid, pgid };
      }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Resolves after `ms`. */
export async function pause(ms: number): Promise<void> {
  await new Promise((wake) => {
    setTimeout(wake, ms);
  });
}

/** Whether `pid` is still running (a zombie awaiting its reaper is not). */
export function alive(pid: number): boolean {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return state.status === 0 && !state.stdout.trim().startsWith('Z');
}

/** Polls until `done` holds or `ms` pass. */
export async function until(done: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (done()) return true;
    // eslint-disable-next-line no-await-in-loop -- one poll at a time
    await pause(50);
  }
  return done();
}

/**
 * Ends what a stand-in started, if it is still a stand-in's `sleep 30` or
 * suite shell: the recorded pids and each suite shell's own `sleep`, never
 * another process.
 */
export function endLeftovers(box: Sandbox): void {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const rows = table.stdout.split('\n').map((row) => {
    const [, pid = '0', ppid = '0', command = ''] = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(row) ?? [];
    return { pid: Number(pid), ppid: Number(ppid), command };
  });
  const suites = box.recorded('suite').map(({ pid }) => pid);
  const ours = new Set([
    ...suites,
    ...box.recorded('api').map(({ pid }) => pid),
    ...rows.filter((row) => suites.includes(row.ppid)).map((row) => row.pid),
  ]);
  for (const { pid, command } of rows) {
    if (ours.has(pid) && /^(?:sleep 30$|\/bin\/sh .*\/bin\/pnpm )/u.test(command)) {
      process.kill(pid, 'SIGKILL');
    }
  }
}
