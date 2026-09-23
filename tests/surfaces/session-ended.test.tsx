// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The hour ran out, and there is a way back in.
//
// A local GoTrue access token lives for one hour. The API answers a missing, an
// expired and an unverifiable bearer identically -- HTTP 401, refusal code
// `AUTH_UNKNOWN_LOGIN` -- because telling them apart tells an unauthenticated
// caller which guess was closer (`docs/local/API.md`). So the application
// cannot say "expired": it can only say the session has ended and sign-in is
// needed, and these cases hold it to exactly that wording.
//
// **One signal, one place.** The signal is the operations client's, for a read
// and for a mutation alike, and the three cases below are the whole of the
// behaviour: a read that ends the session, a mutation that ends the session,
// and an ordinary denial that ends nothing. The third is the one that keeps the
// first two honest -- a rule that signs a person out on any refusal would pass
// both of the others and be worse than the stuck screen it replaced.
//
// It is a stub, and it discharges no browser case. SX1-SX3 in
// `tests/browser/cases-session-expiry.mjs` do that against the real API.

import { describe, expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION = { token: 'the-hour-old-token', businessKey: 'alpha', email: 'mia@alpha.local' };

const TASK = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'TSK-1',
  title: 'Wire the board to the API',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 3,
  history: [],
};

const PEOPLE = [{ personId: 'p1', name: 'Mia Alpha' }];

/** A storage that is a map the test can read back, so "cleared" is a fact. */
function storage(seed: Record<string, string> = {}): {
  readonly like: StorageLike;
  readonly held: Map<string, string>;
} {
  const held = new Map(Object.entries(seed));
  return {
    held,
    like: {
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => {
        held.set(key, value);
      },
      removeItem: (key) => {
        held.delete(key);
      },
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Each refusal is minted per call and never shared. A `Response` body is read
// once, and a second reader of the same object gets an empty one -- which the
// client correctly reports as the API failing rather than refusing, and which
// would quietly make these cases about the wrong thing.
/** The refusal the API gives for every bearer it cannot vouch for. */
const unknownLogin = (): Response =>
  json({ refused: true, code: 'AUTH_UNKNOWN_LOGIN', names: [], fixes: [] }, 401);

const scopeDenied = (): Response =>
  json(
    {
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
      names: ['tasks'],
      fixes: ['Ask an administrator.'],
    },
    403,
  );

/**
 * The stand-in API and identity provider.
 *
 * `ended` is the one-hour boundary: while it is set, every call carrying the
 * session's bearer is answered the way the API answers a token it cannot
 * verify. A fresh sign-in resets it, which is what the return path needs.
 */
function server(options: { readonly reads?: 'ok' | 'ended' | 'scope' } = {}) {
  let reads = options.reads ?? 'ok';
  let mutations: 'ok' | 'ended' = 'ok';
  const seenTokens: (string | null)[] = [];

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.startsWith('http://identity.invalid/token')) {
      // A new hour. Everything the old token could not do, the new one can.
      reads = 'ok';
      mutations = 'ok';
      return json({ access_token: 'a-fresh-token' });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seenTokens.push(headers['authorization'] ?? null);

    if (at.endsWith('/person/list')) return json({ ok: true, persons: PEOPLE });
    if (at.endsWith('/task/read') || at.endsWith('/task/board')) {
      if (reads === 'ended') return unknownLogin();
      if (reads === 'scope') return scopeDenied();
      return at.endsWith('/task/read')
        ? json({ ok: true, task: TASK })
        : json({ ok: true, tasks: [TASK] });
    }
    // Every mutation: create, assign, the three lifecycle commands, update.
    if (mutations === 'ended') return unknownLogin();
    return json({ recordId: TASK.id, revision: TASK.revision + 1 });
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    seenTokens,
    endTheSession(): void {
      reads = 'ended';
      mutations = 'ended';
    },
    endTheSessionOnMutationsOnly(): void {
      mutations = 'ended';
    },
  };
}

/** The address, as state, the way `main.tsx` holds it. */
function Harness(props: {
  readonly start: string;
  readonly sessions: SessionStore;
  readonly fetch: typeof globalThis.fetch;
  readonly seen: string[];
}): ReactElement {
  const [path, setPath] = useState(props.start);
  return (
    <App
      path={path}
      navigate={(next) => {
        props.seen.push(next);
        setPath(next);
      }}
      sessions={props.sessions}
      gotrueUrl="http://identity.invalid"
      apiBase="/api"
      fetch={props.fetch}
    />
  );
}

/** Sign in through the real form, as a person does after being put here. */
async function signInAgain(view: Mounted): Promise<void> {
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'whatever-it-is');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
  await settle();
}

const SIGNED_IN = { 'ops-astro.session': JSON.stringify(SESSION) };

describe('a session the API will not vouch for any more', () => {
  it('a read refused AUTH_UNKNOWN_LOGIN lands on sign-in, says so, and comes back', async () => {
    const api = server({ reads: 'ended' });
    const store = storage(SIGNED_IN);
    const sessions = new SessionStore(store.like);
    const seen: string[] = [];
    const view = await mount(
      <Harness start="/task/TSK-1" sessions={sessions} fetch={api.fetch} seen={seen} />,
    );
    await settle();
    await settle();

    // The notice, in the words the API's ignorance permits.
    const notice = view.find('[data-reason="session-ended"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status');
    expect(view.text()).toContain('AUTH_UNKNOWN_LOGIN');
    expect(view.text()).toContain('was not saved');
    expect(view.text()).not.toContain('expired');
    expect(view.find('#signin-email')).not.toBeNull();

    // The session is gone from memory and from storage, not merely unused.
    expect(sessions.session).toBeNull();
    expect(store.held.get('ops-astro.session')).toBeUndefined();
    expect(seen).toContain('/sign-in');

    await signInAgain(view);

    // Back where they were, on the address they had open.
    expect(seen.at(-1)).toBe('/task/TSK-1');
    expect(view.find('[data-reason="session-ended"]')).toBeNull();
    expect(view.text()).toContain('Wire the board to the API');
    // Used once and not kept: a later ordinary sign-in must not be redirected.
    expect([...store.held.keys()].some((key) => key.includes('return'))).toBe(false);
    await view.unmount();
  });

  it('a mutation refused AUTH_UNKNOWN_LOGIN does the same, from the task screen', async () => {
    const api = server();
    const store = storage(SIGNED_IN);
    const sessions = new SessionStore(store.like);
    const seen: string[] = [];
    const view = await mount(
      <Harness start="/task/TSK-1" sessions={sessions} fetch={api.fetch} seen={seen} />,
    );
    await settle();
    await settle();
    expect(view.text()).toContain('Wire the board to the API');

    // The hour runs out between the read and the write, which is the ordinary
    // way a person meets this: the page was drawn, the button was pressed.
    api.endTheSessionOnMutationsOnly();
    await view.click('button[data-lifecycle="complete"]');
    await settle();
    await settle();

    expect(view.find('[data-reason="session-ended"]')).not.toBeNull();
    expect(view.text()).toContain('AUTH_UNKNOWN_LOGIN');
    expect(sessions.session).toBeNull();
    expect(store.held.get('ops-astro.session')).toBeUndefined();

    await signInAgain(view);
    expect(seen.at(-1)).toBe('/task/TSK-1');
    expect(view.text()).toContain('Wire the board to the API');
    await view.unmount();
  });

  it('an ordinary denial is drawn as a denial and signs nobody out', async () => {
    const api = server({ reads: 'scope' });
    const store = storage(SIGNED_IN);
    const sessions = new SessionStore(store.like);
    const seen: string[] = [];
    const view = await mount(
      <Harness start="/projects/" sessions={sessions} fetch={api.fetch} seen={seen} />,
    );
    await settle();
    await settle();

    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(view.find('[data-reason="session-ended"]')).toBeNull();
    expect(view.find('#signin-email')).toBeNull();
    expect(sessions.session).not.toBeNull();
    expect(store.held.get('ops-astro.session')).toBeDefined();
    expect(seen).not.toContain('/sign-in');
    await view.unmount();
  });
});
