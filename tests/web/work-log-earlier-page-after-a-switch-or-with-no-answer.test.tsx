// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// `Load earlier days` against a window that moved on: a page sent for one
// reader answers nothing into the next reader's window, refused or not, and a
// page that never answers holds back no refresh, so a revoke still withdraws.

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

const answers = [
  ['refused', refused('SCOPE_NOT_GRANTED', ['task'])],
  ['granted', SECOND],
] as const;

it.each(answers)(
  'an earlier page %s for the previous reader leaves the next reader’s days as drawn',
  async (_, answer) => {
    const earlier = held();
    const api = server([{ body: FIRST }, earlier.response, { body: FIRST }]);
    const view = await mount(projects(api.fetch, 'alpha:ada:0'));
    try {
      await settle();
      await view.click('.act__more');
      await settle();
      await view.render(projects(api.fetch, 'alpha:ben:0'));
      await settle();
      expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null]);
      expect(drawn(view)).toEqual(['e1', 'e2']);
      earlier.release(answer);
      await settle();
      expect(drawn(view)).toEqual(['e1', 'e2']);
      expect(view.find('[data-outcome="denied"]')).toBeNull();
      expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(false);
    } finally {
      earlier.release(SECOND);
      await view.unmount();
    }
  },
);

it('an earlier page that never answers holds back no refresh, and a revoke still withdraws', async () => {
  const lost = held();
  const api = server([
    { body: FIRST },
    lost.response,
    { body: FIRST },
    { body: refused('SCOPE_NOT_GRANTED', ['task']), status: 403 },
  ]);
  const view = await mount(projects(api.fetch));
  try {
    await settle();
    await view.click('.act__more');
    await settle(30_000);
    expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null]);
    expect(drawn(view)).toEqual(['e1', 'e2']);
    await settle(30_000);
    expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null, null]);
    expect(drawn(view)).toEqual([]);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  } finally {
    lost.release(SECOND);
    await view.unmount();
  }
});
