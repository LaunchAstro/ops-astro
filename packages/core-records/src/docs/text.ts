// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs store's text shapes (#2493 piece 1): a folder name, a page title and a Markdown body as
// 20261115002300 keeps them. Moved out of `store.ts` unchanged, for its line cap.

/** The longest folder name and page title 20261115002300 keeps, and the longest body. */
export const DOCS_NAME_LIMIT = 120;
export const DOCS_TITLE_LIMIT = 200;
export const DOCS_BODY_LIMIT = 200_000;

// oxlint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/u;
// A split character (an unpaired surrogate; with `u` a paired one is one code point and does not
// match), which the text writer would store as U+FFFD, text nobody sent (`storableText`'s rule).
const SPLIT = /[\uD800-\uDFFF]/u;

function lineOf(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.trim();
  if (line.length === 0 || line.length > limit || CONTROL.test(line)) return undefined;
  if (SPLIT.test(line)) return undefined;
  return line;
}

/** A folder name a person meant: trimmed, 1 to 120 characters, no control or split character. */
export const docsNameOf = (value: unknown): string | undefined => lineOf(value, DOCS_NAME_LIMIT);
/** A page title: trimmed, 1 to 200 characters, no control or split character. */
export const docsTitleOf = (value: unknown): string | undefined => lineOf(value, DOCS_TITLE_LIMIT);

/** A Markdown body as sent: up to 200,000 characters, no NUL (Postgres keeps none), no split character. */
export function docsBodyOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > DOCS_BODY_LIMIT || value.includes('\u0000')) {
    return undefined;
  }
  if (SPLIT.test(value)) return undefined;
  return value;
}
