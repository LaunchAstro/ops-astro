// SPDX-License-Identifier: AGPL-3.0-only
//
// The application: which address is open, who is signed in, and nothing else.
//
// **There is no demonstration state and no way to ask for one.** The draft's
// entry read a `?state=` parameter and selected one of seven seeded corpora,
// which is how a mockup demonstrates itself and is not how a product reports.
// Every screen below reads through the real client, and a read that fails draws
// the failure. The corpus survives in `packages/ui` as the drawn *vocabulary*
// — the words and tones a state may print — and not as a source of rows.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Shell, type RailEntry } from '@launchastro/ui';
import { ROUTES, matchRoute } from './routes.ts';
import { PANELS } from './panels.ts';
import { OperationsClient, type WireRefusal } from './operations/client.ts';
import { grantKeyOf, type Session, type SessionStore } from './session/token.ts';
import { SignIn } from './screens/SignIn.tsx';
import { Projects } from './screens/Projects.tsx';
import { TaskDetailScreen } from './screens/TaskDetail.tsx';
import { SettingsScreen } from './screens/Settings.tsx';

export interface AppProps {
  /** The address the application is drawing. Owned here, not read from a global. */
  readonly path: string;
  readonly navigate: (path: string) => void;
  readonly sessions: SessionStore;
  /** Where the identity provider is. Injected so a test never needs a network. */
  readonly gotrueUrl: string;
  /** The API prefix. `/api` behind the dev proxy. */
  readonly apiBase: string;
  readonly fetch: typeof globalThis.fetch;
}

export function App(props: AppProps): ReactElement {
  const [session, setSession] = useState<Session | null>(props.sessions.session);

  // The root address is not a screen and it is not a mistake either: it is how
  // a person arrives. It leads to the board when there is a session and to
  // sign-in when there is not, and the address bar is corrected to say so, so
  // a reload lands on the same place a link would.
  const here = props.path === '/' ? (session === null ? '/sign-in' : '/projects/') : props.path;
  const navigate = props.navigate;
  useEffect(() => {
    if (here !== props.path) navigate(here);
  }, [here, props.path, navigate]);

  // Why the board was reached instead of the address that was held. Drawn on
  // the board and nowhere else, and gone when this session is.
  const [notice, setNotice] = useState<string | null>(null);

  const onSignedIn = useCallback(
    (next: Session) => {
      // Spent here, so the next ordinary sign-in is not redirected by an
      // interruption somebody already answered.
      const back = props.sessions.takeInterruption();
      props.sessions.set(next);
      setSession(next);
      setNotice(null);
      if (back === null) {
        props.navigate('/projects/');
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
      setNotice(
        `You signed in to ${next.businessKey}, and ${back.address} is an address in ` +
          `${back.businessKey}. This is the ${next.businessKey} board. Sign in to ` +
          `${back.businessKey} to go back to where you were.`,
      );
      props.navigate('/projects/');
    },
    [props],
  );

  const onSignOut = useCallback(() => {
    props.sessions.clear();
    setSession(null);
    setNotice(null);
    props.navigate('/sign-in');
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
    props.navigate('/sign-in');
  };

  const client = useMemo(
    () =>
      new OperationsClient({
        base: props.apiBase,
        businessKey: session?.businessKey ?? 'alpha',
        token: session?.token ?? null,
        fetch: props.fetch,
        onSessionEnded: (refusal) => {
          // `session` here is this client's own generation, captured when it
          // was built, and not whatever is current when the answer lands.
          if (session !== null) endedRef.current(session, refusal);
        },
      }),
    [props.apiBase, props.fetch, session],
  );

  const match = matchRoute(here);
  const route = match?.route ?? null;
  const grantKey = grantKeyOf(session);

  const rail: readonly RailEntry[] = ROUTES.filter((entry) => entry.rail).map((entry) => ({
    id: entry.id,
    label: entry.title,
    href: entry.path,
  }));

  // An address that needs a session and has none is the sign-in screen, and the
  // sign-in screen is where a signed-out person lands. Neither is an error.
  const content =
    route === null ? (
      <NotFound path={here} />
    ) : session === null || !route.authenticated ? (
      session !== null && !route.authenticated ? (
        <SignedInAlready
          onGo={() => {
            props.navigate('/projects/');
          }}
        />
      ) : (
        <SignIn
          gotrueUrl={props.gotrueUrl}
          fetch={props.fetch}
          onSignedIn={onSignedIn}
          ended={props.sessions.interruption}
        />
      )
    ) : route.id === 'agency:projects-board' ? (
      <>
        {notice === null ? null : (
          <p className="signin__ended" role="status" data-notice="other-business">
            {notice}
          </p>
        )}
        <Projects
          client={client}
          grantKey={grantKey}
          onOpenTask={(key) => {
            props.navigate(`/task/${encodeURIComponent(key)}`);
          }}
        />
      </>
    ) : route.id === 'agency:settings' ? (
      <SettingsScreen
        client={client}
        grantKey={grantKey}
        storage={typeof sessionStorage === 'undefined' ? null : sessionStorage}
      />
    ) : (
      <TaskDetailScreen client={client} grantKey={grantKey} taskKey={match?.params['key'] ?? ''} />
    );

  return (
    <Shell
      face="agency"
      rail={rail}
      here={here}
      title={route?.title ?? 'Not found'}
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
      // The panel registry is the dock. Each registration names the address
      // that draws its surface, and the tab navigates there rather than
      // opening a drawer over the page: the surface has a real address, and an
      // address a person can quote is worth more than a panel they cannot.
      dock={
        session === null
          ? []
          : PANELS.map((panel) => ({
              id: panel.id,
              label: panel.label,
              open: panel.route !== null && here === panel.route,
            }))
      }
      onDockTab={(id) => {
        const panel = PANELS.find((entry) => entry.id === id);
        if (panel?.route != null) props.navigate(panel.route);
      }}
      seated={false}
    >
      {content}
    </Shell>
  );
}

function NotFound(props: { readonly path: string }): ReactElement {
  return (
    <div className="readstate" data-outcome="not-found">
      <p className="empty__title">No screen is registered at {props.path}.</p>
      <p className="empty__desc">
        The route registry is the list the application resolves through. An address that is not in
        it does not resolve, which is a truer answer than a blank page.
      </p>
      <p className="empty__hint">
        <a className="sb__addr" href="/projects/">
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
