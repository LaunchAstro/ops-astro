// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the runbook's copy finder (`scripts/privacy/find-copies.mjs`) run as a
// process, as an operator runs it, for `c81-privacy-runbook.test.ts`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect } from 'vitest';

const run = promisify(execFile);
const FINDER = new URL('../../scripts/privacy/find-copies.mjs', import.meta.url).pathname;

export interface Hit {
  readonly table: string;
  readonly id: string;
  readonly columns: readonly string[];
  readonly row?: Record<string, unknown>;
}

/**
 * The finder for one business (null runs it with none), against the database
 * at adminUrl. Its output never holds the connection string.
 */
export async function findCopies(
  adminUrl: string,
  args: readonly string[],
  business: string | null,
): Promise<{
  readonly code: number;
  readonly hits: readonly Hit[];
  readonly stdout: string;
  readonly stderr: string;
}> {
  const scope = business === null ? [] : ['--business', business];
  const done = await run('node', [FINDER, ...scope, ...args], {
    env: { ...process.env, DATABASE_ADMIN_URL: adminUrl },
  }).then(
    (out) => ({ code: 0, ...out }),
    (error: { readonly code?: number; readonly stdout?: string; readonly stderr?: string }) => ({
      code: error.code ?? -1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  );
  const password = new URL(adminUrl).password;
  if (password !== '') expect(`${done.stdout}${done.stderr}`).not.toContain(password);
  const hits = done.stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Hit);
  return { code: done.code, hits, stdout: done.stdout, stderr: done.stderr };
}
