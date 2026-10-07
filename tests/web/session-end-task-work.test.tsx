// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Session-end proof through the real App and tab storage, with a stand-in API.
// Drafts and open-task pointers belong to one person in one business.
// Alpha and Bravo hold unrelated tasks with the same key, TSK-1.
// R07 also checks the display boundary for a refused client-A task read.
import { act, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { NOT_FOUND, task } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { settle } from './mp-2-1-support.tsx';
afterEach(async () => {
  await unmountAll();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});
const TITLES: Readonly<Record<string, string>> = {
  alpha: 'Alpha launch brief',
  bravo: 'Bravo unrelated task',
};
const CANARY = 'alpha-draft-canary';
const MIA = { businessKey: 'alpha', email: 'mia@alpha.local' };
const DRAFT_PREFIX = 'ops-astro.task-draft.';
const OPEN_PREFIX = 'ops-astro.task-open.';
const silent = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });
/** Alpha and Bravo, each with its own TSK-1; every business call refused once `end` is called. */
function server(taskReply?: Response) {
  let ended = false;
  const requests: { readonly to: string; readonly body: unknown }[] = [];
  const answer = (at: string): Promise<Response> | Response => {
    if (at.startsWith('http://identity.invalid/token')) {
      ended = false;
      return json({ access_token: 'fresh-token' });
    }
    if (at === '/api/session') return json({ ok: true, session: 'fresh-session' });
    if (at.endsWith('/session/person')) return json({ person: { name: 'Mia Hart' } });
    const business = /^\/api\/b\/([a-z]+)\//u.exec(at)?.[1];
    if (business === undefined) return json({ ok: true });
    if (ended) {
      return json({ refused: true, code: 'AUTH_SESSION_EXPIRED', names: [], fixes: [] }, 401);
    }
    if (at.endsWith('/task/read')) {
      return (
        taskReply?.clone() ??
        json({ ok: true, task: task({ key: 'TSK-1', title: TITLES[business] }) })
      );
    }
    if (at.endsWith('/session/capabilities')) {
      return json({ ok: true, personId: 'p', businessKey: business, grants: [] });
    }
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    if (at.endsWith('/task/board')) return json({ ok: true, tasks: [] });
    if (at.endsWith('/inbox/read')) return json({ ok: true, inbox: [] });
    if (at.endsWith('/inbox/count')) return json({ ok: true, owed: 0 });
    return silent();
  };
  const fetch: typeof globalThis.fetch = (url, init) => {
    const to = String(url);
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    requests.push({ to, body });
    return Promise.resolve(answer(to));
  };
  return {
    fetch,
    requests,
    end: (): void => {
      ended = true;
    },
  };
}
const addressBar = { go: (_path: string): void => undefined };
/** The application on the tab's real storage, as `main.tsx` composes it. */
async function open(address: string, seed: Record<string, string> = {}, api = server()) {
  for (const [key, value] of Object.entries(seed)) window.sessionStorage.setItem(key, value);
  const sessions = new SessionStore(window.sessionStorage);
  function Harness(): ReactElement {
    const [path, setPath] = useState(address);
    addressBar.go = setPath;
    return (
      <App
        path={path}
        navigate={setPath}
        sessions={sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={api.fetch}
        storage={window.sessionStorage}
      />
    );
  }
  const view = await mount(<Harness />);
  await settle();
  return { view, api, sessions };
}
type View = Awaited<ReturnType<typeof open>>['view'];
const go = async (path: string): Promise<void> => {
  await act(() => {
    addressBar.go(path);
  });
  await settle();
};
/** Every draft key the tab holds. */
const draftKeys = (): readonly string[] =>
  Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i))
    .filter((key): key is string => key?.startsWith(DRAFT_PREFIX) ?? false)
    .toSorted();
/** Open-task pointers are checked separately: removing drafts proves nothing about these. */
const openKeys = (): readonly string[] =>
  Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i))
    .filter((key): key is string => key?.startsWith(OPEN_PREFIX) ?? false)
    .toSorted();
const panelTitle = (view: View): string | null =>
  view.find('[data-task-panel] [data-panel-title]')?.textContent ?? null;
/** On the task page: a draft kept (typed, then closed) and the task panel open over it. */
async function workInProgress(view: View): Promise<void> {
  await view.click('[data-panel-door="open"]');
  await settle();
  await view.click('[data-task-panel] [data-panel-head="new"]');
  await view.type('#panel-draft-name', CANARY);
  await view.click(`.dpanel[data-panel-id="task"] [data-act="close"]`);
  await view.click('[data-panel-door="open"]');
  await settle();
  expect(panelTitle(view)).toBe(TITLES['alpha']);
  expect(draftKeys()).toStrictEqual([`${DRAFT_PREFIX}alpha:mia@alpha.local`]);
  expect(openKeys()).toStrictEqual([`${OPEN_PREFIX}alpha:mia@alpha.local`]);
  expect(
    JSON.parse(window.sessionStorage.getItem(`${OPEN_PREFIX}alpha:mia@alpha.local`) ?? 'null'),
  ).toMatchObject({ taskKey: 'TSK-1', door: 'open' });
}
async function signIn(view: View, email: string, business = 'alpha'): Promise<void> {
  await view.choose('#signin-business', business);
  await view.type('#signin-email', email);
  await view.type('#signin-password', 'whatever-it-is');
  await view.click('form.signin__form button[type="submit"]');
  await settle();
}
/** Signed out: no draft anywhere in the tab, and no panel. */
function expectNothingKept(view: View): void {
  expect(view.find('#signin-email')).not.toBeNull();
  expect(draftKeys()).toStrictEqual([]);
  expect(openKeys()).toStrictEqual([]);
  expect(view.find('[data-task-panel]')).toBeNull();
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(CANARY);
}
/** Signed in again, on the task page: no panel came back, and New task opens an empty draft. */
async function expectFreshStart(view: View): Promise<void> {
  await go('/task/TSK-1');
  expect(view.find('[data-task-panel]')).toBeNull();
  expect(view.find('[data-draft-panel]')).toBeNull();
  await view.click('[data-panel-door="open"]');
  await settle();
  await view.click('[data-task-panel] [data-panel-head="new"]');
  expect(view.host.querySelector<HTMLInputElement>('#panel-draft-name')?.value).toBe('');
  expect(view.text()).not.toContain(CANARY);
}
const signedInAsMia = { 'ops-astro.session': JSON.stringify(MIA) };
describe('session end drops the task draft and the open panel', () => {
  it('signing out drops the draft from the tab and closes the panel; signing in again starts fresh', async () => {
    const { view } = await open('/task/TSK-1', signedInAsMia);
    await workInProgress(view);
    await view.click('.appbar .who__trigger');
    await view.click('.who__menu button[role="menuitem"]');
    await settle();
    expectNothingKept(view);
    await signIn(view, MIA.email);
    await expectFreshStart(view);
  });

  it('the session ending drops the draft from the tab and closes the panel', async () => {
    const { view, api } = await open('/task/TSK-1', signedInAsMia);
    await workInProgress(view);
    api.end();
    await go('/projects/');
    expectNothingKept(view);
    await signIn(view, MIA.email);
    await expectFreshStart(view);
  });

  it('person B signing in on the same browser never sees A’s draft or open panel', async () => {
    const { view, api } = await open('/task/TSK-1', signedInAsMia);
    await workInProgress(view);
    api.end();
    await go('/projects/');
    await signIn(view, 'noah@alpha.local');
    expect(draftKeys()).toStrictEqual([]);
    expect(openKeys()).toStrictEqual([]);
    await expectFreshStart(view);
  });
});
describe('a business switch drops the task draft and the open panel', () => {
  it('switching from alpha to bravo closes the panel and never reads bravo’s TSK-1 as alpha’s', async () => {
    const held = {
      'ops-astro.return-to': JSON.stringify({
        address: '/task/TSK-1',
        businessKey: 'bravo',
        code: 'AUTH_SESSION_EXPIRED',
      }),
    };
    const { view, sessions, api } = await open('/sign-in', held);
    await signIn(view, MIA.email, 'alpha');
    await go('/task/TSK-1');
    await workInProgress(view);
    await go('/projects/');
    api.requests.length = 0;
    await view.click('[data-switch="held-address"]');
    await settle();
    expect(sessions.session?.businessKey).toBe('bravo');
    expect(view.text()).toContain(TITLES['bravo']);
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(view.find('[data-draft-panel]')).toBeNull();
    expect(draftKeys()).toStrictEqual([]);
    expect(openKeys()).toStrictEqual([]);
    expect(api.requests.filter(({ to }) => to.endsWith('/task/read'))).toEqual([
      { to: '/api/b/bravo/task/read', body: { recordId: 'TSK-1' } },
    ]);
  });
});
describe('a draft key from another person or business is removed, never read', () => {
  it('on load, another person’s and another business’s draft keys go; this person’s own is kept', async () => {
    const own = JSON.stringify({ title: 'Mia’s own draft' });
    const { view } = await open('/task/TSK-1', {
      ...signedInAsMia,
      [`${DRAFT_PREFIX}alpha:noah@alpha.local`]: JSON.stringify({ title: 'noah-canary' }),
      [`${DRAFT_PREFIX}bravo:mia@alpha.local`]: JSON.stringify({ title: 'bravo-canary' }),
      [`${DRAFT_PREFIX}alpha:mia@alpha.local`]: own,
    });
    expect(draftKeys()).toStrictEqual([`${DRAFT_PREFIX}alpha:mia@alpha.local`]);
    await view.click('[data-panel-door="open"]');
    await settle();
    await view.click('[data-task-panel] [data-panel-head="new"]');
    expect(view.host.querySelector<HTMLInputElement>('#panel-draft-name')?.value).toBe(
      'Mia’s own draft',
    );
  });
});
const ADA = { businessKey: 'alpha', email: 'ada@example.test' };
const ADA_OPEN = 'ops-astro.task-open.alpha:ada@example.test';
const KEY = 'Proj-Verity-Pacing';
const OPEN_CANARY = 'client-A-open-task-canary';
const CANARY_ID = '55555555-5555-4555-8555-555555555555';

describe('R07 own open-task pointer and client read refusal through the App', () => {
  it('Ada’s own saved pointer reloads the planted client-A task', async () => {
    const storage = window.sessionStorage;
    storage.setItem(ADA_OPEN, JSON.stringify({ taskKey: KEY, door: 'open', tab: null }));
    const api = server(
      json({
        ok: true,
        task: task({
          id: CANARY_ID,
          key: KEY,
          title: OPEN_CANARY,
          clientSet: true,
          client: { id: 'client-a', name: 'Client A' },
        }),
      }),
    );
    const { view } = await open('/projects/', { 'ops-astro.session': JSON.stringify(ADA) }, api);
    expect(view.find('[data-task-panel] [data-panel-title]')?.textContent).toBe(OPEN_CANARY);
    expect(view.host.innerHTML).toContain(CANARY_ID);
    expect(api.requests.filter(({ to }) => to.endsWith('/task/read'))).toEqual([
      { to: '/api/b/alpha/task/read', body: { recordId: KEY } },
    ]);
    expect(storage.getItem(ADA_OPEN)).not.toBeNull();
  });

  it('a client-B reader’s own saved pointer cannot display client A after the read is refused', async () => {
    const storage = window.sessionStorage;
    const session = { businessKey: 'alpha', email: 'client-b-reader@example.test' };
    const own = `ops-astro.task-open.alpha:${session.email}`;
    storage.setItem(own, JSON.stringify({ taskKey: KEY, door: 'open', tab: null }));
    const reads = vi.spyOn(Storage.prototype, 'getItem');
    const api = server(json(NOT_FOUND, 404));
    const { view } = await open(
      '/projects/',
      { 'ops-astro.session': JSON.stringify(session) },
      api,
    );
    expect(reads.mock.calls.map(([key]) => key)).toContain(own);
    expect(api.requests.filter(({ to }) => to.endsWith('/task/read'))).toEqual([
      { to: '/api/b/alpha/task/read', body: { recordId: KEY } },
    ]);
    expect(view.find('[data-task-panel]')).not.toBeNull();
    expect(view.find('[data-task-panel]')?.textContent).toContain('NOT_FOUND');
    expect(view.find('[data-task-panel] [data-panel-title]')).toBeNull();
    expect(view.text()).not.toContain(OPEN_CANARY);
    expect(view.text()).not.toContain(KEY);
    expect(view.host.innerHTML).not.toContain(CANARY_ID);
    expect(view.text()).not.toContain('Client A');
  });
});
