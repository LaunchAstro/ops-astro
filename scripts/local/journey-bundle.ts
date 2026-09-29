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
import { createHash } from 'node:crypto';
import { availableParallelism, loadavg } from 'node:os';

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

/** The budgets the command measures itself (10.2), and the seed time on its own line (RN-09). */
export function commandBudgets(
  migrateMs: number | undefined,
  totalMs: number,
  seedMs: number | undefined,
  loadAtStart?: number,
): Record<string, string>[] {
  const run = 'this run, its own container';
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
      ...seconds(totalMs, 900),
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

/**
 * The decision payload's fields the bundle may show: identifiers, the
 * decision and the chain. Anything else, the note first, is written by a
 * person and may be a client's words, so it is withheld and named by its
 * digest (Sol, review 1 on #164).
 */
const SHOWN = new Set([
  'id',
  'by',
  'actor',
  'gate',
  'lineage',
  'version',
  'decision',
  'round',
  'seq',
  'link',
  'key',
  'evidence',
  'prev',
]);

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The approval as the bundle carries it: the row's exact bytes by digest, and its shown fields. */
function approvalOf(approval: Approval): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(approval.action);
  } catch {
    payload = undefined;
  }
  const fields =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? Object.fromEntries(
          Object.entries(payload).map(([key, value]) =>
            SHOWN.has(key)
              ? [key, value]
              : [key, `withheld (sha256 ${sha256(JSON.stringify(value)).slice(0, 16)})`],
          ),
        )
      : 'withheld: the payload is not an object';
  const { taskId, decisionId, decision } = approval;
  return { taskId, decisionId, decision, actionSha256: sha256(approval.action), action: fields };
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
    approval: approvalOf(approval),
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
    `Decision ${approval.decisionId} (${approval.decision}) on task ${approval.taskId}. The action as the database holds it has sha256 ${sha256(approval.action)}; its identifiers, decision and chain, with every other field withheld by digest:`,
    '',
    '```json',
    JSON.stringify(approvalOf(approval)['action'], null, 2),
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
