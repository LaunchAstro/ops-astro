// SPDX-License-Identifier: AGPL-3.0-only
//
// The signed-in person in the app strip, and the strip's history pair. The
// person menu is slice SL10's; until it lands, the person's address and the
// way out sit where the mockup draws the people on the page (UI-POLISH B1).

import type { ReactElement } from 'react';
import type { Session } from './session/token.ts';

export function SignedInAs(props: {
  readonly session: Session;
  readonly onSignOut: () => void;
}): ReactElement {
  return (
    <span className="appbar__who">
      <span className="appbar__whoname">
        {props.session.email} · {props.session.businessKey}
      </span>
      <button
        className="appbar__signout"
        type="button"
        title={`Signed in as ${props.session.email}`}
        onClick={props.onSignOut}
      >
        Sign out
      </button>
    </span>
  );
}

/** A step back through this tab's pages; the entry's `popstate` listener draws it. */
export function stepBack(): void {
  window.history.back();
}

/** A step forward through this tab's pages. */
export function stepForward(): void {
  window.history.forward();
}
