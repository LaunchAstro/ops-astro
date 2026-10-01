// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: the receipt link, captured from the provider's answer when the effect
// is observed (publish time), and kept only when it is plainly a page on the
// operation's declared host. Anything else is recorded as absent and never
// rendered as a link. A link resolved later is not a receipt.
//
// Kept: `https:`, the declared host exactly, no user, password or port, no
// query or fragment (where tokens ride), at most `RECEIPT_LINK_MAX` characters,
// and the parsed form byte for byte the bytes sent. The last rule refuses what
// the URL parser would quietly repair: tabs and newlines it strips, backslashes
// it turns, case it folds, and dot segments it resolves.

/** The host each effect operation's receipt link may name, by step kind. */
export const EFFECT_RECEIPT_HOSTS: Readonly<Record<string, string>> = {
  synthetic_comment: 'receipts.stand-in.invalid',
};

export const RECEIPT_LINK_MAX = 512;

/** The link to keep, or `null`: absent, malformed or off the step's declared host. */
export function receiptLinkOf(raw: unknown, stepKind: string): string | null {
  const host = Object.hasOwn(EFFECT_RECEIPT_HOSTS, stepKind)
    ? EFFECT_RECEIPT_HOSTS[stepKind]
    : undefined;
  if (host === undefined || typeof raw !== 'string' || raw.length > RECEIPT_LINK_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const plain =
    url.protocol === 'https:' &&
    url.hostname === host &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.href === raw;
  return plain ? raw : null;
}
