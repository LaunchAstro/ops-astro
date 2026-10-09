// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft's Create in flight, in the dock (review #305 row 17,
// A11-1, carried to 2d's dock). 2c1 held the draft while Create is out: its
// own Close waits, Escape inside it waits, and a door on the page waits. In
// the dock the draft draws no Close of its own; the dock's X, Close all and
// Escape close the task panel instead. Each of them waits for Create too, so
// the draft cannot be left, reopened from storage and created a second time
// under a new operation id. When Create lands, the new task opens in the
// dock's Task panel.
//
// Driven through the real application, against a server that holds the
// create until the test answers it.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';

afterEach(async () => {
  await unmountAll();
  window.sessionStorage.clear();
});

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const TASK = '.dpanel[data-panel-id="task"]';
const TAB = '.dock__tab[data-panel="task"]';
const DOOR = '#perspective-panel-team [data-panel-door="log"]';
const NEW_KEY = 'Proj-New-Brief';
const CREATED_ID = '99999999-9999-4999-8999-999999999999';
const CREATED = { recordId: CREATED_ID, revision: 1, detail: { key: NEW_KEY } };

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

/** A server whose top-level `task.create` waits for `land`; every read names its task by key. */
function server() {
  const creates: string[] = [];
  let land: (() => void) | null = null;
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
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (/\/live(\/task\/|\?|$)/u.test(where)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (where.endsWith('/task/read')) {
      const key = String(body['recordId']);
      return Promise.resolve(json({ ok: true, task: task({ key, title: `Title of ${key}` }) }));
    }
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/task/create') && body['parentId'] === undefined) {
      creates.push(String(body['operationId']));
      return new Promise<Response>((done) => {
        land = () => {
          done(json(CREATED));
        };
      });
    }
    return Promise.resolve(json({ ok: false }));
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    creates,
    land: async (): Promise<void> => {
      await act(async () => {
        land?.();
        await Promise.resolve();
      });
      for (let round = 0; round < 6; round += 1) {
        // eslint-disable-next-line no-await-in-loop -- one settle at a time
        await tick();
      }
    },
  };
}

const escape = async (): Promise<void> => {
  await act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await tick();
};

/** The application with a draft named and its Create pressed, the create still out. */
async function createInFlight(api: ReturnType<typeof server>, went: string[] = []) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const view = await mount(
    <App
      path="/task/Proj-Verity-Pacing"
      navigate={(to) => {
        went.push(to);
      }}
      sessions={new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }))}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={api.fetch}
      storage={tabStorage()}
    />,
  );
  await tick();
  await view.click(DOOR);
  await tick();
  await view.click(`${TASK} [data-panel-head="new"]`);
  await tick();
  await typeInto(view, '#panel-draft-name', 'New brief');
  await view.click('[data-draft="create"]');
  await tick();
  expect(api.creates).toHaveLength(1);
  return view;
}

describe('A11-1 in the dock: the draft is not left while Create is in flight', () => {
  it("the dock's X waits for Create; the draft stays in the Task panel", async () => {
    const api = server();
    const view = await createInFlight(api);
    await view.click(`${TASK} [data-act="close"]`);
    await tick();
    expect(view.find(`${TASK} [data-draft-panel]`)).not.toBeNull();
    expect(view.host.querySelector(TAB)).not.toBeNull();
  });

  it('Escape and Close all wait for Create; one create, and the new task opens', async () => {
    const api = server();
    const view = await createInFlight(api);
    await escape();
    expect(view.find(`${TASK} [data-draft-panel]`)).not.toBeNull();
    await view.click('.dock__closeall');
    await tick();
    expect(view.find(`${TASK} [data-draft-panel]`)).not.toBeNull();
    await api.land();
    expect(api.creates).toHaveLength(1);
    expect(view.find(`${TASK} [data-draft-panel]`)).toBeNull();
    expect(view.find(`${TASK} [data-task-panel] [data-panel-title]`)?.textContent).toBe(
      `Title of ${NEW_KEY}`,
    );
  });

  it("once Create has landed, the dock's X closes the panel as before", async () => {
    const api = server();
    const view = await createInFlight(api);
    await api.land();
    await view.click(`${TASK} [data-act="close"]`);
    await tick();
    expect(view.find('[data-task-panel]')).toBeNull();
    expect(view.host.querySelector(TAB)).toBeNull();
  });
});
