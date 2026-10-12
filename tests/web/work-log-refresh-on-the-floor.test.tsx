// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The Work log re-reads every loaded day on the tab's rollup floor while the
// tab is shown. A refresh is one run: a tick that finds it in flight waits for
// it rather than starting over, each page has twenty seconds, and a hidden tab
// sends nothing.

import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, event, held, json, page, projects } from './work-log-stand-in.tsx';

let visibility: DocumentVisibilityState = 'visible';

const settle = async (ms = 1): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const setVisibility = async (state: DocumentVisibilityState): Promise<void> => {
  visibility = state;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  window.history.replaceState(null, '', '/projects/#worklog');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/projects/');
});

/** Seven pages, one day each, the newest first; each page but the last has earlier days. */
const SEVEN: readonly TaskLedgerResult[] = Array.from({ length: 7 }, (_, at) => {
  const day = `2026-09-${String(28 - at).padStart(2, '0')}`;
  return page(
    [{ day, events: [event(`p${String(at)}`, `${day}T02:00:00Z`, `OPS-${String(at)}`, 'Task')] }],
    at < 6,
  );
});

/** A ledger that answers each page by its `before`, `ledger.delay` ms after it is asked. */
function slowLedger(delay: number) {
  const ledger = { asked: [] as (string | null)[], delay, fetch: undefined as never };
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (String(input).endsWith('/preference/read'))
      return Promise.resolve(json({ ok: true, preferences: {} }));
    if (!String(input).endsWith('/task/ledger'))
      return Promise.resolve(json({ ok: true, tasks: [] }));
    const { before } = JSON.parse(String(init?.body)) as { before: string | null };
    ledger.asked.push(before);
    const at = before === null ? 0 : SEVEN.findIndex((each) => each.days[0]!.day < before);
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(json(SEVEN[at]));
      }, ledger.delay);
    });
  };
  return Object.assign(ledger, { fetch });
}

it('a seven-page window at twenty seconds a page lands whole under the floor', async () => {
  const ledger = slowLedger(0);
  const view = await mount(projects(ledger.fetch));
  try {
    await settle();
    for (let at = 1; at < 7; at += 1) {
      // eslint-disable-next-line no-await-in-loop -- each page continues from the one before it
      await view.click('.act__more');
      // eslint-disable-next-line no-await-in-loop -- each page continues from the one before it
      await settle();
    }
    expect(drawn(view)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    // Each page now answers just under its twenty seconds: 133 s for the window,
    // so four floor ticks pass while one refresh is in flight.
    ledger.delay = 19_000;
    const from = ledger.asked.length;
    await settle(30_000 + 7 * 19_000);
    expect(ledger.asked.slice(from, from + 7)).toEqual([
      null,
      ...SEVEN.slice(0, 6).map((each) => each.days[0]!.day),
    ]);
    expect(drawn(view)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(view.find('[data-outcome="unavailable"]')).toBeNull();
  } finally {
    await view.unmount();
  }
});

it('a page that takes longer than twenty seconds fails the refresh as unavailable', async () => {
  const slow = slowLedger(25_000);
  const view = await mount(projects(slow.fetch));
  try {
    await settle(20_000);
    expect(drawn(view)).toEqual([]);
    expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
  } finally {
    await view.unmount();
  }
});

it('hiding the tab during a held multi-page refresh sends no further page', async () => {
  const refresh = held();
  let holding = false;
  const asked: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (String(input).endsWith('/preference/read'))
      return Promise.resolve(json({ ok: true, preferences: {} }));
    if (!String(input).endsWith('/task/ledger'))
      return Promise.resolve(json({ ok: true, tasks: [] }));
    const { before } = JSON.parse(String(init?.body)) as { before: string | null };
    asked.push(before);
    if (holding && before === null) {
      holding = false;
      return refresh.response;
    }
    return Promise.resolve(json(before === null ? FIRST : SECOND));
  };
  const view = await mount(projects(fetch));
  try {
    await settle();
    await view.click('.act__more');
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    holding = true;
    await settle(30_000);
    expect(asked).toEqual([null, '2026-09-22', null]);
    await setVisibility('hidden');
    refresh.release(FIRST);
    await settle(120_000);
    expect(asked).toEqual([null, '2026-09-22', null]);
    // Shown again, the floor starts the refresh over, and it runs whole.
    await setVisibility('visible');
    await settle();
    expect(asked).toEqual([null, '2026-09-22', null, null, '2026-09-22']);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
  } finally {
    refresh.release(FIRST);
    await view.unmount();
  }
});

it('a hidden tab sends no Work log reads', async () => {
  const quick = slowLedger(0);
  visibility = 'hidden';
  const view = await mount(projects(quick.fetch));
  try {
    await settle(120_000);
    expect(quick.asked).toEqual([]);
    await setVisibility('visible');
    expect(quick.asked).toEqual([null]);
    expect(drawn(view)).toEqual(['p0']);
  } finally {
    await view.unmount();
  }
});
