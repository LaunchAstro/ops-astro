// SPDX-License-Identifier: AGPL-3.0-only
//
// The derived task rank (R70, MP-4-9). Not built yet: this file carries the
// shape the tests are written against, so they fail on their answers.

export type MarkName = 'impact' | 'confidence' | 'ease';

export interface RankInput {
  readonly id: string;
  readonly key: string;
  readonly position: number | null;
  readonly marks: { readonly [Name in MarkName]: number | null };
  readonly priorityStage: boolean;
  readonly open: boolean;
  readonly startedAt: Date | null;
}

export interface Scored {
  readonly score: number | null;
  readonly missing: readonly MarkName[];
  readonly marks: RankInput['marks'];
  readonly priorityWeight: string;
  readonly ageBoost: string;
  readonly weeks: number;
}

export function scoreTask(input: RankInput, _now: Date): Scored {
  return {
    score: null,
    missing: [],
    marks: input.marks,
    priorityWeight: '',
    ageBoost: '',
    weeks: 0,
  };
}

export function calcLine(_scored: Scored, _source?: { readonly inheritedFrom: string }): string {
  return '';
}

export function numberPool(
  inputs: readonly RankInput[],
  _now: Date,
): ReadonlyMap<string, number | null> {
  return new Map(inputs.map((input) => [input.id, null]));
}
