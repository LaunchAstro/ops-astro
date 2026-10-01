// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-2C1-19 red proof: the dock task panel outlives the session it was
// opened in. The panel's opening is held by the application
// (apps/web/src/App.tsx, `useDockPanel`; panel-host.ts) and nothing clears it
// when the person signs out; DockPanel.tsx only stops drawing it while
// signed out, and its key names the task and the door but not the business.
// Sign in again, to another business, and the old panel is drawn there and
// reads the old business's task key under the new business's prefix. Passes
// once ending the session (or changing business) closes the panel.
//
// The stand-in API and identity provider follow
// c58-no-draft-after-session-end.test.tsx.

import { afterEach, describe, expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

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

const BOARD_ROW = {
  ...TASK,
  board: null,
  rank: { number: null, score: null, calc: '' },
  adHoc: false,
  clientAccess: false,
  stage: null,
  clientSet: false,
  steps: [],
  time: null,
  comments: { client: 0, mentions: 0, latest: null },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  readonly url: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A stand-in API and identity provider that records every call. */
function server() {
  const calls: Call[] = [];
  const answer = (at: string): Response => {
    if (at.startsWith('http://identity.invalid/token')) {
      return json({ access_token: 'a-fresh-token' });
    }
    if (at.endsWith('/task/execution'))
      return json({ ok: true, execution: { outcome: 'no-run', runs: [], events: [] } });
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    if (at.endsWith('/person/list'))
      return json({ ok: true, persons: [{ personId: 'p1', name: 'Mia Alpha' }] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: TASK });
    if (at.endsWith('/task/board')) return json({ ok: true, tasks: [BOARD_ROW] });
    if (at.endsWith('/inbox/read')) return json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return json({ ok: true, owed: 0 });
    return json({ recordId: TASK.id, revision: TASK.revision + 1 });
  };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
    } catch {
      body = {};
    }
    calls.push({ url: at, body });
    return Promise.resolve(answer(at));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function storage(seed: Record<string, string>): StorageLike {
  const held = new Map(Object.entries(seed));
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

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('REVIEW-2C1-19 the task panel and the session', () => {
  it('REVIEW-2C1-19: a task panel opened before sign-out is drawn again, and reads its old task key, in the next business signed in to', async () => {
    const api = server();
    const sessions = new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }));
    view = await mount(<Harness sessions={sessions} fetch={api.fetch} />);
    await settle();
    await settle();
    expect(view.text()).toContain(TASK.title);

    // Open the task in the dock panel from the page's door.
    await view.click('[data-panel-door="open"]');
    await settle();
    await settle();
    expect(view.find('[data-task-panel]')).not.toBeNull();

    // Sign out from the person menu.
    await view.click('.appbar .who__trigger');
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    await settle();
    expect(view.find('#signin-email')).not.toBeNull();
    expect(view.find('[data-task-panel]')).toBeNull();

    // Sign in to another business.
    const signedOutAt = api.calls.length;
    await view.choose('#signin-business', 'bravo');
    await view.type('#signin-email', 'mia@alpha.local');
    await view.type('#signin-password', 'whatever-it-is');
    await view.click('form.signin__form button[type="submit"]');
    await settle();
    await settle();
    await settle();
    expect(sessions.session?.businessKey).toBe('bravo');

    const oldKeyReads = api.calls
      .slice(signedOutAt)
      .filter(
        (call) =>
          call.url.endsWith('/task/read') &&
          call.url.includes('bravo') &&
          call.body['recordId'] === TASK.key,
      );
    expect(
      oldKeyReads.map((call) => call.url),
      'the panel from the alpha session read its task key under bravo',
    ).toStrictEqual([]);
    expect(
      view.find('[data-task-panel]'),
      'the task panel opened in alpha is drawn after signing in to bravo',
    ).toBeNull();
  });
});
