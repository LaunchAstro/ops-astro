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
//     `db-conformance` prints one verdict line per run item, made here by
//     `verdictLine` from that item's own report, and `protectedVerdicts`
//     reads those lines and nothing else.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { itemOf } from '../db-shards.ts';

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
  // Also needs the same run's restart leg, which holds `inbox-worker-restart`.
  [
    'queue and delivery',
    ['tests/db/inbox-conformance.test.ts', 'tests/commands/inbox-restart.test.ts'],
  ],
];

/** What `db-conformance` knows of one run item once it has run. */
export interface ItemResult {
  readonly run: {
    readonly status: number | null;
    readonly signal?: string | null;
    readonly error?: unknown;
  };
  /** vitest's JSON report, or undefined when none could be read. */
  readonly report:
    | {
        readonly success?: boolean;
        readonly errors?: readonly unknown[];
        readonly testResults?: readonly {
          readonly name?: string;
          readonly message?: string;
          readonly assertionResults?: readonly { readonly status?: string }[];
        }[];
      }
    | undefined;
  readonly moved: number;
  readonly clientSessions: number;
  readonly readError?: unknown;
  /** What one read of the counter costs on this database. */
  readonly cost: number;
}

const NOT_RUN = new Set(['skipped', 'pending', 'todo']);

/** One run item's verdict line, judged from that item's own report and counter reads. */
export function verdictLine(item: string, result: ItemResult): string {
  const { run: vitest, report } = result;
  const assertions = (report?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const reasons = [
    report === undefined && 'no readable report',
    vitest.error !== undefined && vitest.error !== null && 'vitest could not be started',
    typeof vitest.signal === 'string'
      ? `vitest was killed by ${vitest.signal}`
      : vitest.status !== 0 && `vitest exited with status ${String(vitest.status)}`,
    report?.success === false && 'the report says the run failed',
    ((report?.errors ?? []).length > 0 ||
      (report?.testResults ?? []).some((file) => String(file.message ?? '').trim() !== '')) &&
      'the report carries an error',
    assertions.some((test) => test.status === 'failed') && 'failed assertion',
    assertions.some((test) => NOT_RUN.has(String(test.status))) && 'skipped',
    result.readError !== undefined && 'a counter read failed',
    result.moved <= result.cost && `no database movement (${String(result.moved)})`,
    result.clientSessions <= 0 && 'no client session',
  ].filter((reason) => typeof reason === 'string');
  const detail =
    reasons.length === 0
      ? `${String(assertions.length)} test(s) passed, the counter moved by ${String(result.moved)}`
      : reasons.join('; ');
  return `db-conformance: verdict ${reasons.length === 0 ? 'ok' : 'failed'} ${item}: ${detail}`;
}

/**
 * One verdict per protected component, from `output`, the same run's
 * `db-conformance` output. `expected.items` is every run item the manifest and the
 * shard plan expect (each named suite when absent), and `expected.restartLeg`
 * whether the same run's restart leg passed.
 */
export function protectedVerdicts(
  output: string,
  expected: {
    readonly invariant?: readonly string[];
    readonly conformance?: readonly string[];
    readonly items?: readonly string[];
    readonly restartLeg?: boolean;
  },
): readonly CaseLine[] {
  const named = new Set([...(expected.invariant ?? []), ...(expected.conformance ?? [])]);
  const items = expected.items ?? [...named];
  const lines = [...output.matchAll(/^db-conformance: verdict (ok|failed) (\S+): (.*)$/gmu)].map(
    ([, verdict, item = '', detail]) => ({ ok: verdict === 'ok', item, detail }),
  );
  return PROTECTED.map(([component, suites]): CaseLine => {
    const problems = suites.flatMap((suite) => {
      if (!named.has(suite)) return [`${suite} is not named in the manifest`];
      const own = items.filter((item) => itemOf(item).suite === suite);
      if (own.length === 0) return [`${suite} is not a run item`];
      const stray = lines.filter(
        (line) => itemOf(line.item).suite === suite && !own.includes(line.item),
      );
      return [
        ...own.flatMap((item) => {
          const mine = lines.filter((line) => line.item === item);
          if (mine.length === 0) return [`${item}: no verdict in this run`];
          if (mine.length > 1) return [`${item}: ${String(mine.length)} verdicts in this run`];
          return mine[0]?.ok === true ? [] : [`${item}: ${String(mine[0]?.detail)}`];
        }),
        ...stray.map((line) => `${line.item}: not an item this run expects`),
      ];
    });
    if (component === 'queue and delivery' && expected.restartLeg !== true) {
      problems.push('the restart leg (runtime-proofs) did not pass in this run');
    }
    return {
      case: `protected: ${component}`,
      status: problems.length === 0 ? 'pass' : 'fail',
      detail:
        problems.length === 0 ? `${suites.join(', ')}: green in this run` : problems.join('; '),
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
