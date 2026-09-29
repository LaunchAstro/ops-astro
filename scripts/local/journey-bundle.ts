// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d (T4-R7): the evidence bundle the journey writes beside its case lines.
// It names the revision (head, tree, clean or not, and the served identity
// at the end of the run), the environment, the behaviour tested (every case
// line as recorded, each with its own status, never a count standing for
// coverage), the approval actually applied (the decision row's payload as
// the database holds it), the budgets with a pass or fail beside each, the
// crash points the restart legs parked and killed, and the open completion
// items with their owner and state. A run with no decision writes no bundle.
// Nothing in it claims acceptance: a local run establishes the journey on
// that revision, on that machine, on that date.

import { spawnSync } from 'node:child_process';

export interface Approval {
  readonly taskId: string;
  readonly decisionId: string;
  readonly decision: string;
  /** The decision row's payload exactly as the database holds it (`payload::text`). */
  readonly action: string;
}

export interface Bundle {
  readonly json: string;
  readonly markdown: string;
}

export interface BundleInput {
  readonly head: string;
  readonly tree: string;
  readonly clean: boolean;
  /** T2b's served-identity line from the end of the run. */
  readonly identity: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly cases: readonly {
    readonly case: string;
    readonly status: string;
    readonly detail: string;
  }[];
  readonly budgets: readonly Readonly<Record<string, string>>[];
  /** The restart legs' evidence, whose `runtime-proof` kill lines are the crash points. */
  readonly crashPoints: string;
  readonly approval: Approval | undefined;
}

function git(...parts: string[]): string {
  return spawnSync('git', parts, { encoding: 'utf8' }).stdout.trim();
}

/** The head, its tree and whether the working tree is clean, as the bundle cites them. */
export function revision(): { head: string; tree: string; clean: boolean } {
  return {
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    clean: git('status', '--porcelain') === '',
  };
}

function seconds(ms: number, budget: number): { measured: string; status: string } {
  return {
    measured: `${String(Math.round(ms / 1000))} s`,
    status: ms <= budget * 1000 ? 'pass' : 'fail',
  };
}

/** The budgets the command measures itself (10.2), and the seed time on its own line (RN-09). */
export function commandBudgets(
  migrateMs: number | undefined,
  totalMs: number,
  seedMs: number | undefined,
): Record<string, string>[] {
  const run = 'this run, its own container';
  return [
    {
      operation: 'All migrations on a fresh Postgres',
      budget: '60 s',
      ...seconds(migrateMs ?? 0, 60),
      against: run,
    },
    {
      operation: 'The T4 command end to end',
      budget: '15 minutes',
      ...seconds(totalMs, 900),
      against: `${run}, up to the bundle`,
    },
    {
      operation: 'Seed time (RN-09)',
      budget: 'recorded, no budget',
      measured: seedMs === undefined ? 'not measured' : `${String(seedMs)} ms`,
      status: 'recorded',
      against: "the journey's world, not section 10.1's fixture",
    },
  ];
}

const OWNER = /\b(T\d[a-z]\d?|CQ-\d+|INB-\d+|U\d\d|#\d+)\b/u;
const NOT_ESTABLISHED =
  "This is a local run: it establishes the journey observed on this revision, on this machine, on this date. Deployed access, real provider behaviour and readiness for a client are not established, and acceptance is the owner's click-through on staging (U01).";

/** The crash points, as the restart legs recorded them (RN-02); what they did not record is said. */
function crashPointsOf(evidence: string): readonly Record<string, unknown>[] {
  return evidence
    .split('\n')
    .filter((line) => line.startsWith('runtime-proof: ') && line.includes('"kill"'))
    .map((line) => {
      const { kill } = JSON.parse(line.slice('runtime-proof: '.length)) as {
        kill: Record<string, unknown>;
      };
      return {
        parkPoint: kill['label'],
        pid: kill['pid'],
        processState: kill['state'],
        backendStates: kill['relevant'],
        signal: kill['signal'],
        goneAfterMs: kill['goneAfterMs'],
        marksLeft: 'not recorded by the restart legs at this head',
      };
    });
}

function openItemsOf(input: BundleInput): readonly Record<string, string>[] {
  const fromCases = input.cases
    .filter((line) => line.status !== 'pass')
    .map((line) => ({
      item: line.case,
      owner: OWNER.exec(`${line.case} ${line.detail}`)?.[1] ?? 'the journey (T4)',
      state: `${line.status}: ${line.detail}`,
    }));
  const g5 = {
    item: "G5: five unbuilt domain and ranking items on the first build's completion list",
    owner: 'the first build',
    state: 'open; the five are not enumerated in this tree (product issues 10 and 24)',
  };
  return [...fromCases, g5];
}

export function writeBundle(input: BundleInput): Bundle {
  const { approval } = input;
  if (approval === undefined) {
    throw new Error(
      'bundle: no decision in this run; the bundle names the approval it applied, so none is written',
    );
  }
  const domain = input.cases.find((line) => line.case === 'protected: domain model');
  const bundle = {
    revision: {
      head: input.head,
      tree: input.tree,
      clean: input.clean,
      servedIdentity: input.identity,
    },
    environment: input.environment,
    behaviour: input.cases,
    approval,
    budgets: input.budgets,
    crashPoints: crashPointsOf(input.crashPoints),
    openItems: openItemsOf(input),
    textArrayProof: `owning_operation as text[] (0009, docs/local/AUTHORITY.md "The model corrections") affects the domain model; its proof at this head is this run's domain-model line: ${domain === undefined ? 'not run' : `${domain.status}, ${domain.detail}`}`,
    notEstablished: NOT_ESTABLISHED,
  };
  return {
    json: `${JSON.stringify(bundle, null, 2)}\n`,
    markdown: markdownOf(input, approval, bundle),
  };
}

/** One line per row, its values in order. */
function table(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  return rows.map((row) => `- ${Object.values(row).map(String).join(' | ')}`);
}

function markdownOf(
  input: BundleInput,
  approval: Approval,
  bundle: {
    readonly crashPoints: readonly Record<string, unknown>[];
    readonly openItems: readonly Record<string, string>[];
    readonly textArrayProof: string;
  },
): string {
  return [
    '# Journey evidence bundle',
    '',
    `Revision ${input.head} (tree ${input.tree}, ${input.clean ? 'clean' : 'uncommitted changes'}). Served identity at the end: ${input.identity}`,
    '',
    '## Environment',
    ...table([input.environment]),
    '',
    '## The approval applied',
    `Decision ${approval.decisionId} (${approval.decision}) on task ${approval.taskId}. The action as the database holds it:`,
    '',
    '```json',
    approval.action,
    '```',
    '',
    '## Behaviour tested',
    ...table(input.cases),
    '',
    '## Budgets (specification 10.2), each measured, never re-set',
    ...table(input.budgets),
    '',
    '## Crash points (RN-02)',
    ...table(bundle.crashPoints),
    '',
    '## Open completion items',
    ...table(bundle.openItems),
    '',
    '## The text[] change',
    bundle.textArrayProof,
    '',
    '## What this does not establish',
    NOT_ESTABLISHED,
    '',
  ].join('\n');
}
