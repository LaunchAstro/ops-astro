// SPDX-License-Identifier: AGPL-3.0-only
//
// One segment of an address, decoded as the person's browser sent it. A lone
// or cut-off percent escape, or one that is not UTF-8, names nothing: it is
// answered as no value rather than thrown while the application draws.

/** One address segment decoded, or null for a broken escape. */
export function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
