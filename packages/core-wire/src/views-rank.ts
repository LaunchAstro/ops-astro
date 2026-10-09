// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A task's derived rank as its reader is shown it (R70, MP-4-9).
 *
 * `number` is the task's place among the open tasks this reader may read, or
 * null when the task is not ranked; `score` is null exactly then. `calc` is the
 * line drawn under the rank, worked out on the server so every surface shows the
 * same words, and it names nothing but this task's own marks and modifiers.
 */
export interface RankView {
  readonly number: number | null;
  readonly score: number | null;
  readonly calc: string;
}

/** The stored marks, never inferred from a calculation or defaulted to zero. */
export interface TaskScores {
  readonly impact: number | null;
  readonly confidence: number | null;
  readonly ease: number | null;
}

/** Only the internal person detail carries marks; older detail may omit them. */
export interface TaskScoreFacts {
  readonly scores?: TaskScores;
}
