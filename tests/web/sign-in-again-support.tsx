// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the application's half of the money step-up (C59, Q1 and
// Q2): the session, the client built for it, and the two providers, the code's
// step-up and the client's password sign-in again, written as `App.tsx` writes
// them. The screens and the hook under test are drawn inside it, and the API
// and the identity provider are one fake fetch that records every call.

import { act, useMemo, useRef, useState, type ReactElement } from 'react';
import { vi } from 'vitest';
import { CSRF_HEADER, SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SignInAgainContext, StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { signInAgainSession } from '../../apps/web/src/session/sign-in-again.ts';
import { stepUpSession, type StepUpResult } from '../../apps/web/src/session/step-up.ts';
import { SessionStore, sessionGeneration, type Session } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { json, storage } from './mp-2-1-support.tsx';

export const GOTRUE = 'http://identity.invalid';
export const PASSWORD = 'PASSWORD-CANARY-horse-battery';
export const FRESH = 'tok-password-fresh-secret';
export const FRESH_REFRESH = 'refresh-password-fresh-secret';
export const EMAIL = 'cleo@example.test';

export interface Call {
  readonly url: string;
  readonly session: string | null;
  readonly authorization: string | null;
  readonly csrf: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  /** The tab's session id when the call left. */
  readonly tabAt: string | undefined;
}

export const refusal = (
  code: string,
  fixes: readonly string[],
  status = 403,
  names: readonly string[] = [],
): Response => json({ refused: true, code, names, fixes }, status);

export const never = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });

const unanswered = (): void => {};

/** A response held until the test lets it go. */
export function held(): {
  readonly answer: (response: Response) => void;
  readonly wait: () => Promise<Response>;
} {
  let answer: (response: Response) => void = unanswered;
  const promise = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  return { answer: (response) => answer(response), wait: () => promise };
}

/** GoTrue's password grant: the one good password signs in, any other is refused in its words. */
export const goodPassword = (body: Readonly<Record<string, unknown>>): Promise<Response> =>
  Promise.resolve(
    body['password'] === PASSWORD && body['email'] === EMAIL
      ? json({ access_token: FRESH, refresh_token: FRESH_REFRESH, expires_in: 3600 })
      : json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400),
  );

/** A case's own answer to a call, or null to leave it to the shared routes. */
export type Route = (call: Call) => Promise<Response> | null;

/** The fake fetch: `route` answers first, then the routes every case shares. */
export function api(sessions: SessionStore, route: Route = () => null) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      session: headers.get(SESSION_HEADER),
      authorization: headers.get('authorization'),
      csrf: headers.get(CSRF_HEADER),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      tabAt: sessions.session?.sessionId,
    };
    calls.push(call);
    const own = route(call);
    if (own !== null) return await own;
    if (url === `${GOTRUE}/token?grant_type=password`) return await goodPassword(call.body);
    if (url === '/api/session') {
      return call.authorization === `Bearer ${FRESH}`
        ? json({ ok: true, session: 'sid-new' })
        : refusal('AUTH_UNKNOWN_LOGIN', [], 401);
    }
    if (url === '/api/session/end') return json({ ok: true });
    if (url === `${GOTRUE}/logout?scope=local`) return new Response(null, { status: 204 });
    if (url.endsWith('/account/sessions/sign-out')) {
      return json({ ended: 1, signedOutAtProvider: true });
    }
    calls.pop();
    return await never();
  }) as unknown as typeof globalThis.fetch;
  const to = (suffix: string): Call[] => calls.filter((call) => call.url.endsWith(suffix));
  return { fetch, calls, to };
}

/** The application's half, as `App.tsx` writes it: the session, its client and both step-ups. */
// eslint-disable-next-line max-lines-per-function -- the application's half in one piece, as App.tsx holds it
function Harness(props: {
  readonly sessions: SessionStore;
  readonly fetch: typeof globalThis.fetch;
  readonly draw: (client: OperationsClient) => ReactElement;
  readonly ending: { end: () => void };
}): ReactElement {
  const { sessions, fetch } = props;
  const [session, setSession] = useState<Session | null>(sessions.session);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  props.ending.end = () => {
    sessions.clear();
    setSession(null);
  };
  const client = useMemo(
    () =>
      new OperationsClient({
        origin: '',
        businessKey: session?.businessKey ?? 'alpha',
        signedIn: session !== null,
        ...(session?.sessionId === undefined ? {} : { sessionId: session.sessionId }),
        fetch,
      }),
    [fetch, session],
  );
  const route = { apiOrigin: '', fetch };
  const moved = (from: Session) => (sessionId: string) => {
    const next = { ...from, sessionId };
    sessions.set(next);
    sessionRef.current = next;
    setSession(next);
  };
  const stepUp = async (code: string): Promise<StepUpResult> => {
    const from = session;
    if (from === null) return { ok: false, because: 'Sign in first.' };
    const generation = sessionGeneration();
    return await stepUpSession({
      code,
      client,
      route,
      from: from.sessionId,
      current: () => generation === sessionGeneration() && sessionRef.current === from,
      adopt: moved(from),
    });
  };
  const signInAgain = async (password: string): Promise<StepUpResult> => {
    const from = session;
    if (from === null) return { ok: false, because: 'Sign in first.' };
    const generation = sessionGeneration();
    return await signInAgainSession({
      gotrueUrl: GOTRUE,
      email: from.email,
      password,
      route,
      businessKey: from.businessKey,
      from: from.sessionId,
      current: () => generation === sessionGeneration() && sessionRef.current === from,
      adopt: moved(from),
    });
  };
  return (
    <StepUpContext.Provider value={session === null ? null : stepUp}>
      <SignInAgainContext.Provider value={session === null ? null : signInAgain}>
        {props.draw(client)}
      </SignInAgainContext.Provider>
    </StepUpContext.Provider>
  );
}

export interface Drawn {
  readonly view: Mounted;
  readonly server: ReturnType<typeof api>;
  readonly sessions: SessionStore;
  readonly held: Map<string, string>;
  /** The session ends, as a sign-out elsewhere in the tab ends it. */
  readonly end: () => Promise<void>;
}

/** `draw` mounted inside the stand-in application, signed in to alpha as `sid-old`. */
export async function drawSignedIn(
  route: Route,
  draw: (client: OperationsClient) => ReactElement,
): Promise<Drawn> {
  const store = storage({
    'ops-astro.session': JSON.stringify({
      businessKey: 'alpha',
      email: EMAIL,
      sessionId: 'sid-old',
    }),
  });
  const sessions = new SessionStore(store.like);
  const server = api(sessions, route);
  const ending = { end: () => {} };
  const view = await mount(
    <Harness sessions={sessions} fetch={server.fetch} draw={draw} ending={ending} />,
  );
  const end = async (): Promise<void> => {
    await act(async () => {
      ending.end();
      await Promise.resolve();
    });
  };
  return { view, server, sessions, held: store.held, end };
}

/** Every password input's value on the page, which must be empty once a password is sent. */
export const typedPasswords = (view: Mounted): string[] =>
  view.all('input[type="password"]').map((input) => (input as HTMLInputElement).value);
