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
import { Shell } from '@launchastro/ui';
import { gateOf, matchRoute, pathTo } from './routes.ts';
import { NO_CLIENT_GRANTS, canonicalOf, pageAt, type ClientAccess } from './manifest.ts';
import {
  ClientRefused,
  NotFound,
  PagePlaceholder,
  RouteTabs,
  SignedInAlready,
  TopbarMeta,
  railFor,
} from './route-views.tsx';
import { HeldAddressNotice, heldAddressOffer, type HeldOffer } from './held-address.tsx';
import { PANELS } from './panels.ts';
import { OperationsClient, type WireRefusal } from './operations/client.ts';
import { grantKeyOf, type Interruption, type Session, type SessionStore } from './session/token.ts';
import { signOut } from './session/sign-in.ts';
import { SignIn } from './screens/SignIn.tsx';
import { drawScreen } from './screen-registry.tsx';

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
}

export function App(props: AppProps): ReactElement {
  const [session, setSession] = useState<Session | null>(props.sessions.session);

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
    const sessionId = props.sessions.session?.sessionId;
    void signOut({
      apiOrigin: props.apiOrigin,
      fetch: props.fetch,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
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
  const endedRef = useRef<(from: Session, refusal: WireRefusal) => void>(() => {});
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
        signedIn: session !== null,
        ...(session?.sessionId === undefined ? {} : { sessionId: session.sessionId }),
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

  // Compiled in by the build's stamp (`apps/web/vite.config.ts`); absent under a
  // bundler that did not stamp, and the rail then says the build is unstamped.
  // Read by name, never by index: an indexed read inlines every VITE_ setting
  // of the build's environment into the bundle (G3).
  const build = import.meta.env.VITE_OPS_ASTRO_BUILD ?? '';
  const signIn = (
    <SignIn
      gotrueUrl={props.gotrueUrl}
      apiOrigin={props.apiOrigin}
      fetch={props.fetch}
      onSignedIn={onSignedIn}
      ended={props.sessions.interruption}
      build={build === '' ? null : build}
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

  // Signed out, the page is the form alone: every rail entry and dock tab asks
  // for a session, so the shell would offer nothing a person could open (B6).
  if (content === signIn) return signIn;

  return (
    <Shell
      face={at?.page.namespace === 'portal' ? 'client' : 'agency'}
      build={build === '' ? null : build}
      rail={rail}
      here={bare}
      title={refused ? 'Not available' : (match?.route.title ?? at?.page.label ?? 'Not found')}
      meta={
        session === null ? null : (
          <TopbarMeta
            session={session}
            held={match === null && at !== null && !refused}
            onSignOut={onSignOut}
          />
        )
      }
      // The panel registry is the dock. Each registration names the address
      // that draws its surface, and the tab navigates there rather than
      // opening a drawer over the page: the surface has a real address, and an
      // address a person can quote is worth more than a panel they cannot.
      // An open tab is announced as "Close", so pressing it leaves the address
      // for the board rather than pushing the same address again.
      // The client face has no dock (R17).
      dock={
        session === null || at?.page.namespace === 'portal'
          ? []
          : PANELS.map((panel) => ({
              id: panel.id,
              label: panel.label,
              icon: panel.icon,
              open: panel.route !== null && here === pathTo(panel.route),
            }))
      }
      onDockTab={(id) => {
        const panel = PANELS.find((entry) => entry.id === id);
        if (panel === undefined || panel.route === null) return;
        const target = pathTo(panel.route);
        props.navigate(here === target ? pathTo('agency:projects-board') : target);
      }}
      seated={false}
    >
      {at === null || refused || session === null ? null : <RouteTabs at={at} />}
      {content}
    </Shell>
  );
}
