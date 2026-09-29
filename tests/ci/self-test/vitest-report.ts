// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e: reading what vitest said about the files a mutation's check runs, from
// its JSON report rather than its exit code, so a run in which nothing
// executed is never taken for green or for red.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Ran, Scratch } from './mutations.ts';

export interface VitestReport {
  testResults: {
    name: string;
    status: string;
    message: string;
    assertionResults: { status: string; fullName: string }[];
  }[];
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Runs vitest in the scratch tree on `files` and keeps its JSON report, never its exit code alone. */
export function vitestReport(
  scratch: Scratch,
  files: readonly string[],
  env: NodeJS.ProcessEnv,
): VitestReport | undefined {
  const out = join(scratch.dir, '.local', `vitest-${randomUUID()}.json`);
  mkdirSync(join(scratch.dir, '.local'), { recursive: true });
  spawnSync(
    join(scratch.dir, 'node_modules/.bin/vitest'),
    ['run', '--reporter=json', `--outputFile=${out}`, ...files],
    { cwd: scratch.dir, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 1_800_000 },
  );
  if (!existsSync(out)) return undefined;
  const report = JSON.parse(readFileSync(out, 'utf8')) as VitestReport;
  rmSync(out, { force: true });
  return report;
}

/**
 * What the report says about `files`. A file that no longer loads is red and
 * says why; skipped cases are not counted as run. With `expect`, the red must
 * include a failing case of that name: another failure is not this check.
 */
export function summarise(
  scratch: Scratch,
  report: VitestReport | undefined,
  files: readonly string[],
  expect?: RegExp,
): Ran {
  const mine = (report?.testResults ?? []).filter((file) =>
    files.includes(relative(scratch.dir, file.name)),
  );
  if (mine.length === 0) return { applied: true, executed: 0, red: false, detail: 'no report' };
  // A file that fails as a whole (it does not load, or a hook threw) with no
  // failing case of its own: red, and the detail says why.
  const loads = mine
    .filter(
      (file) =>
        file.status === 'failed' && !file.assertionResults.some((one) => one.status === 'failed'),
    )
    .map(
      (file) =>
        `${relative(scratch.dir, file.name)} fails whole: ${firstLine(file.message) || 'a hook failed'}`,
    );
  const all = mine.flatMap((file) => file.assertionResults);
  const failing = all.filter((one) => one.status === 'failed').map((one) => one.fullName);
  const cases = all.filter((one) => one.status === 'passed').length + failing.length;
  const named = expect === undefined || failing.some((title) => expect.test(title));
  const skipped = all.length - cases;
  const tally = `${String(failing.length)} of ${String(cases)} cases failed`;
  const said = [skipped === 0 ? tally : `${tally}, ${String(skipped)} skipped`, ...loads];
  if (expect !== undefined) said.push(`${named ? '' : 'not '}failing ${expect.source}`);
  return {
    applied: true,
    executed: cases + loads.length,
    red: (failing.length > 0 || loads.length > 0) && named,
    detail: said.join('; '),
  };
}

export function vitest(
  scratch: Scratch,
  files: readonly string[],
  env: NodeJS.ProcessEnv,
  expect?: RegExp,
): Ran {
  return summarise(scratch, vitestReport(scratch, files, env), files, expect);
}
