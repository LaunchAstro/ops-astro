// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's pin anchor (#2012): a W3C Web Annotation target on one width's capture.

/** The tallest capture a spot may sit on. */
export const MOST_CAPTURE_HEIGHT = 16_384;

export type AnchorParse =
  | { readonly ok: true; readonly anchor: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly names: readonly string[] };

export function parseAnchor(_sent: Readonly<Record<string, unknown>>): AnchorParse {
  return { ok: false, names: [] };
}
