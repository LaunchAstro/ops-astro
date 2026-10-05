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
  /** The people whose ids the row holds; empty for a row found by its text alone. */
  readonly people: readonly string[];
  /** Whether a value of the row holds the text. */
  readonly text: boolean;
  /** Whether the row holds an id given with --id. */
  readonly given: boolean;
  /** The shared ids the row holds: agents acting for others too, and logins given back that someone else's agent holds or held. */
  readonly shared: readonly string[];
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
    // An export can pass the default 1 MiB; a cut-short read would fail as a lost line.
    maxBuffer: 64 * 1024 * 1024,
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
