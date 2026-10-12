// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, projects, server } from './work-log-stand-in.tsx';

// Sol's proof on #1371 (round 2), retitled by what it proves; its body is Sol's.
it('an unchanged background refresh preserves loaded earlier work-log days', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  const api = server([{ body: FIRST }, { body: SECOND }, { body: FIRST }]);
  const view = await mount(projects(api.fetch));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(drawn(view)).toEqual(['e1', 'e2']);
    await view.click('.act__more');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null]);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
  } finally {
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});
