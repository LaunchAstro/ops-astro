// SPDX-License-Identifier: AGPL-3.0-only
//
// Which setting a press is about, and what a confirmed write leaves behind, split out of
// `use-settings.ts` when the main merge joined it past the 300-line limit.

import type { Confirmed } from './confirmed.ts';

/** Which setting a press is about: the two money and sign-off rows, and MP-2-11's two windows. */
export type Which = 'four-eyes' | 'sign-off' | 'conversation' | 'retention';

/** What a person can propose. `null` is the band off, and it is a real value. */
export type Draft = number | boolean | null;

/** A write the server would not take because somebody else wrote first. */
export interface Conflict {
  readonly which: Which;
  readonly draft: Draft;
  /** The server's refusal, verbatim, so the code can be quoted to somebody. */
  readonly because: string;
}

const isThreshold = (value: unknown): value is number | null =>
  value === null || typeof value === 'number';

/** The server's echo when it gave one of the right kind, else what was sent. */
export function remember(which: Which, echo: unknown, value: Draft): Confirmed {
  if (which === 'four-eyes') {
    const fourEyes = isThreshold(echo) ? echo : isThreshold(value) ? value : undefined;
    return fourEyes === undefined ? {} : { fourEyes };
  }
  // The windows keep no browser memory: only the server's read is drawn for them.
  if (which !== 'sign-off') return {};
  const signOff = typeof echo === 'boolean' ? echo : typeof value === 'boolean' ? value : undefined;
  return signOff === undefined ? {} : { signOff };
}
