// SPDX-License-Identifier: AGPL-3.0-only
//
// What the application draws inside the shell for an address: a screen,
// sign-in, a manifest page's placeholder or refusal, or not-found.

import type { ReactElement } from 'react';
import { gateOf, pathTo, type RouteMatch } from './routes.ts';
import { isLegacy } from './legacy.ts';
import type { PageMatch } from './manifest.ts';
import { ClientRefused, PagePlaceholder } from './route-views.tsx';
import { drawScreen, type ScreenContext } from './screen-registry.tsx';

export function drawContent(props: {
  readonly here: string;
  readonly match: RouteMatch | null;
  readonly at: PageMatch | null;
  readonly signedIn: boolean;
  /** The address names a client the session holds no grant on. */
  readonly refused: boolean;
  readonly signIn: ReactElement;
  /** Where "Go to Projects" goes for a person already signed in. */
  readonly onGo: () => void;
  readonly screen: Omit<ScreenContext, 'params'>;
}): ReactElement {
  const { match, at } = props;
  // A manifest page with no screen yet: sign-in first, then the grant check.
  if (match === null && at !== null) {
    if (!props.signedIn) return props.signIn;
    return props.refused ? <ClientRefused /> : <PagePlaceholder page={at.page} />;
  }
  const gate = gateOf(match, props.signedIn);
  switch (gate.kind) {
    case 'not-found':
      return <NotFound path={props.here} />;
    case 'sign-in':
      return props.signIn;
    case 'signed-in-already':
      return <SignedInAlready onGo={props.onGo} />;
    case 'screen':
      return drawScreen(gate.match, props.screen);
  }
}

// An unknown legacy address is not echoed: no legacy address reaches the interface (R5).
function NotFound(props: { readonly path: string }): ReactElement {
  return (
    <div className="readstate" data-outcome="not-found">
      <p className="empty__title">
        No screen is registered at {isLegacy(props.path) ? 'this address' : props.path}.
      </p>
      <p className="empty__desc">
        The route registry is the list the application resolves through. An address that is not in
        it does not resolve, which is a truer answer than a blank page.
      </p>
      <p className="empty__hint">
        <a className="sb__addr" href={pathTo('agency:projects-board')}>
          Go to Projects
        </a>
      </p>
    </div>
  );
}

function SignedInAlready(props: { readonly onGo: () => void }): ReactElement {
  return (
    <div className="readstate" data-outcome="ready">
      <p className="empty__title">You are already signed in.</p>
      <button className="btn btn--primary" type="button" onClick={props.onGo}>
        Go to Projects
      </button>
    </div>
  );
}
