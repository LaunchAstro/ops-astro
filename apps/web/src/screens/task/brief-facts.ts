// SPDX-License-Identifier: AGPL-3.0-only
//
// What was asked for, read from the agent brief's own headings (MP-4-7,
// TA-11). A typed stub until the rule lands: it reads nothing.

export type BriefFactKey = 'Objective' | 'Definition of done' | 'Constraints' | 'Escalation';

export interface BriefFact {
  readonly key: BriefFactKey;
  readonly value: string;
}

export function briefFacts(_brief: string | null): readonly BriefFact[] {
  return [];
}
