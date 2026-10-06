// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: an access ending can leave the person's provider user and the API's
// cookie session alive (a login shared with another business keeps both). So a
// tab that hears 403 `AUTH_ACCESS_ENDED` forgets the session and then, as a
// sign-out in the tab does, asks the API to end that sign-in and clear its
// cookie. It is best effort: a sign-out call that fails never keeps the person
// signed in. A 401 ending is not followed by it: that credential is already dead.

import { afterEach, describe, expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION_ID = '0123456789abcdef0123456789abcdef';
const SESSION = { businessKey: 'alpha', email: 'mia@alpha.local', sessionId: SESSION_ID };

interface Sent {
  readonly url: string;
  readonly session: string | null;
}

/** A stand-in API: every operation answered `code` with `status`; sign-outs recorded, or thrown. */
function api(code: string, status: number, signOutFails = false) {
  const signOuts: Sent[] = [];
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/account/sessions/sign-out') || url.includes('/api/session/end')) {
      signOuts.push({ url, session: new Headers(init?.headers).get('x-ops-astro-session') });
      return signOutFails
        ? Promise.reject(new Error('the network went away'))
        : Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(
      Response.json({ refused: true, code, names: [], fixes: [] }, { status }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, signOuts };
}

function storage(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

function Harness(props: {
  readonly sessions: SessionStore;
  readonly fetch: typeof globalThis.fetch;
}): ReactElement {
  const [path, setPath] = useState('/task/TSK-1');
  return (
    <App
      path={path}
      navigate={setPath}
      sessions={props.sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={props.fetch}
      storage={window.sessionStorage}
    />
  );
}

const live: Mounted[] = [];

async function opened(fetch: typeof globalThis.fetch) {
  const sessions = new SessionStore(storage());
  const view = await mount(<Harness sessions={sessions} fetch={fetch} />);
  live.push(view);
  await settle();
  await settle();
  return { view, sessions };
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('the API cookie session, when access ended', () => {
  it('is ended by a sign-out of this sign-in, after the tab has signed the person out', async () => {
    const { fetch, signOuts } = api('AUTH_ACCESS_ENDED', 403);
    const { view, sessions } = await opened(fetch);
    expect(view.find('#signin-email')).not.toBeNull();
    expect(sessions.session).toBeNull();
    expect(signOuts[0]).toEqual({
      url: '/api/b/alpha/account/sessions/sign-out',
      session: SESSION_ID,
    });
  });

  it('never keeps the person signed in when that sign-out call fails', async () => {
    const { fetch, signOuts } = api('AUTH_ACCESS_ENDED', 403, true);
    const { view, sessions } = await opened(fetch);
    expect(signOuts.length).toBeGreaterThan(0);
    expect(view.find('#signin-email')).not.toBeNull();
    expect(view.find('[data-reason="session-ended"]')).not.toBeNull();
    expect(sessions.session).toBeNull();
  });

  it('is not asked of the API after a 401 ending, where the credential is already dead', async () => {
    const { fetch, signOuts } = api('AUTH_SESSION_EXPIRED', 401);
    const { view } = await opened(fetch);
    expect(view.find('#signin-email')).not.toBeNull();
    expect(signOuts).toEqual([]);
  });
});
