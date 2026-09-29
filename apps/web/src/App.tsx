// SPDX-License-Identifier: AGPL-3.0-only
//
// The application: which address is open, who is signed in, and nothing else.
//
// **There is no demonstration state and no way to ask for one.** A `?state=`
// parameter selecting a seeded corpus is how a mockup demonstrates itself,
// not how a product reports.
// Every screen below reads through the real client, and a read that fails draws
// the failure. The corpus survives in `packages/ui` as the drawn *vocabulary*
// — the words and tones a state may print — and not as a source of rows.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { DockProps } from '@launchastro/ui';
import { Shell } from '@launchastro/ui';
import { gateOf, matchRoute, pathTo, type Gate } from './routes.ts';
import { NO_CLIENT_GRANTS, canonicalOf, isLegacy, pageAt, type ClientAccess } from './manifest.ts';
import { ClientRefused, PagePlaceholder, RouteTabs, railFor } from './route-views.tsx';
import { HeldAddressNotice, heldAddressOffer, type HeldOffer } from './held-address.tsx';
import { PANELS, dockTabs, isPanelId, type PanelId, type PanelRegistry } from './panels.ts';
import { closeAll, close, isOwnAddress, press, ranked, visit } from './dock/open-set.ts';
import { useDock } from './dock/use-dock.ts';
import { useDockLayout } from './dock/use-layout.ts';
import { OperationsClient, type WireRefusal } from './operations/client.ts';
import { grantKeyOf, type Interruption, type Session, type SessionStore } from './session/token.ts';
import { SignIn } from './screens/SignIn.tsx';
import { drawScreen, type ScreenContext } from './screen-registry.tsx';

export interface AppProps {
  /** The address the application is drawing. Owned here, not read from a global. */
  readonly path: string;
  readonly navigate: (path: string) => void;
  readonly sessions: SessionStore;
  /** Where the identity provider is. Injected so a test never needs a network. */
  readonly gotrueUrl: string;
  /** The API's origin: empty behind the dev proxy, which serves `/api` on the page's own. */
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  /** This tab's storage, read once by the entry, or null where it is blocked. */
  readonly storage: Storage | null;
  /** Which clients the session may open. None until MP-10-1 supplies client records. */
  readonly clientAccess?: ClientAccess;
  /** The dock's panels. The shipped registry unless a test hands another. */
  readonly panels?: PanelRegistry;
}

export function App(props: AppProps): ReactElement {
  const [session, setSession] = useState<Session | null>(props.sessions.session);
  const registry = props.panels ?? PANELS;
  const dock = useDock(session, props.storage, registry);
  const layout = useDockLayout(dock, registry);

  // The root address is not a screen and it is not a mistake either: it is how
  // a person arrives. It leads to the board when there is a session and to
  // sign-in when there is not, and the address bar is corrected to say so, so
  // a reload lands on the same place a link would.
  // A legacy address is answered with its canonical one the same way, so the
  // address bar, the rail and a remembered interruption never hold a legacy one.
  const here =
    canonicalOf(props.path) ??
    (props.path === '/'
      ? pathTo(session === null ? 'agency:sign-in' : 'agency:projects-board')
      : props.path);
  const navigate = props.navigate;
  useEffect(() => {
    if (here !== props.path) navigate(here);
  }, [here, props.path, navigate]);

  // Why the board was reached instead of the address that was held. Drawn on
  // the board and nowhere else, and gone when this session is. The offer is the
  // server's answer on whether to name the business the address belongs to.
  const [notice, setNotice] = useState<{
    readonly held: Interruption;
    readonly offer: HeldOffer | null;
  } | null>(null);

  const onSignedIn = useCallback(
    (next: Session) => {
      // Spent here, so the next ordinary sign-in is not redirected by an
      // interruption somebody already answered.
      const back = props.sessions.takeInterruption();
      props.sessions.set(next);
      setSession(next);
      setNotice(null);
      if (back === null) {
        props.navigate(pathTo('agency:projects-board'));
        return;
      }
      // **The held address only means anything in the business it was held
      // in.** A task key is business-local, so replaying the string under a
      // different business does not reopen the task the person was promised:
      // it refuses, or -- worse, because it looks like success -- it draws an
      // unrelated record that happens to share the key. A deliberate change of
      // business is not a mistake, so it is not refused; it goes to that
      // business's board and says why.
      if (back.businessKey === next.businessKey) {
        props.navigate(back.address);
        return;
      }
      setNotice({ held: back, offer: null });
      props.navigate(pathTo('agency:projects-board'));
      void heldAddressOffer({
        held: back,
        next,
        apiOrigin: props.apiOrigin,
        fetch: props.fetch,
      }).then((offer) => {
        // Only onto the notice it was asked for: a sign-out or a switch since
        // has replaced or cleared it.
        setNotice((current) => (current?.held === back ? { held: back, offer } : current));
        return offer;
      });
    },
    [props],
  );

  const onSignOut = useCallback(() => {
    props.sessions.clear();
    setSession(null);
    setNotice(null);
    props.navigate(pathTo('agency:sign-in'));
  }, [props]);

  // **The session ending is a fact about the application, not about a screen.**
  // The client raises it once, from wherever the refusal arrived, and this is
  // the only handler. Held in a ref rather than closed over by the client's
  // memo: the address changes on every navigation and the client must not,
  // because a new client is a new read of everything on the page.
  //
  // **A refusal belongs to the session that made the request.** A client keeps
  // the bearer it was built with, and a call can be answered long after that
  // bearer stopped being anybody's session: two reads leave together, the first
  // 401 sends the person to sign-in, they sign in, and then the second arrives.
  // Acting on it would clear the session that replaced the one it was refusing
  // — signing the person out of a session no server ever refused. So the
  // session the client was built with comes back with the notification and the
  // whole action, not only the storage clear, is gated on it still being the
  // one in hand. Identity is the test: `setSession` is the only way a session
  // gets here, and every sign-in mints a new object.
  const endedRef = useRef<(from: Session, refusal: WireRefusal) => void>(() => undefined);
  const hereRef = useRef(here);
  hereRef.current = here;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  endedRef.current = (from, refusal) => {
    if (sessionRef.current !== from) return;
    props.sessions.end({
      address: hereRef.current,
      businessKey: from.businessKey,
      code: refusal.code,
    });
    setSession(null);
    props.navigate(pathTo('agency:sign-in'));
  };

  const client = useMemo(
    () =>
      new OperationsClient({
        origin: props.apiOrigin,
        businessKey: session?.businessKey ?? 'alpha',
        token: session?.token ?? null,
        fetch: props.fetch,
        onSessionEnded: (refusal) => {
          // `session` here is this client's own generation, captured when it
          // was built, and not whatever is current when the answer lands.
          if (session !== null) endedRef.current(session, refusal);
        },
      }),
    [props.apiOrigin, props.fetch, session],
  );

  const onSwitch = (businessKey: string, address: string): void => {
    if (session === null) return;
    const moved = { ...session, businessKey };
    props.sessions.set(moved);
    setSession(moved);
    setNotice(null);
    props.navigate(address);
  };

  const bare = here.split(/[?#]/u)[0] ?? here;
  const match = matchRoute(bare);
  const at = pageAt(bare);
  const grantKey = grantKeyOf(session);
  const clientAccess = props.clientAccess ?? NO_CLIENT_GRANTS;
  const refused =
    at !== null &&
    at.client !== null &&
    (session === null || !clientAccess(session.businessKey, at.client));
  const rail = railFor(at, refused);

  const signIn = (
    <SignIn
      gotrueUrl={props.gotrueUrl}
      fetch={props.fetch}
      onSignedIn={onSignedIn}
      ended={props.sessions.interruption}
    />
  );

  const content = ((): ReactElement => {
    // A manifest page with no screen yet: sign-in first, then the grant check.
    if (match === null && at !== null) {
      if (session === null) return signIn;
      return refused ? <ClientRefused /> : <PagePlaceholder page={at.page} />;
    }
    const gate = gateOf(match, session !== null);
    switch (gate.kind) {
      case 'not-found':
        return <NotFound path={here} />;
      case 'sign-in':
        return signIn;
      case 'signed-in-already':
        return (
          <SignedInAlready
            onGo={() => {
              props.navigate(pathTo('agency:projects-board'));
            }}
          />
        );
      case 'screen':
        return drawScreen(gate.match, {
          client,
          grantKey,
          notice:
            notice === null || session === null ? null : (
              <HeldAddressNotice
                offer={notice.offer}
                signedInTo={session.businessKey}
                onSwitch={onSwitch}
              />
            ),
          storage: props.storage,
        });
    }
  })();

  return (
    <Shell
      face={at?.page.namespace === 'portal' ? 'client' : 'agency'}
      rail={rail}
      here={bare}
      title={refused ? 'Not available' : (match?.route.title ?? at?.page.label ?? 'Not found')}
      meta={
        session === null ? null : (
          <span className="topbar__who">
            {session.email} · {session.businessKey}
            <button className="btn" type="button" onClick={onSignOut}>
              Sign out
            </button>
          </span>
        )
      }
      onClick={dock.onDoor}
      dockWidth={layout.geometry.mode === 'seated' ? layout.geometry.groupWidth : 0}
      // The client face has no dock (R17), and nobody signed out has one.
      dock={
        session === null || at?.page.namespace === 'portal'
          ? null
          : dockProps({
              registry,
              dock,
              layout,
              navigate: props.navigate,
              screen: { client, grantKey, notice: null, storage: props.storage },
            })
      }
    >
      {at === null || refused || session === null ? null : <RouteTabs at={at} />}
      {content}
    </Shell>
  );
}

/**
 * The dock as the shell draws it. A tab press follows the gesture law; each
 * open panel draws the screen of the view it is on, and its door carries that
 * view's own address, or its board's when the view has none (CS-3.3). A link
 * followed inside a panel walks the panel, not the page.
 */
function dockProps(input: {
  readonly registry: PanelRegistry;
  readonly dock: ReturnType<typeof useDock>;
  readonly layout: ReturnType<typeof useDockLayout>;
  readonly navigate: (path: string) => void;
  readonly screen: Omit<ScreenContext, 'params'>;
}): DockProps {
  const { registry, dock, layout } = input;
  const drawn = new Set(layout.geometry.open);
  const tabs = dockTabs({}, registry);
  const byId = (id: string): PanelId | null =>
    isPanelId(id) && tabs.some((tab) => tab.id === id) ? id : null;
  return {
    tabs: tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      count: tab.count,
      open: dock.state.open.includes(tab.id),
    })),
    layout: { mode: layout.geometry.mode, panelWidth: layout.geometry.panelWidth },
    stamp: layout.stamp,
    onResize: layout.setWidth,
    onResizeEnd: layout.setWidth,
    panels: ranked(dock.state).flatMap((id) => {
      const panel = registry[id];
      // A panel R39 is closing draws nothing while the close lands.
      if (panel === undefined || !drawn.has(id)) return [];
      const place = dock.state.places[id];
      const door = screenAt(place) === null ? pathTo(panel.route) : (place ?? pathTo(panel.route));
      const view = screenAt(door);
      return [
        {
          id,
          label: panel.label,
          ariaLabel: panel.ariaLabel,
          door,
          canBack: false,
          canForward: false,
          body: view === null ? null : drawScreen(view.match, input.screen),
        },
      ];
    }),
    onTab: (id, shift) => {
      const panel = byId(id);
      if (panel !== null) dock.change((state) => press(state, panel, shift));
    },
    onClose: (id) => {
      const panel = byId(id);
      if (panel !== null) dock.change((state) => close(state, panel));
    },
    onCloseAll: () => {
      dock.change(closeAll);
    },
    onBack: () => undefined,
    onForward: () => undefined,
    onDoor: input.navigate,
    onBodyClick: (id, event) => {
      const panel = byId(id);
      // A link that is itself a door into the dock is the gesture law's, not a walk.
      const link =
        event.target instanceof Element
          ? event.target.closest('a[href]:not([data-dock-open]):not([data-ask])')
          : null;
      if (panel === null || link === null || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (link.getAttribute('target') !== null && link.getAttribute('target') !== '_self') return;
      const href = link.getAttribute('href') ?? '';
      if (screenAt(href) === null) return;
      event.preventDefault();
      dock.change((state) => visit(state, panel, href));
    },
  };
}

/** The screen an address this application owns draws, or null for none. */
function screenAt(address: string | undefined): Extract<Gate, { readonly kind: 'screen' }> | null {
  if (!isOwnAddress(address)) return null;
  try {
    const gate = gateOf(matchRoute(address.split(/[?#]/u)[0] ?? address), true);
    return gate.kind === 'screen' ? gate : null;
  } catch {
    // A malformed escape in the address: it names no view.
    return null;
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
