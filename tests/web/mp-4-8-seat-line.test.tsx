// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8 seat line (T-D19, owner answer 8): the dock task panel seats only
// when `n × per ≤ vw − rail − 40 − 836` allows, otherwise floats at the width
// asked for, never under 380; below the side tier the dock's sheet, and on a
// phone its strip. The task panel is the dock's `task` panel (MP-3-1), so its
// place is the dock's one geometry (`dock/geometry.ts`, MP-3-2), read with the
// nav rail as the person left it.

import { afterEach, describe, expect, it } from 'vitest';
import { RAIL_DEFAULT, RAIL_STRIP } from '../../packages/ui/src/surfaces/RailParts.tsx';
import { App } from '../../apps/web/src/App.tsx';
import { dockGeometry } from '../../apps/web/src/dock/geometry.ts';
import { SessionStore, layoutKey, type StorageLike } from '../../apps/web/src/session/token.ts';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const place = (viewport: number, over: { rail?: number; width?: number; panels?: number } = {}) =>
  dockGeometry({
    viewport,
    navRail: over.rail ?? RAIL_DEFAULT,
    width: over.width ?? 550,
    open: over.panels === 2 ? ['task', 'clients'] : ['task'],
  });

describe('MP-4-8 seat line', () => {
  it('seats one 550 panel from 1650 with the expanded rail, and floats at 1649', () => {
    expect(place(1650)).toMatchObject({ mode: 'seated', panelWidth: 550 });
    expect(place(1649)).toMatchObject({ mode: 'floating', panelWidth: 550 });
  });

  it('seats one 550 panel from 1482 with the rail collapsed, and floats at 1481', () => {
    expect(place(1482, { rail: RAIL_STRIP })).toMatchObject({ mode: 'seated', panelWidth: 550 });
    expect(place(1481, { rail: RAIL_STRIP })).toMatchObject({ mode: 'floating', panelWidth: 550 });
  });

  it('counts every open panel at the width asked for against the line', () => {
    expect(place(2200, { panels: 2 }).mode).toBe('seated');
    expect(place(2199, { panels: 2 }).mode).toBe('floating');
  });
});

describe('MP-4-8 seat line: the floor, 1440 and the sheets', () => {
  it('floats at the width asked for rather than narrowing to fit the line', () => {
    expect(place(1480)).toMatchObject({ mode: 'floating', panelWidth: 550 });
  });

  it('never draws a seated or floating panel under 380', () => {
    expect(place(1700, { width: 200 })).toMatchObject({ mode: 'seated', panelWidth: 380 });
    expect(place(1300, { width: 200 })).toMatchObject({ mode: 'floating', panelWidth: 380 });
  });

  it('does not seat under 1440 even where the line would allow it', () => {
    expect(place(1439, { rail: RAIL_STRIP, width: 380 }).mode).toBe('floating');
    expect(place(1440, { rail: RAIL_STRIP, width: 380 }).mode).toBe('seated');
  });

  it("is the dock's sheet below 1280 and its phone strip at 900 and under", () => {
    expect(place(1279).mode).toBe('sheet');
    expect(place(901).mode).toBe('sheet');
    expect(place(900).mode).toBe('phone');
    expect(place(390).mode).toBe('phone');
  });
});

const KEY = 'Proj-Verity-Pacing';
const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const DOOR = '#perspective-panel-team [data-panel-door="log"]';

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

// `preference.read` stays unanswered, so the person's rail is the tab's copy of
// it (MP-2-11), seeded below; an answer would only say the same again.
const fetch = ((url: string | URL) => {
  const where = String(url);
  if (where.endsWith('/preference/read')) return new Promise<Response>(() => {});
  if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
  if (where.endsWith('/task/queue')) {
    return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
  }
  if (/\/live(\/task\/|\?|$)/u.test(where)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task() }));
  // The panel's Project select reads the Projects board (MP-4-8).
  if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
  return Promise.resolve(json({ ok: false }));
}) as unknown as typeof globalThis.fetch;

/** The app at `width` with the person's rail as they left it, a task opened from its page door. */
async function openedAt(width: number, collapsed: boolean): Promise<HTMLElement> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
  const kept = storage({
    'ops-astro.session': JSON.stringify(SESSION),
    [layoutKey('alpha')]: JSON.stringify({
      who: SESSION.email,
      layout: { 'rail.collapsed': collapsed },
    }),
  });
  const view = await mount(
    <App
      path={`/task/${KEY}`}
      navigate={() => {}}
      sessions={new SessionStore(kept)}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={kept as Storage}
    />,
  );
  await tick();
  await view.click(DOOR);
  await tick();
  return view.find('[data-dock]') as HTMLElement;
}

describe('MP-4-8 seat line: the panel takes its place from the real dock', () => {
  it('reads the nav rail as the person left it: collapsed, it seats at 1482', async () => {
    expect((await openedAt(1482, true)).dataset['dock']).toBe('seated');
  });

  it('with the rail collapsed it floats at 1481', async () => {
    expect((await openedAt(1481, true)).dataset['dock']).toBe('floating');
  });

  it('with the rail expanded the same 1482 floats', async () => {
    expect((await openedAt(1482, false)).dataset['dock']).toBe('floating');
  });

  it('draws no Mock corner label on the panel: its frame is real', async () => {
    const dock = await openedAt(1700, false);
    expect(dock.querySelector('.dpanel[data-panel-id="task"]')).not.toBeNull();
    expect(dock.querySelector('.dpanel[data-panel-id="task"] .mocktag')).toBeNull();
  });
});
