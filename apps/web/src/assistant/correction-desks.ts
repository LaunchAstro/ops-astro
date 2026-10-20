// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the sidebar's two correction desks. One holds the corrections
// waiting on a person's decision; the other holds the rest, decided or
// carried on from a decision. The desks are drawn from the hook's list, which
// is the active business's alone (`use-corrections.ts`). A correction still
// being found waits on the first desk with those waiting for a decision.

import type { CorrectionReceiptView } from '../../../../packages/core-wire/src/index.ts';
import type { CardState, CorrectionAsk } from './correction.ts';

/** One correction as the sidebar holds it: what was asked, and its decision as last read. */
export interface Correction {
  readonly correctionId: string;
  readonly ask: CorrectionAsk;
  readonly state: CardState;
  /** The person who decided it, by name, or null until then. */
  readonly approver: string | null;
  /** The version a decision names; null until a read names one. */
  readonly versionId: string | null;
  /** How long the version's check holds from when the read was sent, in ms; 0 for none. */
  readonly verifiedForMs: number;
  /** `performance.now()` when the read now shown was sent, or null before one has answered. */
  readonly readAt: number | null;
  /** The refusal code the last read names (why it is unlocated or superseded), or null. */
  readonly reason: string | null;
  /** The last read's or decision's refusal, in the server's words. */
  readonly refusal: string | null;
  /**
   * The version whose Launch the server refused for a missing Astra review, or
   * null, set whatever the read after the refusal answers, a failure included.
   * Launch stays held while the card shows that version: no read says the
   * review was recorded since, so only a new version or a fresh drawer drops it.
   */
  readonly reviewMissingFor: string | null;
  /** Its receipts, newest first, once a person opened them; null until then. */
  readonly receipts: readonly CorrectionReceiptView[] | null;
}

export interface Desk {
  readonly key: 'waiting' | 'settled';
  readonly title: string;
  readonly corrections: readonly Correction[];
}

/** Still open: waiting for a decision, or its page still being found. */
const open = (each: Correction): boolean => each.state === 'requested' || each.state === 'locating';

/** The two desks, each drawn only when it holds a correction. */
export function desksOf(corrections: readonly Correction[]): readonly Desk[] {
  const waiting = corrections.filter((each) => open(each));
  const settled = corrections.filter((each) => !open(each));
  const desks: readonly Desk[] = [
    { key: 'waiting', title: 'Waiting for a decision', corrections: waiting },
    { key: 'settled', title: 'Decided', corrections: settled },
  ];
  return desks.filter((desk) => desk.corrections.length > 0);
}
