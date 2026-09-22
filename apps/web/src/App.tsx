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

import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Shell, type RailEntry } from '@launchastro/ui';
import { ROUTES, matchRoute } from './routes.ts';
import { OperationsClient } from './operations/client.ts';
import { grantKeyOf, type Session, type SessionStore } from './session/token.ts';
import { SignIn } from './screens/SignIn.tsx';
import { Projects } from './screens/Projects.tsx';
import { TaskDetailScreen } from './screens/TaskDetail.tsx';

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

  const onSignedIn = useCallback(
    (next: Session) => {
      props.sessions.set(next);
      setSession(next);
      props.navigate('/projects/');
    },
    [props],
  );

  const onSignOut = useCallback(() => {
    props.sessions.clear();
    setSession(null);
    props.navigate('/sign-in');
  }, [props]);

  const client = useMemo(
    () =>
      new OperationsClient({
        base: props.apiBase,
        businessKey: session?.businessKey ?? 'alpha',
        token: session?.token ?? null,
        fetch: props.fetch,
      }),
    [props.apiBase, props.fetch, session],
  );

  const match = matchRoute(props.path);
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
      <NotFound path={props.path} />
    ) : session === null || !route.authenticated ? (
      session !== null && !route.authenticated ? (
        <SignedInAlready
          onGo={() => {
            props.navigate('/projects/');
          }}
        />
      ) : (
        <SignIn gotrueUrl={props.gotrueUrl} fetch={props.fetch} onSignedIn={onSignedIn} />
      )
    ) : route.id === 'agency:projects-board' ? (
      <Projects
        client={client}
        grantKey={grantKey}
        onOpenTask={(key) => {
          props.navigate(`/task/${encodeURIComponent(key)}`);
        }}
      />
    ) : (
      <TaskDetailScreen client={client} grantKey={grantKey} taskKey={match?.params['key'] ?? ''} />
    );

  return (
    <Shell
      face="agency"
      rail={rail}
      here={props.path}
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
      dock={[]}
      onDockTab={() => {
        /* No panel is registered in the working slice. */
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
