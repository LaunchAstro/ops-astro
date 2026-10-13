// SPDX-License-Identifier: AGPL-3.0-only
//
// A sign-in service's own link (invite, recovery, magic link, sign-up, address
// change) lands with its tokens in the address's fragment. The app never reads
// them: invitations and resets are the product's own links (C39-T, C40), and a
// link's session sets a password and signs nobody into content. So such a
// fragment leaves the address before anything reads it: before the first draw,
// after Back, Forward or a fragment-only move, and from an address the app is
// about to push or replace, which fires neither `popstate` nor `hashchange`.
// A fragment carrying no sign-in token (a legacy address's tab) stays.

const LINK_TYPES: ReadonlySet<string> = new Set([
  'invite',
  'recovery',
  'magiclink',
  'signup',
  'email_change',
]);

/** Whether a fragment, `#` and all, holds a sign-in service's tokens. */
function isSignInLink(fragment: string): boolean {
  const fields = new URLSearchParams(fragment.replace(/^#/u, ''));
  return (
    fields.has('access_token') ||
    fields.has('refresh_token') ||
    LINK_TYPES.has(fields.get('type') ?? '')
  );
}

/** The address with a sign-in service's fragment taken off; any other address as it is. */
export function withoutSignInLink(address: string): string {
  const at = address.indexOf('#');
  if (at === -1 || !isSignInLink(address.slice(at))) return address;
  return address.slice(0, at);
}

/** Take a sign-in service's fragment off the tab's address and its history entry. */
export function dropSignInLink(tab: Pick<Window, 'location' | 'history'>): void {
  if (!isSignInLink(tab.location.hash)) return;
  const { pathname, search } = tab.location;
  tab.history.replaceState(tab.history.state, '', `${pathname}${search}`);
}
