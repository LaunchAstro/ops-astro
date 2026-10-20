// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Proofs from the independent review of the Work log refresh, retitled by what they prove; their bodies are as written; the refresh re-reads the earlier page, so each takes a fourth answer and four requests.

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, projects, server } from './work-log-stand-in.tsx';

it('an unchanged background refresh preserves the Work log days the reader loaded', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  const api = server([{ body: FIRST }, { body: SECOND }, { body: FIRST }, { body: SECOND }]);
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
    expect(view.find('.act__more')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.asked.map((body) => body['before'])).toEqual([
      null,
      '2026-09-22',
      null,
      '2026-09-22',
    ]);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(view.find('.act__more')).toBeNull();
  } finally {
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});

it('an unchanged background refresh re-reads and keeps the loaded earlier days', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  const api = server([{ body: FIRST }, { body: SECOND }, { body: FIRST }, { body: SECOND }]);
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
    expect(api.asked.map((body) => body['before'])).toEqual([
      null,
      '2026-09-22',
      null,
      '2026-09-22',
    ]);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
  } finally {
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});
