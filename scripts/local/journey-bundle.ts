// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d (T4-R7): the evidence bundle the journey writes beside its case lines.
// It names the revision (head, tree, clean or not, and the served identity
// at the end of the run), the environment, the behaviour tested (every case
// line as recorded, each with its own status, never a count standing for
// coverage), the approval actually applied (the digest of the decision
// row's exact payload, its identifiers shown and its note withheld), the budgets with a pass or fail beside each, the
// crash points the restart legs parked and killed, and the open completion
// items with their owner and state. A run with no decision writes no bundle.
// Nothing in it claims acceptance: a local run establishes the journey on
// that revision, on that machine, on that date.

import { spawnSync } from 'node:child_process';
import { availableParallelism, loadavg } from 'node:os';
import { approvalOf, digestDetail, digestOf, scrub, withhold } from './journey-withhold.ts';

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

/**
 * A case line as the command hands it over. `detail` is free text and is
 * private at the bundle boundary; `facts` is metadata the command's own code
 * typed separately (an owner, a pull request, a time, a tree hash), and it is
 * the only part of a case the bundle shows beside its name and status.
 */
export interface CaseLine {
  readonly case: string;
  readonly status: string;
  readonly detail: string;
  readonly facts?: Readonly<Record<string, string | number | boolean>>;
}

export interface BundleInput {
  readonly head: string;
  readonly tree: string;
  readonly clean: boolean;
  /** T2b's served-identity line from the end of the run. */
  readonly identity: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly cases: readonly CaseLine[];
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

/**
 * A time against its budget. No measurement, and no positive one (a failed
 * start records nothing to time), is unrun: a budget passes only on a number
 * that was taken (Sol, review 1 on #164).
 */
function seconds(ms: number | undefined, budget: number): { measured: string; status: string } {
  if (ms === undefined || !(ms > 0)) return { measured: 'not measured', status: 'unrun' };
  return {
    measured: `${String(Math.round(ms / 1000))} s`,
    status: ms <= budget * 1000 ? 'pass' : 'fail',
  };
}

/**
 * The budgets the command measures itself (10.2), and the seed time on its own
 * line (RN-09). `journeyRan` is the command's word that its journey ran to its
 * end; without it the end-to-end budget is unrun.
 */
export function commandBudgets(
  migrateMs: number | undefined,
  totalMs: number,
  seedMs: number | undefined,
  loadAtStart?: number,
  journeyRan = false,
): Record<string, string>[] {
  const run = 'this run, its own container';
  // The whole command is timed only when a journey ran on a stack that
  // started: an aborted run's elapsed time is not the command's (Sol, review 2).
  const completed = journeyRan && migrateMs !== undefined && migrateMs > 0;
  // The machine's load beside each time (Sol, review 1 on #164): lanes share it.
  const cpus = `${String(availableParallelism())} CPUs`;
  const start = loadAtStart === undefined ? 'not recorded' : loadAtStart.toFixed(2);
  const load = `1-min load ${start} at the start of the run, ${(loadavg()[0] ?? 0).toFixed(2)} at the bundle, ${cpus}`;
  return [
    {
      operation: 'All migrations on a fresh Postgres',
      budget: '60 s',
      ...seconds(migrateMs, 60),
      against: run,
      load,
    },
    {
      operation: 'The T4 command end to end',
      budget: '15 minutes',
      ...(completed
        ? seconds(totalMs, 900)
        : { measured: 'not measured: no journey ran', status: 'unrun' }),
      against: `${run}, up to the bundle`,
      load,
    },
    {
      operation: 'Seed time (RN-09)',
      budget: 'recorded, no budget',
      measured: seedMs === undefined ? 'not measured' : `${String(seedMs)} ms`,
      status: 'recorded',
      against: "the journey's world, not section 10.1's fixture",
      load,
    },
  ];
}

/** Facts as typed: strings, numbers and booleans only, whatever else a caller passes. */
function typedFacts(
  facts: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) =>
      ['string', 'number', 'boolean'].includes(typeof value),
    ),
  ) as Record<string, string | number | boolean>;
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
      // The owner the command typed, else a name in the case's own title, which
      // the command's code wrote; never read out of the detail.
      owner:
        (typeof line.facts?.['owner'] === 'string' ? line.facts['owner'] : undefined) ??
        OWNER.exec(line.case)?.[1] ??
        'the journey (T4)',
      state: `${line.status}: ${line.detail}`,
    }));
  const g5 = {
    item: "G5: five unbuilt domain and ranking items on the first build's completion list",
    owner: 'the first build',
    state: 'open; the five are not enumerated in this tree (product issues 10 and 24)',
  };
  return [...fromCases, g5];
}

export function writeBundle(raw: BundleInput): Bundle {
  const { approval } = raw;
  if (approval === undefined) {
    throw new Error(
      'bundle: no decision in this run; the bundle names the approval it applied, so none is written',
    );
  }
  // Everything the run hands over passes through withholding before any of it
  // is written (Sol, review 2 on #164): case details, open items built from
  // them, the identity line, the environment and the budgets.
  const held = new Set<string>();
  const fields = (row: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, withhold(value, held)]));
  const input: BundleInput = {
    ...raw,
    identity: withhold(raw.identity, held),
    environment: fields(raw.environment),
    // A case detail is free text: its digest alone crosses this boundary; the
    // command's typed facts stand beside it (Sol, review 3 and REV164D).
    cases: raw.cases.map((line) => ({
      case: line.case,
      status: line.status,
      detail: digestDetail(line.detail),
      ...(line.facts === undefined ? {} : { facts: typedFacts(line.facts) }),
    })),
    budgets: raw.budgets.map((row) => fields(row)),
  };
  const shown = approvalOf(approval, held);
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
    approval: shown,
    budgets: input.budgets,
    crashPoints: crashPointsOf(input.crashPoints),
    openItems: openItemsOf(input),
    textArrayProof: `owning_operation as text[] (0009, docs/local/AUTHORITY.md "The model corrections") affects the domain model; its proof at this head is this run's domain-model line: ${domain === undefined ? 'not run' : `${domain.status}, ${domain.detail}`}`,
    notEstablished: NOT_ESTABLISHED,
  };
  return {
    json: scrub(`${JSON.stringify(bundle, null, 2)}\n`, held),
    markdown: scrub(markdownOf(input, approval, bundle, shown), held),
  };
}

/** A table cell: typed facts as JSON, anything else as its text. */
function cell(value: unknown): string {
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** One line per row, its values in order. */
function table(rows: readonly Readonly<Record<string, unknown>>[]): string[] {
  return rows.map(
    (row) =>
      `- ${Object.values(row)
        .map((value) => cell(value))
        .join(' | ')}`,
  );
}

function markdownOf(
  input: BundleInput,
  approval: Approval,
  bundle: {
    readonly crashPoints: readonly Record<string, unknown>[];
    readonly openItems: readonly Record<string, string>[];
    readonly textArrayProof: string;
  },
  shown: Record<string, unknown>,
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
    `Decision ${approval.decisionId} (${approval.decision}) on task ${approval.taskId}. The action as the database holds it has sha256 ${digestOf(approval.action)}; its identifiers, decision and chain, with every other field withheld by digest:`,
    '',
    '```json',
    JSON.stringify(shown['action'], null, 2),
    '```',
    '',
    '## Behaviour tested',
    ...table(input.cases.map((line) => ({ ...line }))),
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
