// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's two correction desks. One holds the corrections
// waiting on a person's decision; the other holds the rest, decided or
// carried on from a decision. The desks are drawn from the hook's list, which
// is the active business's alone (`use-corrections.ts`).

import type { CardState, CorrectionAsk } from './correction.ts';

/** One correction as the sidebar holds it: what was asked, and its decision as last read. */
export interface Correction {
  readonly correctionId: string;
  readonly ask: CorrectionAsk;
  readonly state: CardState;
  /** The person who decided it, by name, or null until then. */
  readonly approver: string | null;
  /** The version a decision names; null until the first read answers. */
  readonly versionId: string | null;
  /** The last read's or decision's refusal, in the server's words. */
  readonly refusal: string | null;
}

export interface Desk {
  readonly key: 'waiting' | 'settled';
  readonly title: string;
  readonly corrections: readonly Correction[];
}

/** The two desks, each drawn only when it holds a correction. */
export function desksOf(corrections: readonly Correction[]): readonly Desk[] {
  const waiting = corrections.filter((each) => each.state === 'requested');
  const settled = corrections.filter((each) => each.state !== 'requested');
  const desks: readonly Desk[] = [
    { key: 'waiting', title: 'Waiting for a decision', corrections: waiting },
    { key: 'settled', title: 'Decided', corrections: settled },
  ];
  return desks.filter((desk) => desk.corrections.length > 0);
}
