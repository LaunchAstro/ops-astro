// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The session-end group (review #305 rows 19 and 22, ruling ORCH57 14:30:27Z):
// the new-task draft and the open task panel belong to one person in one
// business for one signed-in session. Signing out, the session ending,
// switching business and another person signing in each drop both: the draft
// leaves the tab's storage and the panel closes. A draft key for another person
// or business is removed, never read. Kept for its person (DN-04) still holds
// inside their own session, a reload included.
//
// Driven through the real application, against a stand-in API where Alpha and
// Bravo each hold an unrelated task with the same key, TSK-1.

import { act, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { task } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { settle } from './mp-2-1-support.tsx';

afterEach(async () => {
  await unmountAll();
  window.sessionStorage.clear();
});

const TITLES: Readonly<Record<string, string>> = {
  alpha: 'Alpha launch brief',
  bravo: 'Bravo unrelated task',
};
const CANARY = 'alpha-draft-canary';
const MIA = { businessKey: 'alpha', email: 'mia@alpha.local' };
const DRAFT_PREFIX = 'ops-astro.task-draft.';

const silent = (): Promise<Response> =>
  new Promise<Response>(() => {
    /* never answers */
  });

/** Alpha and Bravo, each with its own TSK-1; every business call refused once `end` is called. */
function server() {
  let ended = false;
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
      return json({ ok: true, task: task({ key: 'TSK-1', title: TITLES[business] }) });
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
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(String(url)))) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    end: (): void => {
      ended = true;
    },
  };
}

const addressBar = { go: (_path: string): void => undefined };

/** The application on the tab's real storage, as `main.tsx` composes it. */
async function open(address: string, seed: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(seed)) window.sessionStorage.setItem(key, value);
  const api = server();
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
    const { view, sessions } = await open('/sign-in', held);
    await signIn(view, MIA.email, 'alpha');
    await go('/task/TSK-1');
    await workInProgress(view);
    await go('/projects/');
    await view.click('[data-switch="held-address"]');
    await settle();
    expect(sessions.session?.businessKey).toBe('bravo');
    expect(view.text()).toContain(TITLES['bravo']);
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(view.find('[data-draft-panel]')).toBeNull();
    expect(draftKeys()).toStrictEqual([]);
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
