// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared pieces of the P1 plan token proofs: an owner-only temp directory,
// synthetic tokens, a seeded record written through the real lock and commit,
// and the child process that plays every second lock holder.

import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitTokenFile,
  type PlanTokens,
  type TokenFile,
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

export interface ChildCommand {
  readonly op: 'hold';
  readonly file: string;
  readonly id: string;
  readonly log: string;
  readonly ms: number;
  readonly deadlineMs: number;
}

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
  const child = fork(join(import.meta.dirname, 'token-lock-child.ts'), [JSON.stringify(command)], {
    execPath: process.execPath,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
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
