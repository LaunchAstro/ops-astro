// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// U113 (MP-5-6, CS-5.6, CS-5.8): the Projects board's column widths are the
// person's own `columns.widths` preference. A resize saves them, a reload
// draws them, Reset columns clears them, a refused save is said, and a late
// read never undoes a newer choice or another person's board.

import { act } from 'react';
import { beforeEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { admitsPreference } from '../../packages/core-records/src/preferences/store.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { task } from './task-page-stub.tsx';

const row = {
  ...task(),
  actualMinutes: 0,
  estimateMinutes: null,
  statePosition: null,
  waitReason: null,
  awaitingDecision: false,
  agent: null,
  myAgents: [],
  comments: { client: 0, mentions: 0, latest: null },
};
type Body = Readonly<Record<string, unknown>>;

/** The store's own rule refuses a value, as the server does. */
function saveAnswer(body: Body, fail: boolean, keep: () => void): Response {
  if (!admitsPreference(String(body['preference']), body['value'])) {
    const fixes = ['columns.widths maps at most 64 column ids.'];
    return Response.json(
      { refused: true, code: 'FIELD_VALUE_INVALID', names: ['value'], fixes },
      { status: 422 },
    );
  }
  if (fail) return new Response(null, { status: 503 });
  keep();
  return Response.json({ recordId: null, revision: null, detail: {} });
}

/** One person's server; with `delayed`, each preference read waits to be answered. */
function server(initial: Body = {}, delayed = false) {
  let persisted = initial;
  let fail = false;
  const saves: Body[] = [];
  const reads: (() => void)[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = new URL(String(url), 'http://test').pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    if (path.endsWith('/preference/read')) {
      const snapshot = persisted;
      return delayed
        ? new Promise<Response>((resolve) => {
            reads.push(() => resolve(Response.json({ preferences: snapshot })));
          })
        : Promise.resolve(Response.json({ preferences: persisted }));
    }
    if (path.endsWith('/preference/save')) {
      saves.push(body);
      return Promise.resolve(
        saveAnswer(body, fail, () => {
          persisted = { ...persisted, [String(body['preference'])]: body['value'] };
        }),
      );
    }
    const value = path.endsWith('/task/board')
      ? { ok: true, viewer: null, tasks: [row] }
      : path.endsWith('/person/list')
        ? { ok: true, persons: [] }
        : path.endsWith('/client/list')
          ? { ok: true, clients: [] }
          : path.endsWith('/inbox/read')
            ? { ok: true, inbox: [] }
            : { ok: true, owed: 0 };
    return Promise.resolve(Response.json(value));
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    saves,
    reads,
    persisted: () => persisted,
    failing: (next: boolean) => {
      fail = next;
    },
  };
}

const page = (client: OperationsClient, grantKey = 'alpha:ada') => (
  <Projects client={client} grantKey={grantKey} navigate={() => {}} />
);
const layout = (view: Mounted) =>
  view.all('table.cbd__tbl col').map((column) => column.getAttribute('style'));

/** One arrow press on the Name column's grip: a resize (CS-5.8). */
async function resize(view: Mounted) {
  const grip = view.find('[data-grip="name"]');
  if (grip === null) throw new Error('Missing Name column grip');
  await act(() =>
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  await settle();
}

/** What three resizes save, to store before a test begins. */
async function resizedWidths(): Promise<Body> {
  const api = server();
  const view = await mount(page(api.client));
  await settle();
  await resize(view);
  await resize(view);
  await resize(view);
  await view.unmount();
  return api.persisted();
}

beforeEach(() => {
  window.history.replaceState(null, '', '/projects/');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
});

it('Core06-1 a resize saves bounded widths, a reload draws them and Reset columns restores the defaults', async () => {
  const api = server({ 'columns.widths': { 'other.name': 401 } });
  const view = await mount(page(api.client));
  await settle();
  const defaults = layout(view);
  expect(api.saves).toStrictEqual([]);

  await resize(view);
  expect(api.saves).toHaveLength(1);
  expect(api.saves[0]).toMatchObject({ preference: 'columns.widths' });
  const saved = api.saves[0]?.['value'];
  // Another board's width is kept; this board's are whole pixels the store admits.
  expect(saved).toMatchObject({ 'other.name': 401 });
  expect(admitsPreference('columns.widths', saved)).toBe(true);
  expect(Object.keys(saved as Body).some((key) => key.startsWith('projects.'))).toBe(true);
  const changed = layout(view);
  expect(changed).not.toEqual(defaults);
  await view.unmount();

  const reopened = await mount(page(api.client));
  await settle();
  expect(layout(reopened)).toEqual(changed);
  // Drawing the stored widths saves nothing.
  expect(api.saves).toHaveLength(1);

  await reopened.click('[data-reset]');
  await settle();
  expect(api.saves).toHaveLength(2);
  expect(api.saves[1]?.['value']).toStrictEqual({ 'other.name': 401 });
  expect(layout(reopened)).toEqual(defaults);
  await reopened.unmount();

  const reset = await mount(page(api.client));
  await settle();
  expect(layout(reset)).toEqual(defaults);
});

it('Core06-3 a resize made before the read answers is kept over the older stored widths', async () => {
  const stored = await resizedWidths();
  const api = server(stored, true);
  const view = await mount(page(api.client));
  await settle();
  await resize(view);
  const chosen = layout(view);
  expect(api.saves).toHaveLength(1);
  expect(api.saves[0]?.['value']).not.toStrictEqual(stored['columns.widths']);
  await act(() => {
    for (const answer of api.reads.splice(0)) answer();
  });
  await settle();
  expect(layout(view)).toEqual(chosen);
  expect(api.saves).toHaveLength(1);
});

it('Core06-3 a refused resize is said, and the stored widths are drawn again', async () => {
  const full = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`other.column${String(index)}`, 400]),
  );
  const api = server({ 'columns.widths': full });
  const view = await mount(page(api.client));
  await settle();
  const before = layout(view);
  await resize(view);
  await settle();
  expect(api.saves).toHaveLength(1);
  expect(api.persisted()).toStrictEqual({ 'columns.widths': full });
  expect(view.find('[data-board-refusal]')?.textContent).toContain('at most 64 column ids');
  expect(layout(view)).toEqual(before);
});

it('Core06-3 a failed read keeps the default widths and says nothing', async () => {
  const fetch: typeof globalThis.fetch = (url) =>
    Promise.resolve(
      String(url).endsWith('/preference/read')
        ? new Response(null, { status: 503 })
        : Response.json(
            String(url).endsWith('/task/board')
              ? { ok: true, viewer: null, tasks: [row] }
              : { ok: true, persons: [], clients: [], inbox: [], owed: 0 },
          ),
    );
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const reference = server();
  const drawn = await mount(page(reference.client));
  await settle();
  const defaults = layout(drawn);
  await drawn.unmount();

  const view = await mount(page(client));
  await settle();
  expect(layout(view)).toEqual(defaults);
  expect(view.find('[data-board-refusal]')).toBeNull();
});

it('Core06-4 another person signed in never draws the first person’s late widths', async () => {
  const ada = server(await resizedWidths(), true);
  const view = await mount(page(ada.client));
  await settle();
  const ben = server();
  await view.render(page(ben.client, 'alpha:ben'));
  await settle();
  const defaults = layout(view);
  await act(() => {
    for (const answer of ada.reads.splice(0)) answer();
  });
  await settle();
  expect(layout(view)).toEqual(defaults);
  await resize(view);
  expect(ada.saves).toStrictEqual([]);
  expect(ben.saves).toHaveLength(1);
});

it('Core06-3 widths that answer late leave an open rename editor and its focus alone', async () => {
  const api = server(await resizedWidths(), true);
  const view = await mount(page(api.client));
  await settle();
  const name = view.find('.cbd__nm');
  if (name === null) throw new Error('Missing task name');
  await act(() => name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
  await view.type('input.cbd__rename', 'An unsent local name');
  const input = view.find('input.cbd__rename');
  if (!(input instanceof HTMLInputElement)) throw new Error('Missing rename input');
  input.focus();
  const before = layout(view);
  await act(() => api.reads[0]?.());
  await settle();
  expect(layout(view)).not.toEqual(before);
  expect(view.find('input.cbd__rename')).toBe(input);
  expect(input.value).toBe('An unsent local name');
  expect(document.activeElement).toBe(input);
  expect(api.saves).toStrictEqual([]);
});
