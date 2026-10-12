// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Where the window cannot hold three panels the lowest-ranked one closes
// (R39). A Task panel whose draft is still waiting on its Create refuses that
// close, so the dock must settle another way: the next panel down closes in
// its place, once, and the draft is drawn again without mounting over and over.
//
// Driven through the real application, against a server that holds the
// create until the test is over.

import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';

afterEach(async () => {
  await unmountAll();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const TASK = '.dpanel[data-panel-id="task"]';
const DOOR = '#perspective-panel-team [data-panel-door="log"]';

function storage(seed: Record<string, string>): StorageLike {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
}

/** A server whose top-level `task.create` never answers; every read names its task by key. */
const fetch = ((url: string | URL, init?: RequestInit) => {
  const where = String(url);
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
    string,
    unknown
  >;
  if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
  if (where.endsWith('/task/queue')) {
    return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
  }
  if (/\/live(\/task\/|\?|$)/u.test(where)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  if (where.endsWith('/task/read')) {
    const key = String(body['recordId']);
    return Promise.resolve(json({ ok: true, task: task({ key, title: `Title of ${key}` }) }));
  }
  if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
  if (where.endsWith('/task/create') && body['parentId'] === undefined) {
    return new Promise<Response>(() => {});
  }
  return Promise.resolve(json({ ok: false }));
}) as unknown as typeof globalThis.fetch;

const width = (value: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
};

const drawn = (view: Awaited<ReturnType<typeof mount>>): readonly (string | undefined)[] =>
  view.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);

/** At 1700, Team and Clients beside a draft whose Create is out. */
async function creatingBesideTwo() {
  width(1700);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const view = await mount(
    <App
      path="/task/Proj-Verity-Pacing"
      navigate={() => {}}
      sessions={new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }))}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={tabStorage()}
    />,
  );
  await tick();
  await view.click(DOOR);
  await tick();
  for (const id of ['team', 'clients']) {
    const tab = view.find(`.dock__tab[data-panel="${id}"]`);
    // eslint-disable-next-line no-await-in-loop -- one shift press at a time
    await act(async () => {
      tab?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
      );
      await Promise.resolve();
    });
  }
  await view.click(`${TASK} [data-panel-head="new"]`);
  await tick();
  await typeInto(view, '#panel-draft-name', 'New brief');
  await view.click('[data-draft="create"]');
  await tick();
  expect(drawn(view)).toEqual(['team', 'clients', 'task']);
  return view;
}

it('narrowing the window while a draft waits on Create closes the next panel once and keeps the draft', async () => {
  const view = await creatingBesideTwo();
  // Each mount of the draft focuses its name. A looping dock mounts it until
  // React stops the loop (maximum update depth).
  const focus = HTMLInputElement.prototype.focus;
  let mounts = 0;
  vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) {
    if (this.id === 'panel-draft-name') mounts += 1;
    focus.call(this);
  });
  await act(async () => {
    width(1280);
    window.dispatchEvent(new Event('resize'));
    await Promise.resolve();
  });
  await tick();

  expect(mounts, 'the draft is drawn again at most once').toBeLessThanOrEqual(1);
  expect(drawn(view)).toEqual(['team', 'task']);
  expect((view.find('#panel-draft-name') as HTMLInputElement | null)?.value).toBe('New brief');
  expect(view.find('.dock__stamp')?.textContent).toBe(
    'Clients closed: three panels do not fit at this width.',
  );
});
