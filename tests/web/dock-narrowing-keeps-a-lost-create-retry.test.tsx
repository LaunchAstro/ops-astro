// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A narrowing window that finds a draft's Create out closes the next panel
// down instead of the draft (R39). When that Create's answer is then lost,
// the draft is still drawn, the dock closes nothing more, and the retry is
// the same intent: it carries the first send's operation id.
//
// Driven through the real application, against a server whose first
// top-level `task.create` waits for the case and then loses its answer.

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

type Body = Record<string, unknown>;

/** Every top-level Create waits; `lose` drops the first one's answer on the wire. */
function server() {
  const creates: Body[] = [];
  const waiting: ((lost: Error) => void)[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
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
      creates.push(body);
      return new Promise<Response>((_, reject) => {
        waiting.push(reject);
      });
    }
    return Promise.resolve(json({ ok: false }));
  }) as unknown as typeof globalThis.fetch;
  const lose = async (): Promise<void> => {
    await act(async () => {
      waiting.shift()?.(new TypeError('Failed to fetch'));
      await Promise.resolve();
    });
    await tick();
  };
  return { fetch, creates, lose };
}

const width = (value: number): void => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value });
};

const drawn = (view: Awaited<ReturnType<typeof mount>>): readonly (string | undefined)[] =>
  view.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);

const besideTab = async (view: Awaited<ReturnType<typeof mount>>, id: string): Promise<void> => {
  const tab = view.find(`.dock__tab[data-panel="${id}"]`);
  await act(async () => {
    tab?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
    );
    await Promise.resolve();
  });
};

/** At 1700, Team and Clients beside a draft whose Create is out. */
async function creatingBesideTwo(fetch: typeof globalThis.fetch) {
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
  await besideTab(view, 'team');
  await besideTab(view, 'clients');
  await view.click(`${TASK} [data-panel-head="new"]`);
  await tick();
  await typeInto(view, '#panel-draft-name', 'New brief');
  await view.click('[data-draft="create"]');
  await tick();
  expect(drawn(view)).toEqual(['team', 'clients', 'task']);
  return view;
}

it('a Create lost after the narrowing keeps the draft and the dock, and its retry reuses the operation id', async () => {
  const api = server();
  const view = await creatingBesideTwo(api.fetch);
  await act(async () => {
    width(1280);
    window.dispatchEvent(new Event('resize'));
    await Promise.resolve();
  });
  await tick();
  expect(drawn(view)).toEqual(['team', 'task']);

  await api.lose();
  expect(drawn(view), 'a lost answer closes nothing more').toEqual(['team', 'task']);
  expect((view.find('#panel-draft-name') as HTMLInputElement | null)?.value).toBe('New brief');

  await view.click('[data-draft="create"]');
  await tick();
  expect(api.creates).toHaveLength(2);
  expect(typeof api.creates[0]?.['operationId']).toBe('string');
  expect(api.creates[1]?.['operationId']).toBe(api.creates[0]?.['operationId']);
  expect(drawn(view)).toEqual(['team', 'task']);
});
