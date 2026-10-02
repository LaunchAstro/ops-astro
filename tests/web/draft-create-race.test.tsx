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
import { NEW_ID, NEW_KEY, store } from './draft-support.tsx';

afterEach(unmountAll);

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
  readonly storage: Storage;
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
async function createInFlight(api: ReturnType<typeof server>, storage: Storage): Promise<View> {
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

describe('A11-1 the draft cannot be left while Create is in flight', () => {
  it('Close, Escape, Cancel and a door on the page wait for Create; one create, one operation id', async () => {
    const api = server();
    const storage = store();
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
    expect(storage.length).toBe(0);
  });
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
    expect(storage.length).toBe(0);
  });
});
