// SPDX-License-Identifier: AGPL-3.0-only
//
// The captures' comparison (Receipt L fields 9 to 12): each pair is one
// address served successfully both times, the word moved on the live page,
// the rest of the page did not, the served stylesheets are equal and the
// decoy occurrence elsewhere on the site, on another page, is untouched.

import { replacedAt, wordOffsets, type CorrectionTarget } from './envelope.ts';

/**
 * Capture text past this, or a word longer than this, is not compared: the
 * comparison is quadratic in the text and grows with the word.
 */
const MOST_TEXT = 256 * 1024;
const MOST_WORD = 64;

/** What one fenced capture of a page observed. */
export interface PageObservation {
  readonly url: string;
  readonly status: number;
  readonly documentDigest: string;
  /** The page's visible text, whitespace collapsed. */
  readonly text: string;
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

function sameStylesheets(left: PageObservation, right: PageObservation): boolean {
  const keys = Object.keys(left.stylesheets).toSorted();
  const other = Object.keys(right.stylesheets).toSorted();
  return (
    keys.length === other.length &&
    keys.every(
      (key, index) => key === other[index] && left.stylesheets[key] === right.stylesheets[key],
    )
  );
}

const served = (page: PageObservation): boolean => page.status >= 200 && page.status < 300;

/** A page's path, a trailing slash aside. */
const pagePath = (url: URL): string => url.pathname.replace(/\/+$/u, '');

/** `decoy` is on `primary`'s https site, at another path, however either is spelled. */
function anotherPageOfSite(decoy: string, primary: string): boolean {
  const left = URL.parse(decoy);
  const right = URL.parse(primary);
  // Every non-web address has the origin "null", so only https names a site.
  if (left === null || right === null || right.protocol !== 'https:') return false;
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
    target.word.length <= MOST_WORD &&
    target.replacement.length <= MOST_WORD;
  const comparable = sized(before) && sized(after);
  const moved =
    after.text !== before.text &&
    (!comparable || replacedAt(before.text, after.text, target) === undefined);
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
