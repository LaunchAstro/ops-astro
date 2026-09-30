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
import { Shell, type StripSteps } from '@launchastro/ui';
import { FaceProvider } from './face.tsx';
import { SearchPalette, useSearch, useSearchKey } from './search.tsx';
import { pathTo } from './routes.ts';
import { NO_CLIENT_GRANTS, type ClientAccess } from './manifest.ts';
import { frameAt } from './route-views.tsx';
import { drawContent } from './app-content.tsx';
import { buildStamp, useCanonicalAddress, useOfflineSince, usePersonName } from './app-state.ts';
import { FrameStrip } from './strip.tsx';
import { HeldAddressNotice, heldAddressOffer, type HeldOffer } from './held-address.tsx';
import { PANELS, dockTabs } from './panels.ts';
import { OperationsClient, type WireRefusal } from './operations/client.ts';
import { grantKeyOf, type Interruption, type Session, type SessionStore } from './session/token.ts';
import { SignIn } from './screens/SignIn.tsx';
import { signOut } from './session/sign-in.ts';
import { PagePresenceProvider, StripPresence } from './views/presence.tsx';
import { PageFreshnessProvider, StripFreshness } from './views/freshness.tsx';

export interface AppProps {
  /** The address the application is drawing. Owned here, not read from a global. */
  readonly path: string;
  /** `replace` corrects the address of the page already open, adding no history entry. */
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void;
  /** The tab's Back and Forward, when the entry owns a history (MP-2-5). */
  readonly steps?: StripSteps;
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
  const navigate = props.navigate;
  const here = useCanonicalAddress(props.path, session !== null, navigate);

  // The narrow drawer (MP-2-8) is open or not here, and any change of address
  // closes it, a link in it included.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    setNavOpen(false);
  }, [here]);
  const offlineSince = useOfflineSince();
  const search = useSearch();

  // Why the board was reached instead of the address that was held. Drawn on
  // the board and nowhere else, and gone when this session is. The offer is the
  // server's answer on whether to name the business the address belongs to.
  const [notice, setNotice] = useState<{
    readonly held: Interruption;
    readonly offer: HeldOffer | null;
  } | null>(null);
  // The person signed out here, so sign-in says their unsaved edit went with it (C58).
  const [signedOut, setSignedOut] = useState(false);

  const onSignedIn = useCallback(
    (next: Session) => {
      // Spent here, so the next ordinary sign-in is not redirected by an
      // interruption somebody already answered.
      const back = props.sessions.takeInterruption();
      props.sessions.set(next);
      setSession(next);
      setNotice(null);
      setSignedOut(false);
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

  // Sign-out (C23). The tab forgets the session first, so a server that never
  // answers cannot keep it. Then, with the ended session's own client:
  // `session.end` records it on the audit chain, and the API clears this
  // sign-in's cookie and no other (S0-6c). Neither answer is waited for.
  const onSignOut = (): void => {
    const ended = session;
    props.sessions.clear();
    setSession(null);
    setNotice(null);
    setSignedOut(true);
    props.navigate(pathTo('agency:sign-in'));
    if (ended === null) return;
    void client.mutate('session.end', {});
    const named = ended.sessionId === undefined ? {} : { sessionId: ended.sessionId };
    void signOut({ apiOrigin: props.apiOrigin, fetch: props.fetch, ...named });
  };

  const personName = usePersonName(client, session, props.storage);
  const onSwitch = (businessKey: string, address: string): void => {
    if (session === null) return;
    const moved = { ...session, businessKey };
    props.sessions.set(moved);
    setSession(moved);
    setNotice(null);
    props.navigate(address);
  };

  const bare = here.split(/[?#]/u)[0] ?? here;
  const grantKey = grantKeyOf(session);
  const { match, at, refused, rail, tabs, identity, face } = frameAt(
    bare,
    session?.businessKey ?? null,
    props.clientAccess ?? NO_CLIENT_GRANTS,
  );
  const searchable = session !== null && face === 'agency';
  useSearchKey(searchable, search.open);

  const signIn = (
    <SignIn
      gotrueUrl={props.gotrueUrl}
      apiOrigin={props.apiOrigin}
      fetch={props.fetch}
      onSignedIn={onSignedIn}
      ended={props.sessions.interruption}
      signedOut={signedOut}
    />
  );

  const content = drawContent({
    here,
    match,
    at,
    signedIn: session !== null,
    refused,
    signIn,
    onGo: () => {
      props.navigate(pathTo('agency:projects-board'));
    },
    screen: {
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
      navigate: props.navigate,
    },
  });

  return (
    <PageFreshnessProvider>
      <PagePresenceProvider>
        <Shell
          face={face}
          build={buildStamp()}
          rail={rail}
          here={bare}
          strip={
            <FrameStrip
              face={face}
              identity={identity}
              clientSlug={at?.client ?? null}
              steps={props.steps}
              onSearch={searchable ? search.open : null}
              searchRef={search.box}
              session={session}
              personName={personName}
              navigate={navigate}
              onSignOut={onSignOut}
            />
          }
          tabs={tabs}
          nav={{ open: navOpen, onToggle: setNavOpen }}
          onNavigate={navigate}
          meta={
            <>
              <StripFreshness
                fallback={
                  offlineSince === null ? null : { state: 'offline', lastRead: offlineSince }
                }
              />
              {session === null ? null : <StripPresence />}
            </>
          }
          title={refused ? 'Not available' : (match?.route.title ?? at?.page.label ?? 'Not found')}
          // An open tab is announced as "Close", so pressing it leaves the address
          // for the board rather than pushing the same address again.
          dock={session === null || face === 'client' ? [] : dockTabs(here)}
          onDockTab={(id) => {
            const panel = PANELS.find((entry) => entry.id === id);
            if (panel === undefined || panel.route === null) return;
            const target = pathTo(panel.route);
            props.navigate(here === target ? pathTo('agency:projects-board') : target);
          }}
          seated={false}
        >
          <FaceProvider face={face}>{content}</FaceProvider>
        </Shell>
        {search.showing && searchable ? (
          <SearchPalette
            client={client}
            onOpen={(address) => {
              search.dismiss();
              navigate(address);
            }}
            onClose={search.close}
          />
        ) : null}
      </PagePresenceProvider>
    </PageFreshnessProvider>
  );
}
