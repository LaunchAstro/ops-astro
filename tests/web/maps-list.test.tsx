// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { act, useState, type ReactElement } from 'react';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { FLOOR_MS } from '../../apps/web/src/data/live.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { App } from '../../apps/web/src/App.tsx';
import { open, json, settle, storage, session } from './mp-2-1-support.tsx';
import { lit } from './frame-support.tsx';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type RefreshTrigger = 'floor' | 'return' | 'online';

async function refreshMaps(
  trigger: RefreshTrigger,
  setVisibility: (next: DocumentVisibilityState) => void,
): Promise<void> {
  await act(async () => {
    if (trigger === 'floor') await vi.advanceTimersByTimeAsync(FLOOR_MS);
    else if (trigger === 'online') window.dispatchEvent(new Event('online'));
    else {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    }
    await vi.advanceTimersByTimeAsync(1);
  });
}

async function registeredMaps(fetch: typeof globalThis.fetch): Promise<Mounted> {
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return await mount(
    SCREENS['agency:maps']({
      client,
      grantKey: 'same-reader',
      params: {},
      notice: null,
      storage: null,
      navigate: () => {},
    }),
  );
}

function ReaderSwitch(props: {
  readonly sessions: SessionStore;
  readonly next: { businessKey: string; email: string };
  readonly fetch: typeof globalThis.fetch;
  readonly onSwitch: () => void;
}): ReactElement {
  const { sessions, next, fetch } = props;
  const [, refresh] = useState(0);
  return (
    <>
      <button
        onClick={() => {
          sessions.set(next);
          props.onSwitch();
          refresh((n) => n + 1);
        }}
      >
        Switch reader
      </button>
      <App
        path="/projects/maps/"
        navigate={() => {}}
        sessions={sessions}
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        storage={null}
        fetch={fetch}
      />
    </>
  );
}

it.each(['floor', 'return', 'online'] as const)(
  'the registered Maps screen clears a denied list and discovers new admissions on %s',
  async (trigger) => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    let answer = json({ ok: true, maps: [{ id: 'old-map', key: 'OLD-1', title: 'Old plan' }] });
    let reads = 0;
    const view = await registeredMaps(() => {
      reads += 1;
      return Promise.resolve(answer);
    });
    expect(view.find('a[href="/map/OLD-1"]')?.textContent).toBe('Old plan');
    answer = json(
      {
        refused: true,
        code: 'SCOPE_NOT_GRANTED',
        names: ['task:read'],
        fixes: ['Ask for a grant.'],
      },
      403,
    );
    await refreshMaps(trigger, (next) => {
      visibility = next;
    });
    expect(reads).toBe(2);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).not.toContain('Old plan');
    expect(view.all('a[href^="/map/"]')).toHaveLength(0);
    answer = json({
      ok: true,
      maps: [{ id: 'new-map', key: 'NEW-2', title: 'Newly admitted plan' }],
    });
    await refreshMaps(trigger, (next) => {
      visibility = next;
    });
    expect(reads).toBe(3);
    expect(view.find('a[href="/map/NEW-2"]')?.textContent).toBe('Newly admitted plan');
    expect(view.text()).not.toContain('Old plan');
    await view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('Projects offers Maps and the admitted list links each map by key or ID', async () => {
  const projects = await open('/projects/');
  expect(projects.view.find('a[href="/projects/maps/"]')?.textContent).toBe('Maps');
  await projects.view.unmount();
  const page = await open('/projects/maps/', {
    fetch: () =>
      Promise.resolve(
        json({
          ok: true,
          maps: [
            { id: 'map-one', key: 'MAP-7', title: 'A made-up plan' },
            { id: 'map-two', key: null, title: 'Another made-up plan' },
          ],
        }),
      ),
  });
  await settle();
  expect(lit(page.view)).toEqual(['Projects']);
  expect(page.view.find('a[href="/map/MAP-7"]')?.textContent).toBe('A made-up plan');
  expect(page.view.find('a[href="/map/map-two"]')?.textContent).toBe('Another made-up plan');
});

it('an admitted empty list explains how a map is charted', async () => {
  const page = await open('/projects/maps/', {
    fetch: () => Promise.resolve(json({ ok: true, maps: [] })),
  });
  await settle();
  expect(page.view.find('[data-outcome="empty"]')).not.toBeNull();
  expect(page.view.text()).toContain('Chart a map');
  expect(page.view.text()).toContain('wayfinder');
});

it('a grantless reader sees the plain refusal instead of an empty list', async () => {
  const page = await open('/projects/maps/', {
    fetch: () =>
      Promise.resolve(
        json(
          {
            refused: true,
            code: 'SCOPE_NOT_GRANTED',
            names: ['task:read'],
            fixes: ['Ask a collection manager for a task:read grant.'],
          },
          403,
        ),
      ),
  });
  await settle();
  expect(page.view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(page.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(page.view.text()).toContain('Ask a collection manager for a task:read grant.');
  expect(page.view.find('[data-outcome="empty"]')).toBeNull();
  expect(page.view.all('a[href^="/map/"]')).toHaveLength(0);
});

it('an unavailable read stays distinct from an empty list and can be retried', async () => {
  let unavailable = true;
  const page = await open('/projects/maps/', {
    fetch: () =>
      Promise.resolve(
        unavailable
          ? json({}, 503)
          : json({ ok: true, maps: [{ id: 'map-one', key: 'MAP-7', title: 'A made-up plan' }] }),
      ),
  });
  await settle();
  expect(page.view.find('[data-outcome="unavailable"]')).not.toBeNull();
  expect(page.view.find('[data-outcome="empty"]')).toBeNull();
  expect(page.view.all('a[href^="/map/"]')).toHaveLength(0);
  unavailable = false;
  await page.view.click('[data-outcome="unavailable"] button');
  await settle();
  expect(page.view.find('a[href="/map/MAP-7"]')?.textContent).toBe('A made-up plan');
});

it.each([
  { businessKey: 'bravo', email: 'ada@alpha.local', boundary: 'business' },
  { businessKey: 'alpha', email: 'noah@alpha.local', boundary: 'person' },
])('a late map list cannot repopulate the page after a $boundary switch', async (next) => {
  let answerLate: ((answer: Response) => void) | undefined;
  const sessions = new SessionStore(
    storage({
      'ops-astro.session': JSON.stringify(session('alpha')),
    }).like,
  );
  let switched = false;
  const fetch: typeof globalThis.fetch = (url) => {
    if (!String(url).endsWith('/map/list')) return new Promise<Response>(() => {});
    if (!switched)
      return new Promise<Response>((resolve) => {
        answerLate = resolve;
      });
    return Promise.resolve(json({ ok: true, maps: [] }));
  };
  const held = {
    view: await mount(
      <ReaderSwitch
        sessions={sessions}
        next={next}
        fetch={fetch}
        onSwitch={() => {
          switched = true;
        }}
      />,
    ),
  };
  await settle();
  expect(answerLate).toBeTypeOf('function');
  await held.view.click('button');
  expect(held.view.text()).not.toContain('Old reader plan');
  await settle();
  expect(held.view.find('[data-outcome="empty"]')).not.toBeNull();
  answerLate?.(
    json({ ok: true, maps: [{ id: 'foreign-map', key: 'FOREIGN-1', title: 'Old reader plan' }] }),
  );
  await settle();
  expect(held.view.find('[data-outcome="empty"]')).not.toBeNull();
  expect(held.view.text()).not.toContain('Old reader plan');
  expect(held.view.find('a[href="/map/FOREIGN-1"]')).toBeNull();
});
