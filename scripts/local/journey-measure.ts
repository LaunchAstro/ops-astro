// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d: the measures the journey command carries to its bundle. The run hands
// one `journey-measure` line on its stdout; everything else is set by the
// command itself. That line is another process's output, so it is never
// merged in: only the run's own measure is copied, as a finite number, into a
// record with no prototype, and every other key (`__proto__`, `constructor`,
// `prototype`, or a measure the command sets itself) is dropped (#180, semgrep
// insecure-object-assign).

/** What the command carries to `commandBudgets`. */
export interface Measures {
  seedMs?: number;
  migrateMs?: number;
  journeyRan?: boolean;
}

/** The only measure the run itself may hand the command. */
const FROM_RUN = ['seedMs'] as const;

export function emptyMeasures(): Measures {
  return Object.create(null) as Measures;
}

/** One `journey-measure` line's JSON: its allowed own keys taken into `measures`, the rest dropped. */
export function takeMeasure(measures: Measures, value: string): void {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  for (const key of FROM_RUN) {
    const measured: unknown = Object.hasOwn(parsed, key)
      ? (parsed as Record<string, unknown>)[key]
      : undefined;
    if (typeof measured === 'number' && Number.isFinite(measured)) measures[key] = measured;
  }
}
