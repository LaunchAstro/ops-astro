// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: an unsaved edit does not survive the end of a session.
//
// A session ends three ways: the 12-hour limit, access ended by an
// administrator, and the person signing out. Each case below opens a task,
// types a title and a comment that are never saved, ends the session its way,
// and then reads every store the tab has. The edit is in none of them, the
// sign-in page says it was not saved, and signing in again draws the server's
// title, not the typing.
//
// Access ended is the one the server does not answer 401. The person's bearer
// still verifies (the provider's token lives out its hour), so the API finds a
// login with no membership left and answers 403 `AUTH_NO_MEMBERSHIP`, the same
// answer a login that never had one gets. The last case keeps the two apart: a
// login that was never a member is shown the denial and is not signed out
// (the browser's N2 row).
//
// It is a stub for the API and the identity provider, like
// `session-ended.test.tsx`; the refusals are the bodies C58's own suites pin.

import { afterEach, describe, expect, it } from 'vitest';
import { act, useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

/** The typing that must not outlive the session, in every store the tab has. */
const DRAFT_TITLE = 'c58-unsaved-title-canary';
const DRAFT_COMMENT = 'c58-unsaved-comment-canary';

const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'mia@alpha.local' };

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
  comments: [],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refusal = (code: string, status: number): Response =>
  json({ refused: true, code, names: [], fixes: [] }, status);

/** How the API answers once the session is over, per ending. */
const ENDINGS = {
  // C58: the login is deactivated and the memberships ended; the bearer still verifies.
  'access ended': () => refusal('AUTH_NO_MEMBERSHIP', 403),
  // C58's absolute limit: a bearer past it is answered as expired.
  'the 12-hour limit': () => refusal('AUTH_SESSION_EXPIRED', 401),
} as const;

type Ending = keyof typeof ENDINGS;

/** A stand-in API: ordinary answers until `end` is called, then the ending's, for every call. */
function server(options: { readonly neverAMember?: boolean } = {}) {
  let ended: Ending | null = options.neverAMember === true ? 'access ended' : null;
  const answer = (at: string): Response => {
    if (at.startsWith('http://identity.invalid/token')) {
      ended = null;
      return json({ access_token: 'a-fresh-token' });
    }
    if (ended !== null) return ENDINGS[ended]();
    if (at.endsWith('/task/execution'))
      return json({ ok: true, execution: { outcome: 'no-run', runs: [], events: [] } });
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    if (at.endsWith('/person/list'))
      return json({ ok: true, persons: [{ personId: 'p1', name: 'Mia Alpha' }] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: TASK });
    if (at.endsWith('/task/board')) return json({ ok: true, tasks: [TASK] });
    // The board's inbox above it (INB-1g) reads on its own.
    if (at.endsWith('/inbox/read')) return json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return json({ ok: true, owed: 0 });
    return json({ recordId: TASK.id, revision: TASK.revision + 1 });
  };
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(String(url)))) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    end(ending: Ending): void {
      ended = ending;
    },
  };
}

/** A storage the test can read back whole. */
function storage(seed: Record<string, string>): {
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

/** The address bar, for a case that opens an address after signing in. */
const addressBar = { go: (_path: string): void => undefined };

function Harness(props: {
  readonly sessions: SessionStore;
  readonly fetch: typeof globalThis.fetch;
}): ReactElement {
  const [path, setPath] = useState('/task/TSK-1');
  addressBar.go = setPath;
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

const dump = (area: Storage): string =>
  Array.from({ length: area.length }, (_, i) => {
    const key = area.key(i) ?? '';
    return `${key}=${area.getItem(key) ?? ''}`;
  }).join('\n');

/** Every store a signed-out tab could hold content in, as one string. */
function everyStore(held: Map<string, string>): string {
  return [
    ...[...held].map(([key, value]) => `${key}=${value}`),
    dump(window.localStorage),
    dump(window.sessionStorage),
    document.cookie,
  ].join('\n');
}

async function openMidEdit(): Promise<{
  readonly view: Mounted;
  readonly api: ReturnType<typeof server>;
  readonly store: ReturnType<typeof storage>;
  readonly sessions: SessionStore;
}> {
  const api = server();
  const store = storage({ 'ops-astro.session': JSON.stringify(SESSION) });
  const sessions = new SessionStore(store.like);
  const view = await opened(<Harness sessions={sessions} fetch={api.fetch} />);
  await settle();
  await settle();
  expect(view.text()).toContain(TASK.title);
  await view.type('#task-title', DRAFT_TITLE);
  await view.type('#comment-body', DRAFT_COMMENT);
  expect(view.find('[data-draft-resolve="choice"]')).not.toBeNull();
  return { view, api, store, sessions };
}

async function expectSignedOutWithNoDraft(
  view: Mounted,
  store: ReturnType<typeof storage>,
  sessions: SessionStore,
): Promise<void> {
  await settle();
  await settle();
  expect(view.find('#signin-email')).not.toBeNull();
  expect(view.text()).toContain('was not saved');
  expect(sessions.session).toBeNull();
  const stores = everyStore(store.held);
  expect(stores).not.toContain(DRAFT_TITLE);
  expect(stores).not.toContain(DRAFT_COMMENT);
  expect(stores).not.toContain(SESSION.token);
}

/** Sign in again: the task comes back as the server holds it, not as typed. */
async function signInAgainFindsNoDraft(view: Mounted, reopen = false): Promise<void> {
  await view.type('#signin-email', 'mia@alpha.local');
  await view.type('#signin-password', 'whatever-it-is');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
  await settle();
  // Signing out holds no address, so sign-in leads to the board: open the task again.
  if (reopen) {
    await act(() => {
      addressBar.go('/task/TSK-1');
    });
    await settle();
    await settle();
  }
  const title = view.find('#task-title') as HTMLInputElement | null;
  expect(title?.value).toBe(TASK.title);
  expect(view.text()).not.toContain(DRAFT_TITLE);
  expect((view.find('#comment-body') as HTMLTextAreaElement | null)?.value).toBe('');
}

/** Mounted views, unmounted after each case whether it passed or not. */
const live: Mounted[] = [];
async function opened(element: ReactElement): Promise<Mounted> {
  const view = await mount(element);
  live.push(view);
  return view;
}

afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('C58 no draft after session end', () => {
  it.each(Object.keys(ENDINGS) as Ending[])(
    'ended by %s mid-edit, the save is refused, the tab signs out and holds no draft',
    async (ending) => {
      const { view, api, store, sessions } = await openMidEdit();
      api.end(ending);
      await view.click('button[data-draft-resolve="save"]');
      await expectSignedOutWithNoDraft(view, store, sessions);
      expect(view.find('[data-reason="session-ended"]')).not.toBeNull();
      await signInAgainFindsNoDraft(view);
    },
  );

  it('signing out mid-edit says the edit was not saved and holds no draft', async () => {
    const { view, store, sessions } = await openMidEdit();
    // Sign-out is the person menu's since C23.
    await view.click('.appbar .who__trigger');
    await view.click('.who__menu button[role="menuitem"]');
    await expectSignedOutWithNoDraft(view, store, sessions);
    expect(view.find('[data-reason="signed-out"]')).not.toBeNull();
    await signInAgainFindsNoDraft(view, true);
  });

  it('a login that was never a member is shown the denial and is not signed out', async () => {
    const api = server({ neverAMember: true });
    const store = storage({ 'ops-astro.session': JSON.stringify(SESSION) });
    const sessions = new SessionStore(store.like);
    const view = await opened(<Harness sessions={sessions} fetch={api.fetch} />);
    await settle();
    await settle();
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).toContain('AUTH_NO_MEMBERSHIP');
    expect(view.find('#signin-email')).toBeNull();
    expect(sessions.session).not.toBeNull();
  });
});
