// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-22: the new-task draft (MP-4-13) outlives the session.
//
// C58 says an unsaved edit is in none of the tab's stores once a session ends.
// `c58-no-draft-after-session-end.test.tsx` proves it for the task page's own
// fields but never opens the dock panel's new-task draft. The draft is kept in
// the tab's storage under the business and the person (`task-draft.ts`) and
// nothing on the session-end path drops it, so its title and note are still
// there after sign-out and after a 401 session end.
//
// Each case opens the task page, opens the dock panel, presses New task, types
// a canary into the draft's name and note, proves the draft was kept, ends the
// session, and scans localStorage, sessionStorage and the session store for
// the canary. It passes once the session-end path (sign-out and the client's
// session-ended handler) drops every person's kept draft.

import { afterEach, describe, expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const DRAFT_TITLE = 'review-2c1-22-draft-title-canary';
const DRAFT_NOTE = 'review-2c1-22-draft-note-canary';

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

/** A stand-in API: ordinary answers until `end`, then C58's 401 for every call. */
function server() {
  let ended = false;
  const answer = (at: string): Response => {
    if (ended) {
      return json({ refused: true, code: 'AUTH_SESSION_EXPIRED', names: [], fixes: [] }, 401);
    }
    if (at.endsWith('/task/execution'))
      return json({ ok: true, execution: { outcome: 'no-run', runs: [], events: [] } });
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    if (at.endsWith('/person/list'))
      return json({ ok: true, persons: [{ personId: 'p1', name: 'Mia Alpha' }] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: TASK });
    if (at.endsWith('/inbox/read')) return json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return json({ ok: true, owed: 0 });
    return json({ recordId: TASK.id, revision: TASK.revision + 1 });
  };
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(String(url)))) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    end(): void {
      ended = true;
    },
  };
}

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

const dump = (area: Storage): string =>
  Array.from({ length: area.length }, (_, i) => {
    const key = area.key(i) ?? '';
    return `${key}=${area.getItem(key) ?? ''}`;
  }).join('\n');

function everyStore(held: Map<string, string>): string {
  return [
    ...[...held].map(([key, value]) => `${key}=${value}`),
    dump(window.localStorage),
    dump(window.sessionStorage),
    document.cookie,
  ].join('\n');
}

const live: Mounted[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/** The task page, the dock panel opened from it, and its New task draft typed into. */
async function draftTyped() {
  const api = server();
  const store = storage({ 'ops-astro.session': JSON.stringify(SESSION) });
  const sessions = new SessionStore(store.like);
  const view = await mount(<Harness sessions={sessions} fetch={api.fetch} />);
  live.push(view);
  await settle();
  await settle();
  expect(view.text()).toContain(TASK.title);
  await view.click('main [data-panel-door="open"]');
  await settle();
  await settle();
  await view.click('[data-panel-head="new"]');
  await settle();
  expect(view.find('[data-draft-panel]')).not.toBeNull();
  await view.type('#panel-draft-name', DRAFT_TITLE);
  await view.type('#panel-draft-note', DRAFT_NOTE);
  // Setup proof: the draft is kept in the tab's storage before the session ends.
  const before = everyStore(store.held);
  expect(before).toContain(DRAFT_TITLE);
  expect(before).toContain(DRAFT_NOTE);
  return { view, api, store, sessions };
}

async function expectNoDraftAfterEnd(
  view: Mounted,
  store: ReturnType<typeof storage>,
  sessions: SessionStore,
): Promise<void> {
  await settle();
  await settle();
  // The session did end: the sign-in form is up and the session store is empty.
  expect(view.find('#signin-email')).not.toBeNull();
  expect(sessions.session).toBeNull();
  const stores = everyStore(store.held);
  expect(stores, 'the new-task draft title survived the session end').not.toContain(DRAFT_TITLE);
  expect(stores, 'the new-task draft note survived the session end').not.toContain(DRAFT_NOTE);
}

describe('REVIEW-2C1-22 new-task draft after session end', () => {
  it('REVIEW-2C1-22: signing out leaves the new-task draft in the tab’s storage', async () => {
    const { view, store, sessions } = await draftTyped();
    await view.click('.appbar .who__trigger');
    await view.click('.who__menu button[role="menuitem"]');
    await expectNoDraftAfterEnd(view, store, sessions);
  });

  it('REVIEW-2C1-22: a 401 session end leaves the new-task draft in the tab’s storage', async () => {
    const { view, api, store, sessions } = await draftTyped();
    api.end();
    await view.click('[data-draft="create"]');
    await expectNoDraftAfterEnd(view, store, sessions);
    expect(view.find('[data-reason="session-ended"]')).not.toBeNull();
  });
});
