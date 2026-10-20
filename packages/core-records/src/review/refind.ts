// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X's refind (#2075): a pin's anchor found again on a new revision, or lost. It is found
// only when the page at its width is the same document as where it was found (every selector
// carries as it was), or when its quote with its context occurs exactly once in the new page's
// text (the quote carries, and no coordinate). Anything else is an anchor lost: no anchor,
// nothing guessed, no model call.

import type { Anchor, Selector } from './pins.ts';

export type Observation = Readonly<Record<string, unknown>>;

const sheetsOf = (sheets: object): string => JSON.stringify(Object.entries(sheets).toSorted());

const sameSheets = (from: unknown, to: unknown): boolean =>
  typeof from === 'object' &&
  from !== null &&
  typeof to === 'object' &&
  to !== null &&
  sheetsOf(from) === sheetsOf(to);

/** The same document with the same stylesheets: every spot on it is where it was. */
const sameDocument = (from: Observation, to: Observation): boolean =>
  typeof from['documentDigest'] === 'string' &&
  from['documentDigest'] === to['documentDigest'] &&
  sameSheets(from['stylesheets'], to['stylesheets']);

/** How often the quote, with its context, occurs in `text`, overlaps counted. */
function occurrences(text: string, quote: Extract<Selector, { type: 'TextQuoteSelector' }>) {
  const whole = `${quote.prefix ?? ''}${quote.exact}${quote.suffix ?? ''}`;
  let count = 0;
  for (let at = text.indexOf(whole); at !== -1; at = text.indexOf(whole, at + 1)) count += 1;
  return count;
}

/**
 * `anchor` found again on the revision `toRevisionId`, from the page it was found on to the
 * new page at the same width; null when it is lost.
 */
export function refind(
  anchor: Anchor,
  pages: { readonly from: Observation | undefined; readonly to: Observation | undefined },
  toRevisionId: string,
): Anchor | null {
  const { from, to } = pages;
  if (to === undefined) return null;
  const at = { source: toRevisionId, width: anchor.width };
  if (from !== undefined && sameDocument(from, to)) return { ...at, selector: anchor.selector };
  const quote = anchor.selector.find((one) => one.type === 'TextQuoteSelector');
  const text = to['text'];
  if (quote === undefined || typeof text !== 'string' || occurrences(text, quote) !== 1) {
    return null;
  }
  return { ...at, selector: [quote] };
}
