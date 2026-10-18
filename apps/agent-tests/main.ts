// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent test commands (#1626 R11), on the replay fake:
//   node apps/agent-tests/main.ts <set> [--out <file>]
//     runs the named set (`cases.ts`) and writes its results file, by
//     default under `agent-test-results/`; exits 1 when a case fails.
//   node apps/agent-tests/main.ts review <results file> <review file>
//     saves Astra's review beside the results file, as
//     `<results>.astra-review.md`, never over one already saved.
// A refusal exits 2 and writes nothing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SETS } from './cases.ts';
import { isResults, runSet } from './harness.ts';

function refuse(why: string): never {
  process.stderr.write(`agent-tests: ${why}\n`);
  process.exit(2);
}

function saveReview(results: string | undefined, review: string | undefined): void {
  if (results === undefined || review === undefined) {
    refuse('review needs a results file and a review file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(results, 'utf8'));
  } catch {
    parsed = undefined;
  }
  if (!results.endsWith('.json') || !isResults(parsed)) refuse(`${results} is not a results file`);
  const beside = results.replace(/\.json$/u, '.astra-review.md');
  try {
    writeFileSync(beside, readFileSync(review), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      refuse(`a review is already saved at ${beside}`);
    }
    throw error;
  }
  process.stdout.write(`saved ${beside}\n`);
}

async function runNamed(name: string | undefined, args: readonly string[]): Promise<void> {
  const set = SETS.get(name ?? '');
  if (set === undefined) refuse(`no case set named ${name ?? ''}`);
  const at = args.indexOf('--out');
  const out =
    at === -1
      ? join(
          'agent-test-results',
          `${set.name}-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}.json`,
        )
      : args[at + 1];
  if (out === undefined) refuse('--out needs a file');
  const results = await runSet(set);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(
    `${set.name}: ${String(results.passed)} passed, ${String(results.failed)} failed; ${out}\n`,
  );
  process.exitCode = results.failed === 0 ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'review') saveReview(rest[0], rest[1]);
else await runNamed(command, rest);
