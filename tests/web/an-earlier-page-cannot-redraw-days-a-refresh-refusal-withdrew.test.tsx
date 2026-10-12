// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A refresh refusal withdraws every drawn Work log day. An earlier page that
// answers after that refusal has been accepted, but before the screen has
// drawn it, belongs to a window that no longer exists and must not put the
// withdrawn days back.

import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, held, projects, refused, server } from './work-log-stand-in.tsx';

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

it('an earlier page answering just after a refresh refusal leaves every day withdrawn', async () => {
  const earlier = held();
  const refresh = held();
  // Anything read after the refusal is held, so the screen shows what the refusal left.
  const after = held();
  const api = server([{ body: FIRST }, earlier.response, refresh.response, after.response]);
  const view = await mount(projects(api.fetch));
  try {
    await settle();
    await view.click('.act__more');
    await settle(30_000);
    expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null]);
    // Both answers arrive before the screen draws again: the refusal first.
    await act(async () => {
      refresh.release(refused('SCOPE_NOT_GRANTED', ['task']));
      await vi.advanceTimersByTimeAsync(1);
      earlier.release(SECOND);
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle();
    expect(drawn(view)).toEqual([]);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  } finally {
    earlier.release(SECOND);
    refresh.release(FIRST);
    after.release(FIRST);
    await view.unmount();
  }
});
