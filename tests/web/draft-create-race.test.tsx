// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft's Create in flight (review #305 row 17, A11-1). While
// Create is out, nothing in the application leaves the draft: Close, Escape,
// Cancel and a door on the page wait for it, so the draft cannot be reopened
// and created a second time under a new operation id. A Create that lands
// after the session changed opens nothing: it never replaces the panel the
// next session has open, and never stops that task's timer.
//
// Driven through the dock panel's own hook, against a server that holds the
// create until the test answers it.

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { Session } from '../../apps/web/src/session/token.ts';
import { useDockPanel } from '../../apps/web/src/screens/task/DockPanel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, press, unmountAll } from './perspective-support.tsx';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { NEW_ID, NEW_KEY, store, valueOf } from './draft-support.tsx';

afterEach(async () => {
  await unmountAll();
  dropOtherDrafts(null, null);
});

const ADA: Session = { businessKey: 'alpha', email: 'ada@example.test' };

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
    // The panel's Project field (SL08) reads the Projects board.
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/task/read')) {
      const key = String(body['recordId']);
      return Promise.resolve(json({ ok: true, task: task({ key, title: `Title of ${key}` }) }));
    }
    if (where.endsWith('/task/create') && body['parentId'] === undefined) {
      creates.push(String(body['operationId']));
      return new Promise<Response>((done) => {
        land = () => {
          done(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
        };
      });
    }
    // New task from a task is prefilled from it (U112): its project and category parts land.
    if (/\/task\/(?:move|set_category)$/u.test(where))
      return Promise.resolve(json({ recordId: NEW_ID, revision: 2, detail: {} }));
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    return Promise.resolve(json({ ok: false }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    client,
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

function Dock(props: {
  readonly client: OperationsClient;
  readonly session: Session | null;
  readonly grantKey: string;
  readonly storage: Storage | null;
}): ReactElement {
  const dock = useDockPanel(props);
  return (
    <main>
      {['Proj-First', 'Proj-Other'].map((key) => (
        <button
          key={key}
          type="button"
          data-door={key}
          onClick={() => {
            dock.host.open(key, 'open');
          }}
        >
          {key}
        </button>
      ))}
      {['Site health', 'Inbox'].map((from) => (
        <button
          key={from}
          type="button"
          data-file={from}
          onClick={() =>
            dock.panel.file?.({ from, category: from === 'Site health' ? 'seo' : 'branding' })
          }
        >
          {from}
        </button>
      ))}
      {/* The dock's X: in the dock the draft draws no Close of its own. */}
      <button type="button" data-dock-x onClick={dock.panel.close}>
        X
      </button>
      {dock.panel.body}
    </main>
  );
}

type View = Awaited<ReturnType<typeof mount>>;

const panelTitle = (view: View): string | null =>
  view.find('[data-task-panel] [data-panel-title]')?.textContent ?? null;

/** A draft named and its Create pressed, the create still out. */
async function createInFlight(
  api: ReturnType<typeof server>,
  storage: Storage | null,
): Promise<View> {
  const view = await mount(
    <Dock client={api.client} session={ADA} grantKey="alpha:ada:0" storage={storage} />,
  );
  await view.click('[data-door="Proj-First"]');
  await tick();
  await view.click('[data-task-panel] [data-panel-head="new"]');
  await view.type('#panel-draft-name', 'New brief');
  await view.click('[data-draft="create"]');
  await tick();
  expect(api.creates).toHaveLength(1);
  return view;
}

/** The kept drafts left in the store; the open task's own key (S1) is not a draft. */
const draftKeys = (storage: Storage | null): readonly (string | null)[] =>
  Array.from({ length: storage?.length ?? 0 }, (_, index) => storage?.key(index) ?? null).filter(
    (key) => key?.startsWith('ops-astro.task-draft.') === true,
  );

describe('A11-1 the draft cannot be left while Create is in flight', () => {
  it.each([
    { name: 'working', make: store },
    { name: 'blocked', make: blocked },
    { name: 'absent', make: () => null },
  ])(
    '$name storage: Close, Escape, Cancel and a door on the page wait for Create; one create, one operation id',
    async ({ make }) => {
      const api = server();
      const storage = make();
      const view = await createInFlight(api, storage);
      await view.click('[data-dock-x]');
      expect((view.find('[data-draft="cancel"]') as HTMLButtonElement).disabled).toBe(true);
      await press(view, '[data-draft-panel]', 'Escape');
      await view.click('[data-door="Proj-Other"]');
      await tick();
      expect(view.find('[data-draft-panel]')).not.toBeNull();
      expect(view.find('[data-task-panel]')).toBeNull();
      await view.click('[data-draft="create"]');
      await api.land();
      expect(api.creates).toHaveLength(1);
      expect(panelTitle(view)).toBe(`Title of ${NEW_KEY}`);
      expect(draftKeys(storage)).toStrictEqual([]);
      await view.click('[data-file="Inbox"]');
      expect(valueOf(view, '#panel-draft-name')).toBe('');
    },
  );
});

describe('A11-1 a Create that lands after the session changed opens nothing', () => {
  it('never replaces the panel the next session has open, and keeps no draft', async () => {
    const api = server();
    const storage = store();
    const view = await createInFlight(api, storage);
    const bravo: Session = { businessKey: 'bravo', email: 'ada@example.test' };
    await view.render(
      <Dock client={api.client} session={bravo} grantKey="bravo:ada:0" storage={storage} />,
    );
    await view.click('[data-door="Proj-Other"]');
    await tick();
    expect(panelTitle(view)).toBe('Title of Proj-Other');
    await api.land();
    expect(panelTitle(view)).toBe('Title of Proj-Other');
    expect(view.find('[data-draft-panel]')).toBeNull();
    expect(draftKeys(storage)).toStrictEqual([]);
  });
});

function blocked(): Storage {
  return {
    ...store(),
    getItem: () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('Storage blocked', 'SecurityError');
    },
  };
}
const unwritable = (): Storage => ({
  ...store(),
  setItem: () => {
    throw new DOMException('Storage full', 'QuotaExceededError');
  },
});

const unavailableStores = [
  { name: 'absent', storage: () => null },
  { name: 'blocked', storage: blocked },
  { name: 'unreadable', storage: () => ({ ...store(), getItem: blocked().getItem }) },
  { name: 'unwritable', storage: unwritable },
];

describe('an edited draft survives door remounts without browser storage', () => {
  it.each(unavailableStores)(
    '$name storage keeps the edits and original page across doors and close',
    async ({ storage: makeStorage }) => {
      const api = server();
      const storage = makeStorage();
      const view = await mount(
        <Dock client={api.client} session={ADA} grantKey="alpha:ada:0" storage={storage} />,
      );
      await view.click('[data-file="Site health"]');
      await view.type('#panel-draft-name', 'Kept name');
      await view.type('#panel-draft-note', 'Kept note');
      const first = view.find('[data-draft-panel]');
      await view.click('[data-file="Inbox"]');
      expect(view.find('[data-draft-panel]')).not.toBe(first);
      expect(valueOf(view, '#panel-draft-name')).toBe('Kept name');
      expect(valueOf(view, '#panel-draft-note')).toBe('Kept note');
      expect(valueOf(view, '#panel-draft-category')).toBe('seo');
      expect(view.find('[data-draft-admission]')?.textContent).toContain('filed from Site health');
      await view.click('[data-dock-x]');
      expect(view.find('[data-draft-panel]')).toBeNull();
      await view.click('[data-file="Inbox"]');
      expect(valueOf(view, '#panel-draft-name')).toBe('Kept name');
      await view.click('[data-draft="cancel"]');
      await view.click('[data-file="Inbox"]');
      expect(valueOf(view, '#panel-draft-name')).toBe('');
      expect(valueOf(view, '#panel-draft-category')).toBe('branding');
      expect(api.creates).toHaveLength(0);
    },
  );
});

describe('owner changes clear drafts without browser storage', () => {
  it.each([
    { name: 'sign-out', session: null, grantKey: 'signed-out' },
    {
      name: 'person switch',
      session: { businessKey: 'alpha', email: 'bea@example.test' },
      grantKey: 'alpha:bea:0',
    },
    {
      name: 'business switch',
      session: { businessKey: 'bravo', email: ADA.email },
      grantKey: 'bravo:ada:0',
    },
  ])(
    '$name clears the in-memory draft before returning to its owner',
    async ({ session, grantKey }) => {
      const api = server();
      const storage = blocked();
      const view = await mount(
        <Dock client={api.client} session={ADA} grantKey="alpha:ada:0" storage={storage} />,
      );
      await view.click('[data-file="Site health"]');
      await view.type('#panel-draft-name', 'Kept name');
      await view.render(
        <Dock client={api.client} session={session} grantKey={grantKey} storage={storage} />,
      );
      expect(view.find('[data-draft-panel]')).toBeNull();
      if (session !== null) {
        await view.click('[data-file="Inbox"]');
        expect(valueOf(view, '#panel-draft-name')).toBe('');
      }
      await view.render(
        <Dock client={api.client} session={ADA} grantKey="alpha:ada:1" storage={storage} />,
      );
      await view.click('[data-file="Inbox"]');
      expect(valueOf(view, '#panel-draft-name')).toBe('');
      expect(valueOf(view, '#panel-draft-category')).toBe('branding');
    },
  );
});
