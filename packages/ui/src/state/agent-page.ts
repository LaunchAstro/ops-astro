// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent page's readings of one lineage (MP-6-2, mockup TA-01, TA-05,
// TA-06): the run hero's figures, the artefacts with their supersedes chain,
// and the activity log. Each is drawn from stored facts `task.read` carries;
// a figure the read does not carry is left out, never shown as zero.

import type { RunStory } from './agent-run.ts';
import { stagedOf, type Staged } from './agent-staged.ts';
import type { RunCheck, RunLineage, RunVersion } from './run-projection.ts';

export interface HeroCell {
  readonly key: 'jobs' | 'checks' | 'time';
  readonly figure: string;
  readonly label: string;
}

const MINUTE = 60_000;

/** "1h 18m", "45m": whole minutes, rounded down. */
export function span(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / MINUTE));
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${String(minutes)}m` : `${String(hours)}h ${String(minutes % 60)}m`;
}

const time = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Date.parse(value);

/** When the lineage's first run started: its earliest lease. Null before any run. */
function runStart(versions: readonly RunVersion[]): number | null {
  const starts = versions.flatMap((one) => {
    const at = time(one.runStartedAt);
    return at === null ? [] : [at];
  });
  return starts.length === 0 ? null : Math.min(...starts);
}

/**
 * The time cell: from the run's start to the latest gate raised after it (the
 * gate the run reached), or elapsed while none has been. A gate raised before
 * the run started is the approval to start it, not the run's gate.
 */
function timeCell(versions: readonly RunVersion[], now: number): HeroCell | null {
  const start = runStart(versions);
  if (start === null) return null;
  const reached = versions.flatMap((one) => {
    const at = time(one.gate?.raisedAt);
    return at !== null && at >= start ? [at] : [];
  });
  return reached.length === 0
    ? { key: 'time', figure: span(now - start), label: 'elapsed' }
    : { key: 'time', figure: span(Math.max(...reached) - start), label: 'to the gate' };
}

/**
 * The hero's stats (TA-01). The tokens cell is left out: no run's spend is
 * read here yet, and an absent figure is not a zero.
 */
export function heroCells(
  story: RunStory,
  lineage: RunLineage | undefined,
  now: number,
): readonly HeroCell[] {
  const complete = story.jobs.filter((job) => job.state === 'done' || job.state === 'approved');
  const cells: HeroCell[] = [
    {
      key: 'jobs',
      figure: `${String(complete.length)} / ${String(story.jobs.length)}`,
      label: 'jobs complete',
    },
    { key: 'checks', figure: String(story.checks.length), label: 'checks recorded' },
  ];
  const timed = timeCell(lineage?.versions ?? [], now);
  return timed === null ? cells : [...cells, timed];
}

export interface ArtefactVersion {
  readonly version: number;
  readonly digest: string;
  readonly current: boolean;
  /** The version of this artefact it replaced; null for the first. */
  readonly supersedes: number | null;
  readonly passed: number;
  readonly recorded: number;
}

export interface Artefact {
  readonly kind: Staged['kind'];
  readonly title: string;
  /** Newest first. */
  readonly versions: readonly ArtefactVersion[];
}

function titleOf(staged: Staged): string {
  switch (staged.kind) {
    case 'pr':
      return staged.title;
    case 'diff':
      return staged.where;
    case 'ad':
      return staged.account;
    case 'preview':
      return staged.url;
  }
}

const passedOf = (checks: readonly RunCheck[]): number =>
  checks.filter((check) => check.outcome === 'passed').length;

/**
 * The artefacts the lineage's versions staged (TA-05), one per kind and title,
 * each version naming the one it superseded. "Checks passed" counts two sets:
 * the checks that passed, out of every check recorded on that version (D-18).
 */
export function artefactsOf(lineage: RunLineage | undefined): readonly Artefact[] {
  const found = new Map<
    string,
    { kind: Staged['kind']; title: string; versions: ArtefactVersion[] }
  >();
  for (const one of (lineage?.versions ?? []).toReversed()) {
    const staged = stagedOf(one);
    if (staged === null) continue;
    const title = titleOf(staged);
    const key = `${staged.kind}\u0000${title}`;
    const artefact = found.get(key) ?? { kind: staged.kind, title, versions: [] };
    artefact.versions.unshift({
      version: one.version,
      digest: one.evidence?.digest ?? '',
      current: one.supersededAt === null,
      supersedes: artefact.versions[0]?.version ?? null,
      passed: passedOf(one.checks),
      recorded: one.checks.length,
    });
    found.set(key, artefact);
  }
  return [...found.values()];
}

export interface ActivityRow {
  readonly key: string;
  readonly at: string;
  readonly title: string;
  readonly state: string;
  readonly note: string | null;
}

/** Same-instant records keep the order the run makes them in. */
const ORDER = { gate: 0, decision: 1, run: 2, check: 3 } as const;

function versionRows(one: RunVersion): readonly (ActivityRow & { rank: number })[] {
  const version = `v${String(one.version)}`;
  const rows: (ActivityRow & { rank: number })[] = [];
  if (one.gate?.raisedAt !== undefined) {
    rows.push({
      key: `gate-${one.gate.id}`,
      at: one.gate.raisedAt,
      title: `Gate raised on ${version}`,
      state: one.gate.state,
      note: null,
      rank: ORDER.gate,
    });
  }
  if (one.runStartedAt !== null && one.runStartedAt !== undefined) {
    rows.push({
      key: `run-${one.versionId}`,
      at: one.runStartedAt,
      title: `Run started on ${version}`,
      state: 'started',
      note: null,
      rank: ORDER.run,
    });
  }
  for (const check of one.checks) {
    rows.push({
      key: `check-${check.id}`,
      at: check.recordedAt,
      title: check.name,
      state: check.outcome,
      note: check.note,
      rank: ORDER.check,
    });
  }
  return rows;
}

/**
 * The run's stored records, oldest first (TA-06): gates raised, decisions,
 * runs started and checks. Each comes from an append-only record, so a later
 * record adds a row and never changes one drawn before it. Null when no run
 * has started on the lineage.
 */
export function activityOf(
  lineage: RunLineage | undefined,
  nameOf: (personId: string) => string,
): readonly ActivityRow[] | null {
  const versions = lineage?.versions ?? [];
  if (!versions.some((one) => one.runId !== null || runStart([one]) !== null)) return null;
  const decisions = (lineage?.decisions ?? []).map((decision, index) => ({
    key: `decision-${String(index)}`,
    at: decision.decidedAt,
    title: `Gate decided by ${nameOf(decision.decidedByPersonId)}`,
    state: decision.decision,
    note: null,
    rank: ORDER.decision,
  }));
  return [...versions.toReversed().flatMap((one) => versionRows(one)), ...decisions]
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.rank - b.rank)
    .map(({ rank: _rank, ...row }) => row);
}
