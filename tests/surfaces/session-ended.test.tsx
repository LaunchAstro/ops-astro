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
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { SESSION_PATH } from '../../packages/core-wire/src/index.ts';
import { mount, settle, type Mounted } from './mount.tsx';
import { TEST_ONLY_MARKER } from '../support/marker.ts';

const SESSION = { businessKey: 'alpha', email: 'mia@alpha.local' };
/** The token the tab's session cookie held when the test starts: an hour old. */
const OLD_TOKEN = `${TEST_ONLY_MARKER}-the-hour-old-token`;
/** What the stand-in identity provider hands back on a fresh sign-in. */
const FRESH_TOKEN = `${TEST_ONLY_MARKER}-a-fresh-token`;

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
  // The board row's fields (MP-5-8): this stub answers task.board too.
  board: null,
  rank: { number: null, score: null, calc: '' },
  adHoc: false,
  clientAccess: false,
  stage: null,
  clientSet: false,
  steps: [],
  time: null,
  // `task.read` carries the task's comments. This stub is not about them, so
  // the list is the empty one the read gives a task nobody has spoken on — an
  // absent key would be a shape the API never sends.
  comments: [],
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

/** The frame's reads on every screen: C23's name, and MP-2-11's appearance (none stored). */
const FRAME: Readonly<Record<string, unknown>> = {
  '/session/person': { ok: true, person: { name: 'Mia Hart' } },
  '/preference/read': { ok: true, preferences: {} },
};
const frame = (at: string): Promise<Response> | undefined => {
  const end = Object.keys(FRAME).find((path) => at.endsWith(path));
  return end === undefined ? undefined : Promise.resolve(json(FRAME[end]));
};

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

  const fetch = ((url: string | URL) => {
    const at = String(url);
    // The task page also reads its run (T2g); none here.
    if (at.endsWith('/task/execution'))
      return json({ ok: true, execution: { outcome: 'no-run', runs: [], events: [] } });
    // T3e2: the task page reads the team's outage reports; none here.
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    // The inbox the board screen mounts (INB-1g), answered empty.
    if (at.endsWith('/inbox/read')) return Response.json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return Response.json({ ok: true, owed: 0 });
    if (at.startsWith('http://identity.invalid/token')) {
      // A new hour. Everything the old token could not do, the new one can.
      reads = 'ok';
      mutations = 'ok';
      return Promise.resolve(json({ access_token: 'ops-astro-test-only-a-fresh-token' }));
    }
    const framed = frame(at);
    if (framed !== undefined) return framed;
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: PEOPLE }));
    if (at.endsWith('/task/read') || at.endsWith('/task/board')) {
      if (reads === 'ended') return Promise.resolve(unknownLogin());
      if (reads === 'scope') return Promise.resolve(scopeDenied());
      return Promise.resolve(
        at.endsWith('/task/read')
          ? json({ ok: true, task: TASK })
          : json({ ok: true, tasks: [TASK] }),
      );
    }
    // Every mutation: create, assign, the three lifecycle commands, update.
    if (mutations === 'ended') return Promise.resolve(unknownLogin());
    return Promise.resolve(json({ recordId: TASK.id, revision: TASK.revision + 1 }));
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
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
      apiOrigin=""
      fetch={props.fetch}
      storage={tabStorage()}
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
});

describe('a session the API will not vouch for any more', () => {
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
});

describe('a session the API will not vouch for any more', () => {
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

// A server that judges every call by the bearer it actually carried, rather
// than by a flag the test flips. That is the whole of this group: two requests
// leave on the old token, and the second one comes back after the person has
// already signed in again. A stand-in that answered "the session has ended"
// globally could not tell the two sessions apart and so could not show the
// defect at all.
// eslint-disable-next-line max-lines-per-function -- one stand-in, read top to bottom
function byBearer(): {
  readonly fetch: typeof globalThis.fetch;
  /** Answer the old-token read that is still in flight. */
  readonly deliverTheDelayedRefusal: () => void;
  /** The token the session cookie holds now. */
  readonly cookie: () => string;
} {
  let deliver: ((response: Response) => void) | null = null;
  // The browser's cookie jar: the session cookie each call carries is the one
  // held when it left, and signing in again replaces it (S0-6c).
  let cookie = OLD_TOKEN;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    // The task page also reads its run (T2g); none here.
    if (at.endsWith('/task/execution'))
      return json({ ok: true, execution: { outcome: 'no-run', runs: [], events: [] } });
    // T3e2: the task page reads the team's outage reports; none here.
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    // The inbox the board screen mounts (INB-1g), answered empty.
    if (at.endsWith('/inbox/read')) return Response.json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return Response.json({ ok: true, owed: 0 });
    if (at.startsWith('http://identity.invalid/token'))
      return Promise.resolve(json({ access_token: FRESH_TOKEN }));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (at === SESSION_PATH) {
      cookie = headers['authorization']?.replace('Bearer ', '') ?? '';
      return Promise.resolve(json({ ok: true }));
    }
    const stale = cookie === OLD_TOKEN;

    // The frame's reads (C23's name, MP-2-11's appearance) answer on either cookie.
    const framed = frame(at);
    if (framed !== undefined) return framed;
    if (at.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: TASK }));
    if (at.endsWith('/person/list')) {
      // The old token's people read never comes back on its own. The test
      // holds it, signs in again, and only then lets the 401 arrive.
      if (!stale) return Promise.resolve(json({ ok: true, persons: PEOPLE }));
      return Promise.resolve(
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
      );
    }
    return Promise.resolve(
      stale ? unknownLogin() : json({ recordId: TASK.id, revision: TASK.revision + 1 }),
    );
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    cookie: () => cookie,
    deliverTheDelayedRefusal: () => {
      if (deliver === null) throw new Error('no old-token read was in flight');
      deliver(unknownLogin());
    },
  };
}

describe('a refusal that belongs to a session which is already over', () => {
  it('does not end the session that replaced it', async () => {
    const api = byBearer();
    const store = storage(SIGNED_IN);
    const sessions = new SessionStore(store.like);
    const seen: string[] = [];
    const view = await mount(
      <Harness start="/task/TSK-1" sessions={sessions} fetch={api.fetch} seen={seen} />,
    );
    await settle();
    await settle();
    // Two calls are now out on the hour-old token: the task read, answered,
    // and the people read, which the stand-in is holding.
    expect(view.text()).toContain('Wire the board to the API');

    // The first refusal: the mutation. This is the one that puts the person on
    // sign-in, and it is correct.
    await view.click('button[data-lifecycle="complete"]');
    await settle();
    await settle();
    expect(view.find('[data-reason="session-ended"]')).not.toBeNull();
    expect(sessions.session).toBeNull();

    await signInAgain(view);
    expect(sessions.session).not.toBeNull();
    expect(api.cookie()).toBe(FRESH_TOKEN);
    expect(seen.at(-1)).toBe('/task/TSK-1');
    expect(view.text()).toContain('Wire the board to the API');

    // And now the hour-old people read is answered, long after the token it
    // carried stopped being anybody's session.
    api.deliverTheDelayedRefusal();
    await settle();
    await settle();

    // The new session is untouched: in memory, in storage, on the screen, and
    // at the address the person was returned to.
    expect(sessions.session).not.toBeNull();
    expect(api.cookie()).toBe(FRESH_TOKEN);
    expect(store.held.get('ops-astro.session')).toBeDefined();
    expect(view.find('[data-reason="session-ended"]')).toBeNull();
    expect(view.find('#signin-email')).toBeNull();
    expect(view.text()).toContain('Wire the board to the API');
    expect(seen.at(-1)).toBe('/task/TSK-1');
    // Nothing was remembered to return to, because nothing was interrupted.
    expect([...store.held.keys()].some((key) => key.includes('return'))).toBe(false);
    await view.unmount();
  });
});

// A task address is `/task/<key>`, and the key is business-local: the business
// is not in the address at all, it is what the client puts in the path prefix.
// So the same address means one record in Bravo and a different one in Alpha,
// and this stand-in gives each business its own task with the same key --
// which is the only way a test can tell "returned to where I was" apart from
// "returned to a string that resolved to something else".
const BRAVO = { businessKey: 'bravo', email: 'bea@bravo.local' };

function perBusiness(): typeof globalThis.fetch {
  let cookie = OLD_TOKEN;
  return ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    // The task page also reads its run (T2g); none here.
    if (at.endsWith('/task/execution'))
      return json({ ok: true, execution: { outcome: 'no-run', runs: [], events: [] } });
    // T3e2: the task page reads the team's outage reports; none here.
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    // The inbox the board screen mounts (INB-1g), answered empty.
    if (at.endsWith('/inbox/read')) return Response.json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return Response.json({ ok: true, owed: 0 });
    if (at.startsWith('http://identity.invalid/token'))
      return Promise.resolve(json({ access_token: FRESH_TOKEN }));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (at === SESSION_PATH) {
      cookie = headers['authorization']?.replace('Bearer ', '') ?? '';
      return Promise.resolve(json({ ok: true }));
    }
    if (cookie === OLD_TOKEN) return Promise.resolve(unknownLogin());

    const business = /\/b\/([^/]+)\//u.exec(at)?.[1] ?? '?';
    const task = { ...TASK, title: `The ${business} task called TSK-1` };
    const framed = frame(at);
    if (framed !== undefined) return framed;
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: PEOPLE }));
    if (at.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task }));
    if (at.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [task] }));
    return Promise.resolve(json({ recordId: TASK.id, revision: TASK.revision + 1 }));
  }) as unknown as typeof globalThis.fetch;
}

/** Interrupted in Bravo, and the tab is reloaded on the sign-in screen. */
async function interruptedInBravo(): Promise<{
  readonly store: ReturnType<typeof storage>;
  readonly seen: string[];
  readonly view: Mounted;
  readonly sessions: SessionStore;
}> {
  const fetch = perBusiness();
  const store = storage({ 'ops-astro.session': JSON.stringify(BRAVO) });
  const first = new SessionStore(store.like);
  const opened = await mount(
    <Harness start="/task/TSK-1" sessions={first} fetch={fetch} seen={[]} />,
  );
  await settle();
  await settle();
  expect(opened.find('[data-reason="session-ended"]')).not.toBeNull();
  await opened.unmount();

  // The reload. Nothing survives it but what is in session storage, which is
  // where the interruption has to carry the business if it carries it at all.
  const sessions = new SessionStore(store.like);
  const seen: string[] = [];
  const view = await mount(
    <Harness start="/sign-in" sessions={sessions} fetch={fetch} seen={seen} />,
  );
  await settle();
  return { store, seen, view, sessions };
}

describe('the business an interrupted address belonged to', () => {
  it('is what sign-in comes back offering, and where the return address leads', async () => {
    const { seen, view, sessions } = await interruptedInBravo();

    // The form is asking again for the business the person was working in,
    // not for the one that happens to be first in the list.
    expect((view.find('#signin-business') as HTMLSelectElement | null)?.value).toBe('bravo');

    await signInAgain(view);
    expect(sessions.session?.businessKey).toBe('bravo');
    expect(seen.at(-1)).toBe('/task/TSK-1');
    expect(view.text()).toContain('The bravo task called TSK-1');
    await view.unmount();
  });

  it('is not assumed: choosing another business does not reopen the address there', async () => {
    const { seen, view, sessions } = await interruptedInBravo();

    // The person deliberately signs in to Alpha instead. Alpha has a task
    // under the very same key, so an application that simply replayed the
    // remembered string would draw an unrelated record and call it the one
    // it promised to bring them back to.
    await view.choose('#signin-business', 'alpha');
    await signInAgain(view);

    expect(sessions.session?.businessKey).toBe('alpha');
    expect(seen.at(-1)).toBe('/projects/');
    expect(view.text()).not.toContain('The bravo task called TSK-1');

    const notice = view.find('[data-notice="other-business"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toContain('bravo');
    expect(notice?.textContent).toContain('alpha');
    await view.unmount();
  });
});
