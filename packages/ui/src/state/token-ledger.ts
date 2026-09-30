// SPDX-License-Identifier: AGPL-3.0-only
//
// The token panel's reading of a task's ledger (MP-6-5, DA-08, DA-09,
// DS-TASK-9): `task.read`'s ledger and proposals, shaped as the read returns
// them.

import type { RunLineage, RunVersion } from './run-projection.ts';

/** One envelope on the task, as `task.read`'s ledger carries it. */
export interface LedgerEnvelope {
  readonly id: string;
  readonly state: string;
  /** The allowance. */
  readonly maximumMinor: number;
  readonly heldMinor: number;
  /** Spent. */
  readonly actualMinor: number;
  readonly currency: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** The approval whose reservation opened it. */
  readonly openedBy: { readonly versionId: string } | null;
  /** The cap it draws on. */
  readonly cap: { readonly key: string; readonly limitMinor: number; readonly currency: string };
}

/** One stop at a run's approved ceiling (AW-05), as `task.read`'s ledger carries it. */
export interface LedgerStop {
  readonly askId: string;
  readonly runId: string;
  /** 1 to `STOP_LIMIT`. */
  readonly number: number;
  /** `consolidated` on the last. */
  readonly kind: string;
  readonly ceilingMinor: number;
  readonly spentMinor: number;
  readonly currency: string;
  readonly raisedAt: string;
  /** `top_up`, `end`, or null while the ask waits. */
  readonly answer: string | null;
  readonly awaitingSecond: { readonly amountMinor: number } | null;
}

/** The task's ledger: the open envelope first, then the closed ones, newest first, and the runs' stops. */
export interface TaskLedger {
  readonly envelopes: readonly LedgerEnvelope[];
  /** Absent on a read from before AW-05's stops. */
  readonly stops?: readonly LedgerStop[];
}

/** A run asks three times at most; the last is the one consolidated decision (AW-05). */
export const STOP_LIMIT = 3;

/** The latest ask on each run that has stopped, in the order the read gives the runs. */
export function latestStops(ledger: TaskLedger | null): readonly LedgerStop[] {
  const latest = new Map<string, LedgerStop>();
  for (const stop of ledger?.stops ?? []) {
    const seen = latest.get(stop.runId);
    if (seen === undefined || stop.number > seen.number) latest.set(stop.runId, stop);
  }
  return [...latest.values()];
}

/** A skill a run's version names in its evidence: a door to the Docs panel. */
export interface LedgerSkill {
  readonly name: string;
}

/** Where the run's material came from, as its evidence names it. */
export interface LedgerSource {
  readonly label: string;
  readonly href: string;
}

/** One reservation on the envelope: a per-run row. */
export interface TokenRun {
  readonly reservationId: string;
  readonly runId: string;
  readonly state: string;
  readonly heldMinor: number;
  readonly actualMinor: number | null;
  readonly classifiedCause: string | null;
  readonly skills: readonly LedgerSkill[];
}

export type TokenStory =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'tracked';
      readonly envelope: LedgerEnvelope;
      /** The opening approval's version number, or null when the read does not carry it. */
      readonly openedByVersion: number | null;
      /** How far spent is past the allowance; 0 when it is not. */
      readonly overMinor: number;
      /** Spent as a share of the allowance, 0 to 100. */
      readonly percent: number;
      readonly skills: readonly LedgerSkill[];
      readonly dataSource: LedgerSource | null;
      readonly runs: readonly TokenRun[];
    };

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The skills a version's evidence names, each a string or `{ name }`, read as
 * text. Anything else is left out, never guessed at.
 */
function skillsOf(version: RunVersion | undefined): readonly LedgerSkill[] {
  const listed = record(version?.evidence?.body)?.['skills'];
  return (Array.isArray(listed) ? listed : []).flatMap((entry: unknown) => {
    const name = typeof entry === 'string' ? entry : record(entry)?.['name'];
    return typeof name === 'string' && name.trim() !== '' ? [{ name }] : [];
  });
}

/** The data source a version's evidence names, as it is: the link is guarded where it is drawn. */
function sourceOf(version: RunVersion | undefined): LedgerSource | null {
  const source = record(record(version?.evidence?.body)?.['dataSource']);
  const label = source?.['label'];
  const href = source?.['href'];
  return typeof label === 'string' && label.trim() !== ''
    ? { label, href: typeof href === 'string' ? href : '' }
    : null;
}

/**
 * The panel's one reading of the ledger: the current envelope (the open one,
 * else the newest closed, which is the read's order), what opened it, and the
 * reservations that name it as its per-run rows. Every figure is the
 * envelope's own or a reservation's own; the panel adds nothing up itself, so
 * it cannot disagree with the ledger it draws.
 */
export function tokenStory(ledger: TaskLedger, lineages: readonly RunLineage[]): TokenStory {
  const [envelope] = ledger.envelopes;
  if (envelope === undefined) return { kind: 'none' };
  const versions = lineages.flatMap((each) => each.versions);
  const opening = versions.find((version) => version.versionId === envelope.openedBy?.versionId);
  const runs = lineages.flatMap((each) =>
    each.reservations.flatMap((reservation): TokenRun[] =>
      reservation.envelopeId === envelope.id &&
      reservation.id !== undefined &&
      reservation.runId !== undefined
        ? [
            {
              reservationId: reservation.id,
              runId: reservation.runId,
              state: reservation.state,
              heldMinor: reservation.heldMinor,
              actualMinor: reservation.actualMinor,
              classifiedCause: reservation.classifiedCause,
              skills: skillsOf(versions.find((version) => version.runId === reservation.runId)),
            },
          ]
        : [],
    ),
  );
  const overMinor = Math.max(0, envelope.actualMinor - envelope.maximumMinor);
  const percent =
    envelope.maximumMinor > 0
      ? Math.min(100, Math.round((envelope.actualMinor / envelope.maximumMinor) * 100))
      : 100;
  return {
    kind: 'tracked',
    envelope,
    openedByVersion: opening?.version ?? null,
    overMinor,
    percent,
    skills: skillsOf(opening),
    dataSource: sourceOf(opening),
    runs,
  };
}
