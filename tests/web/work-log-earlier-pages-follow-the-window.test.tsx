// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// `Load earlier days` and the Work log's refresh answer to one window: an
// earlier page that fails withdraws every drawn day the way a refresh's
// failure does, and one that answers for a window no longer drawn is dropped.

import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import {
  FIRST,
  SECOND,
  SECOND_OF_THREE,
  THIRD,
  drawn,
  held,
  projects,
  refused,
  server,
} from './work-log-stand-in.tsx';

const BOX = 'input[type="search"]';

const settle = async (ms = 1): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/projects/');
});

const failures = [
  ['refused', { body: refused('SCOPE_NOT_GRANTED', ['task']), status: 403 }, 'denied'],
  ['unavailable', { body: {}, status: 503 }, 'unavailable'],
] as const;

it.each(failures)('a %s earlier page withdraws every drawn day', async (_, answer, outcome) => {
  const api = server([{ body: FIRST }, answer]);
  const view = await mount(projects(api.fetch));
  try {
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2']);
    await view.click('.act__more');
    await settle();
    expect(drawn(view)).toEqual([]);
    expect(view.find(`[data-outcome="${outcome}"]`)).not.toBeNull();
  } finally {
    await view.unmount();
  }
});

it('a refresh that succeeds after an earlier-page refusal draws nothing', async () => {
  const refresh = held();
  const earlier = held();
  const api = server([{ body: FIRST }, earlier.response, refresh.response]);
  const view = await mount(projects(api.fetch));
  try {
    await settle();
    await view.click('.act__more');
    await settle(30_000);
    expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null]);
    await act(async () => {
      earlier.release(refused('SCOPE_NOT_GRANTED', ['task']));
    });
    await settle();
    refresh.release(FIRST);
    await settle();
    expect(drawn(view)).toEqual([]);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  } finally {
    earlier.release(SECOND);
    refresh.release(FIRST);
    await view.unmount();
  }
});

it('an earlier page sent for search A is dropped after A to B to A', async () => {
  const earlier = held();
  const api = server([
    { body: FIRST },
    { body: FIRST },
    earlier.response,
    { body: FIRST },
    { body: FIRST },
  ]);
  const view = await mount(projects(api.fetch));
  try {
    await settle();
    await view.type(BOX, 'hinge');
    await settle();
    await view.click('.act__more');
    await view.type(BOX, 'gate');
    await settle();
    await view.type(BOX, 'hinge');
    await settle();
    expect(api.asked.map((body) => [body['query'], body['before']])).toEqual([
      [undefined, null],
      ['hinge', null],
      ['hinge', '2026-09-22'],
      ['gate', null],
      ['hinge', null],
    ]);
    earlier.release(SECOND);
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2']);
    expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(false);
  } finally {
    earlier.release(SECOND);
    await view.unmount();
  }
});

it('an earlier page that lands during a refresh is kept when the refresh lands', async () => {
  const earlier = held();
  const refresh = held();
  const api = server([
    { body: FIRST },
    earlier.response,
    refresh.response,
    { body: FIRST },
    { body: SECOND_OF_THREE },
  ]);
  const view = await mount(projects(api.fetch));
  try {
    await settle();
    await view.click('.act__more');
    await settle(30_000);
    earlier.release(SECOND_OF_THREE);
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    // The refresh in flight covered only the first page; it gives way to one that covers the new days.
    refresh.release(FIRST);
    await settle();
    expect(api.asked.map((body) => body['before'])).toEqual([
      null,
      '2026-09-22',
      null,
      null,
      '2026-09-22',
    ]);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(view.find('.act__more')).not.toBeNull();
  } finally {
    earlier.release(SECOND);
    refresh.release(FIRST);
    await view.unmount();
  }
});

it('a refusal on an earlier page of a refresh withdraws every day', async () => {
  const api = server([
    { body: FIRST },
    { body: SECOND_OF_THREE },
    { body: THIRD },
    { body: FIRST },
    { body: refused('SCOPE_NOT_GRANTED', ['task']), status: 403 },
  ]);
  const view = await mount(projects(api.fetch));
  try {
    await settle();
    await view.click('.act__more');
    await settle();
    await view.click('.act__more');
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3', 'e4']);
    await settle(30_000);
    expect(api.asked.map((body) => body['before'])).toEqual([
      null,
      '2026-09-22',
      '2026-09-15',
      null,
      '2026-09-22',
    ]);
    expect(drawn(view)).toEqual([]);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  } finally {
    await view.unmount();
  }
});
