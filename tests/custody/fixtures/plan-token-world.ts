// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared pieces of the P1 plan token proofs: an owner-only temp directory,
// synthetic tokens, a seeded record written through the real lock and commit,
// file faults named by step, and the child process that plays every second
// holder and restart.

import { fork, type ChildProcess } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  commitTokenFile,
  type PlanTokens,
  type TokenFile,
  type TokenFs,
} from '../../../packages/core-custody/src/token-file.ts';
import { withTokenLock } from '../../../packages/core-custody/src/token-lock.ts';

export const T0 = 1_800_000_000_000;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
export const HOUR = 3_600_000;

export function tempDir(): { readonly dir: string; readonly file: string; done(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'plan-token-'));
  chmodSync(dir, 0o700);
  return {
    dir,
    file: join(dir, 'plan-token.json'),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function tokens(
  tag: string,
  expiresAt: number,
  subject = 'synthetic-subject-a',
): PlanTokens {
  return {
    clientId: 'synthetic-client-id',
    accessToken: `synthetic-access-${tag}`,
    refreshToken: `synthetic-refresh-${tag}`,
    subject,
    expiresAt,
  };
}

export async function seed(file: string, record: TokenFile): Promise<void> {
  const out = await withTokenLock(file, { deadlineAt: Date.now() + 5_000 }, (held) =>
    Promise.resolve(commitTokenFile(held, file, record)),
  );
  if (!out.held || out.value !== 'durable') throw new Error('seed failed');
}

export function fileBytes(file: string): Buffer {
  return nodeFs.readFileSync(file);
}

/** The committed digest row, read outside P1 for assertions only. */
export function committedHex(file: string): string | undefined {
  if (!nodeFs.existsSync(`${file}.state`)) return undefined;
  const db = new DatabaseSync(`${file}.state`);
  try {
    const row = db.prepare('SELECT hex(digest) AS d FROM committed WHERE id = 1').get() as
      { d: string } | undefined;
    return row?.d.toLowerCase();
  } finally {
    db.close();
  }
}

export type FaultStep =
  | 'file-fsync'
  | 'link'
  | 'rename'
  | 'dir-fsync'
  | 'dir-fsync-and-undo'
  | 'digest-busy'
  | 'pause-after-rename';
export interface Fault {
  readonly step: FaultStep;
  readonly on: 'ready' | 'pending' | 'spent';
  /** pause-after-rename only: a marker written once the rename is done. */
  readonly marker?: string;
}

/**
 * File calls that fail once at the named step of the first write of the named
 * record state, in this process. Everything else is `node:fs`.
 */
// oxlint-disable-next-line max-lines-per-function -- one fault plan: the armed step, the record being written and each faulted call
export function faultyFs(fault: Fault): Partial<TokenFs> {
  let armed = true;
  let writing: string | undefined;
  let nextFd: number | undefined;
  const hit = (): boolean => armed && writing === fault.on;
  const fire = (): never => {
    armed = false;
    throw new Error('injected fault');
  };
  let busy: DatabaseSync | undefined;
  return {
    openSync: (path, flags, mode) => {
      const fd = nodeFs.openSync(path, flags, mode);
      if (String(path).endsWith('.next')) nextFd = fd;
      return fd;
    },
    writeSync: ((fd: number, buffer: Buffer, ...rest: []) => {
      if (fd === nextFd)
        writing = /^\{"state":"(\w+)"/u.exec(buffer.toString('latin1', 0, 32))?.[1];
      return nodeFs.writeSync(fd, buffer, ...rest);
    }) as TokenFs['writeSync'],
    fsyncSync: (fd) => {
      const dir = nodeFs.fstatSync(fd).isDirectory();
      if (hit() && !dir && fault.step === 'file-fsync') fire();
      if (hit() && dir && (fault.step === 'dir-fsync' || fault.step === 'dir-fsync-and-undo')) {
        if (fault.step === 'dir-fsync') armed = false;
        throw new Error('injected fault');
      }
      nodeFs.fsyncSync(fd);
    },
    linkSync: (from, to) => {
      if (hit() && fault.step === 'link') fire();
      nodeFs.linkSync(from, to);
    },
    renameSync: (from, to) => {
      const undo = String(from).endsWith('.undo');
      if (hit() && fault.step === 'rename' && !undo) fire();
      if (hit() && fault.step === 'dir-fsync-and-undo' && undo) fire();
      nodeFs.renameSync(from, to);
      if (hit() && !undo && fault.step === 'digest-busy') {
        armed = false;
        busy = new DatabaseSync(`${String(to)}.state`);
        busy.exec('BEGIN');
        busy.prepare('SELECT count(*) FROM committed').get();
      }
      if (hit() && !undo && fault.step === 'pause-after-rename' && fault.marker !== undefined) {
        nodeFs.writeFileSync(fault.marker, 'renamed');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    },
  };
}

export type ChildCommand =
  | {
      readonly op: 'prepare';
      readonly file: string;
      readonly tokenUrl: string;
      readonly at: number;
      readonly fault?: Fault;
    }
  | {
      readonly op: 'hold';
      readonly file: string;
      readonly id: string;
      readonly log: string;
      readonly ms: number;
      readonly deadlineMs: number;
    }
  | {
      readonly op: 'signin';
      readonly file: string;
      readonly record: TokenFile;
      readonly holdMs: number;
    };

export interface ChildRun {
  readonly child: ChildProcess;
  /** The next message the child sends. */
  next(): Promise<Record<string, unknown>>;
  /** Exit code or signal, with everything written to stdout and stderr. */
  exited(): Promise<{
    readonly code: number | null;
    readonly signal: string | null;
    readonly output: string;
  }>;
}

export function runChild(command: ChildCommand): ChildRun {
  const child = fork(
    join(
      import.meta.dirname,
      command.op === 'hold' ? 'token-lock-child.ts' : 'plan-token-child.ts',
    ),
    [JSON.stringify(command)],
    {
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const queue: Record<string, unknown>[] = [];
  const waiting: ((m: Record<string, unknown>) => void)[] = [];
  child.on('message', (m) => {
    const message = m as Record<string, unknown>;
    const take = waiting.shift();
    if (take === undefined) queue.push(message);
    else take(message);
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    next: () => {
      const ready = queue.shift();
      return ready === undefined
        ? new Promise((resolve) => {
            waiting.push(resolve);
          })
        : Promise.resolve(ready);
    },
    exited: async () => ({ ...(await exit), output }),
  };
}

/** A second holder or restart: prepares once, presents once, and exits. */
export async function holderInChild(
  file: string,
  tokenUrl: URL,
  at: number,
  fault?: Fault,
): Promise<{
  prepare: string;
  present: string;
  logs: string[];
  output: string;
  code: number | null;
}> {
  const run = runChild({
    op: 'prepare',
    file,
    tokenUrl: tokenUrl.href,
    at,
    ...(fault === undefined ? {} : { fault }),
  });
  const message = await run.next();
  const end = await run.exited();
  return {
    prepare: String(message['prepare']),
    present: String(message['present']),
    logs: message['logs'] as string[],
    output: end.output,
    code: end.code,
  };
}

export async function waitFor(path: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!nodeFs.existsSync(path)) {
    if (Date.now() > until) throw new Error('marker never appeared');
    // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next, in order
    await sleep(10);
  }
}
