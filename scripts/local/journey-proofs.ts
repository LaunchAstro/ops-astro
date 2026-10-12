// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b2: what the journey's run must also hold, as case lines.
//
//   - `no_fallback_in_bundle` (T4-R3): the web app built by `scripts/build.mjs`
//     and searched for the strings that would select a fixture path
//     (`tests/ci/fixture-bundle.ts`, run as a process: scripts may not import
//     tests).
//   - The worker role's structure part: the shipped worker's module graph
//     reaches no Postgres driver (`tests/worker/worker-boundary.test.ts`); the
//     catalogue and behaviour parts are named suites.
//   - The protected set (product issue 24), listed here for the owner's
//     acceptance rather than assumed: each component with the suites that
//     prove it, and one verdict per component read from the same run's
//     conformance output, so a proof from another revision cannot stand in.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

export interface CaseLine {
  readonly case: string;
  readonly status: 'pass' | 'fail' | 'unrun';
  readonly detail: string;
}

export const PROTECTED: readonly (readonly [string, readonly string[]])[] = [
  [
    'domain model',
    [
      'tests/records/records-integrity.test.ts',
      'tests/records/slot-law.test.ts',
      'tests/records/model-negatives.test.ts',
      'tests/tasks/task-model.test.ts',
      'tests/tasks/task-spine.test.ts',
    ],
  ],
  [
    'tenancy wrapper',
    [
      'tests/tenancy/tenancy-conformance.test.ts',
      'tests/tenancy/tenancy-wrapper.test.ts',
      'tests/tenancy/wrapper-mutation.test.ts',
      'tests/tenancy/pooled-crossover.test.ts',
      'tests/tenancy/t4-worker-role.test.ts',
      'tests/tenancy/t4-no-notify.test.ts',
    ],
  ],
  [
    'migrations',
    [
      'tests/tenancy/migration-prefixes.test.ts',
      'tests/tenancy/migration-runner-guard.test.ts',
      'tests/runtime/storage-backstop-migrations.test.ts',
    ],
  ],
  [
    'gate engine',
    [
      'tests/runtime/gate.test.ts',
      'tests/runtime/gate-negatives.test.ts',
      'tests/reads/verified-decisions.test.ts',
    ],
  ],
  ['queue and delivery', ['tests/db/inbox-conformance.test.ts']],
];

/**
 * What this base cannot run yet, with the reason. Each prints `unrun` and
 * fails the command until the part lands here (Rebase notes on the pull request).
 */
export const UNRUN: readonly (readonly [string, string, Readonly<Record<string, string>>])[] = [
  [
    'T4c: the pinned-mockup comparison at 1480, 900 and 390',
    'T4c (#134) is not on this base; the re-baseline brings it',
    { owner: 'T4c', pr: '#134' },
  ],
  [
    'the browser pass (slice-acceptance) on this stack',
    'the web app signs in through GoTrue, which this stack does not start yet',
    { owner: 'T4b1' },
  ],
  [
    'keyboard-only and 390-wide passes over the whole journey (T4-R9)',
    'they drive the browser, which needs GoTrue on this stack',
    { owner: 'T4b2' },
  ],
];

/** One verdict per protected component, from `output`, the same run's `db-conformance` output. */
export function protectedVerdicts(
  output: string,
  manifest: { readonly invariant?: readonly string[]; readonly conformance?: readonly string[] },
): readonly CaseLine[] {
  const named = new Set([...(manifest.invariant ?? []), ...(manifest.conformance ?? [])]);
  // The runner's own failure forms (scripts/db-conformance.mjs): a failed
  // assertion, and its closing list of runs vitest ended in error, which still
  // names a suite once the assertion detail has run out.
  const failed = new Set(
    [
      ...output.matchAll(/db-conformance: failed assertion in (tests\/\S+?\.test\.tsx?)/gu),
      ...output.matchAll(/^\s+(tests\/\S+?\.test\.tsx?)\S*: (?:vitest|the report) /gmu),
    ].map((m) => m[1]),
  );
  // A suite run in parts prints one line per part, `<path>#i/k`.
  const reached = new Set(
    [...output.matchAll(/db-conformance: ([^\s#]+)\S* moved the database counter by (\d+) in /gu)]
      .filter((m) => Number(m[2]) > 0)
      .map((m) => m[1] as string),
  );
  return PROTECTED.map(([component, suites]): CaseLine => {
    const problems = suites.flatMap((suite) => {
      if (!named.has(suite)) return [`${suite} is not named in the manifest`];
      if (failed.has(suite)) return [`${suite} failed`];
      if (!reached.has(suite)) return [`${suite} did not reach the database in this run`];
      return [];
    });
    const detail =
      problems.length === 0 ? `${suites.join(', ')}: green in this run` : problems.join('; ');
    return {
      case: `protected: ${component}`,
      status: problems.length === 0 ? 'pass' : 'fail',
      detail,
    };
  });
}

/** The last line a check printed, which is where each of them says what it found. */
function last(text: string): string {
  return text.split('\n').at(-1) ?? '';
}

function run(command: string, args: readonly string[]): { ok: boolean; out: string } {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** The bundle case and the worker's structure case, each a line. */
export function builtCases(): readonly CaseLine[] {
  const built = run(process.execPath, ['scripts/build.mjs']);
  const scanned = built.ok ? run(process.execPath, ['tests/ci/fixture-bundle.ts']) : built;
  const structure = run(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/worker/worker-boundary.test.ts',
  ]);
  const tests = /Tests\s+[^\n]+/u.exec(structure.out)?.[0] ?? last(structure.out);
  return [
    {
      case: 'no_fallback_in_bundle (T4-R3)',
      status: scanned.ok ? 'pass' : 'fail',
      detail: last(scanned.out),
    },
    {
      case: 'T4 worker role: structure, no database driver in the worker',
      status: structure.ok ? 'pass' : 'fail',
      detail: `worker-boundary: ${tests}`,
    },
  ];
}
