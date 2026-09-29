// SPDX-License-Identifier: AGPL-3.0-only
//
// T2b's suite support: the proposal body the cases send, and the worker run as
// its own process with only what its environment hands it.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Answer } from './fixture.ts';

const ROOT = resolve(import.meta.dirname, '../..');

export const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

export const proposal = (
  recordId: string,
  expectedRevision: number,
): Readonly<Record<string, unknown>> => ({
  operationId: randomUUID(),
  recordId,
  expectedRevision,
  purpose: 'synthetic_comment',
  maximumMinor: 2_500,
  currency: 'AUD',
  payload: { instruction: 'a synthetic change' },
  step: { kind: 'synthetic_comment', payload: {} },
});

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The worker, as its own process, with only what its environment hands it. */
export async function runWorker(env: Record<string, string>): Promise<Ran> {
  const child = spawn(process.execPath, [join(ROOT, 'apps/worker/main.ts'), '--once'], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const code = await new Promise<number | null>((done) => {
    child.on('close', done);
  });
  return { code, stdout, stderr };
}
