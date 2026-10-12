// SPDX-License-Identifier: AGPL-3.0-only
//
// A sign-in service's own invite or recovery link lands with its tokens in the address's
// fragment. The app opens no session with them: invitations and resets are the product's own
// links (C39-T, C40), and a link that signed a person in would let a login with an
// authenticator app reset by mail alone. So the fragment is cleared from the address bar, and
// from the tab's history entry, before the first draw, and the page is the one it would be
// without it. A fragment carrying no sign-in token (a legacy address's tab) stays.

const LINK_TYPES: ReadonlySet<string> = new Set(['invite', 'recovery']);

export function dropSignInLink(tab: Pick<Window, 'location' | 'history'>): void {
  const fragment = new URLSearchParams(tab.location.hash.slice(1));
  const linked =
    fragment.has('access_token') ||
    fragment.has('refresh_token') ||
    LINK_TYPES.has(fragment.get('type') ?? '');
  if (!linked) return;
  const { pathname, search } = tab.location;
  tab.history.replaceState(tab.history.state, '', `${pathname}${search}`);
}
