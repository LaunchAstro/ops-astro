// SPDX-License-Identifier: AGPL-3.0-only
//
// The captures' comparison (Receipt L fields 9 to 12): each pair is one
// address served successfully both times, the phrase moved on the live page,
// the rest of the page did not, the served stylesheets are equal and the
// decoy occurrence elsewhere on the site, on another page, is untouched.

import { wordOffsets, type CorrectionTarget } from './envelope.ts';

/**
 * Capture text past this, or a phrase longer than the envelope's 200 characters, is not
 * compared: the phrase search costs the text's length times the phrase's.
 */
const MOST_TEXT = 256 * 1024;
/** The fence's document cap: a document past it was never captured. */
const MOST_DOCUMENT = 2 * 1024 * 1024;
const MOST_WORD = 200;

/** What one fenced capture of a page observed. */
export interface PageObservation {
  readonly url: string;
  readonly status: number;
  readonly documentDigest: string;
  /** The page's visible text, whitespace collapsed. */
  readonly text: string;
  /** The served document: a component can render the word as more than text (#782). */
  readonly html: string;
  /** Every stylesheet the page loads, by address, with its digest. */
  readonly stylesheets: Readonly<Record<string, string>>;
}

export interface CaptureComparison {
  readonly before: PageObservation;
  readonly after: PageObservation;
  readonly decoyBefore: PageObservation;
  readonly decoyAfter: PageObservation;
  readonly target: CorrectionTarget;
}

export interface NothingElseMoved {
  readonly wordChanged: true;
  readonly restOfPageUnchanged: true;
  readonly stylesheetsUnchanged: true;
  readonly decoyUnchanged: true;
}

export type ComparisonResult =
  | { readonly ok: true; readonly value: NothingElseMoved }
  | {
      readonly ok: false;
      readonly code: 'NOTHING_ELSE_MOVED_FAILED';
      readonly fields: readonly ('word' | 'page' | 'stylesheets' | 'decoy')[];
    };

/** How many characters `left` and `right` share from the start, or from the end. */
function shared(left: string, right: string, fromEnd: boolean): number {
  const most = Math.min(left.length, right.length);
  let count = 0;
  const at = (text: string) => (fromEnd ? text.length - 1 - count : count);
  while (count < most && left[at(left)] === right[at(right)]) count += 1;
  return count;
}

/**
 * The one standalone occurrence of `word` in `before` whose replacement gives
 * `after`. Linear: an occurrence qualifies only if the text before it is
 * shared from the start and the text after it is shared from the end.
 */
function replacedAt(before: string, after: string, target: CorrectionTarget): number | undefined {
  const { word, replacement } = target;
  if (after.length !== before.length - word.length + replacement.length) return undefined;
  const head = shared(before, after, false);
  const tail = shared(before, after, true);
  const matches = wordOffsets(before, word).filter(
    (at) =>
      at <= head && before.length - at - word.length <= tail && after.startsWith(replacement, at),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** The run of `after` that differs from `before`: where it starts, what went and what came. */
export interface TextChange {
  readonly at: number;
  readonly removed: string;
  readonly added: string;
}

/** The one changed run between two texts, by what they share at each end; null when equal. */
export function changedText(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const head = shared(before, after, false);
  const tail = Math.min(shared(before, after, true), before.length - head, after.length - head);
  return {
    at: head,
    removed: before.slice(head, before.length - tail),
    added: after.slice(head, after.length - tail),
  };
}

/** A stylesheet whose digest changed, or that came (no before) or went (no after). */
export interface StylesheetChange {
  readonly address: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** Every stylesheet address whose digest differs between the two, in address order. */
export function changedStylesheets(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): readonly StylesheetChange[] {
  const addresses = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
  return addresses
    .map((address) => ({
      address,
      before: Object.hasOwn(before, address) ? (before[address] ?? null) : null,
      after: Object.hasOwn(after, address) ? (after[address] ?? null) : null,
    }))
    .filter((change) => change.before !== change.after);
}

const sameStylesheets = (left: PageObservation, right: PageObservation): boolean =>
  changedStylesheets(left.stylesheets, right.stylesheets).length === 0;

const served = (page: PageObservation): boolean => page.status >= 200 && page.status < 300;

/** A page's path, trailing slashes aside (a loop: a pattern is quadratic on a run of them). */
function pagePath(url: URL): string {
  const path = url.pathname;
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/** `decoy` is on `primary`'s https site, at another path, however either is spelled. */
function anotherPageOfSite(decoy: string, primary: string): boolean {
  const left = URL.parse(decoy);
  const right = URL.parse(primary);
  // Every non-web address has the origin "null", so only https names a site.
  if (left?.protocol !== 'https:' || right?.protocol !== 'https:') return false;
  return left.origin === right.origin && pagePath(left) !== pagePath(right);
}

/** Both captures are of one address, and each was served successfully. */
function samePage(left: PageObservation, right: PageObservation): boolean {
  return left.url === right.url && served(left) && served(right);
}

export function compareCaptures(input: CaptureComparison): ComparisonResult {
  const { before, after, decoyBefore, decoyAfter, target } = input;
  const failed: ('word' | 'page' | 'stylesheets' | 'decoy')[] = [];
  if (after.text === before.text) failed.push('word');
  const sized = (page: PageObservation): boolean =>
    page.text.length <= MOST_TEXT &&
    page.html.length <= MOST_DOCUMENT &&
    target.word.length <= MOST_WORD &&
    target.replacement.length <= MOST_WORD;
  const comparable = sized(before) && sized(after);
  const moved =
    after.text !== before.text &&
    (!comparable ||
      replacedAt(before.text, after.text, target) === undefined ||
      replacedAt(before.html, after.html, target) === undefined);
  if (moved || !samePage(before, after)) failed.push('page');
  if (!sameStylesheets(before, after)) failed.push('stylesheets');
  const decoyHeld =
    sized(decoyBefore) &&
    anotherPageOfSite(decoyBefore.url, before.url) &&
    ![before.documentDigest, after.documentDigest].includes(decoyBefore.documentDigest) &&
    samePage(decoyBefore, decoyAfter) &&
    wordOffsets(decoyBefore.text, target.word).length > 0 &&
    decoyAfter.text === decoyBefore.text &&
    decoyAfter.documentDigest === decoyBefore.documentDigest &&
    sameStylesheets(decoyBefore, decoyAfter);
  if (!decoyHeld) failed.push('decoy');
  if (failed.length > 0) return { ok: false, code: 'NOTHING_ELSE_MOVED_FAILED', fields: failed };
  return {
    ok: true,
    value: {
      wordChanged: true,
      restOfPageUnchanged: true,
      stylesheetsUnchanged: true,
      decoyUnchanged: true,
    },
  };
}
