// SPDX-License-Identifier: AGPL-3.0-only
//
// An answer's cites as the drawer draws them (`Cites` in the UI's transcript).
// The reply is untrusted text, so the parse is closed: a list of at most
// `MOST` objects holding exactly a `label` and an `href`, both bounded
// strings, or no cites at all. The transcript links an `href` only when it is
// the product's own address (`ownHref`); anything else is drawn as words.

import type { AssistantCite } from '@launchastro/ui';

const MOST = 20;
const LABEL_LIMIT = 200;
const HREF_LIMIT = 300;

const isCite = (value: unknown): value is AssistantCite => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const { label, href } = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    typeof label === 'string' &&
    typeof href === 'string' &&
    label !== '' &&
    label.length <= LABEL_LIMIT &&
    href.length <= HREF_LIMIT
  );
};

/** The reply's cites, or none when any part of them is out of shape. */
export function citesOf(value: unknown): readonly AssistantCite[] {
  if (!Array.isArray(value) || value.length > MOST) return [];
  const cites: AssistantCite[] = [];
  for (const each of value as readonly unknown[]) {
    if (!isCite(each)) return [];
    cites.push({ label: each.label, href: each.href });
  }
  return cites;
}
