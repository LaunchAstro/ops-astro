// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import {
  FIRST,
  SECOND,
  drawn,
  held,
  projects,
  refused,
  server,
  json,
} from './work-log-stand-in.tsx';

const settle = async (ms = 1) => {
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

it.each([
  ['refusal', refused('SCOPE_NOT_GRANTED', ['task']), 403],
  ['outage', {}, 503],
])(
  'a refresh %s after an earlier-page success withdraws all days while the next refresh waits',
  async (_, failure, status) => {
    const earlier = held();
    let releaseRefresh!: (response: Response) => void;
    const refresh = {
      response: new Promise<Response>((resolve) => {
        releaseRefresh = resolve;
      }),
      release: (body: unknown, code = 200) => releaseRefresh(json(body, code)),
    };
    const next = held();
    const api = server([{ body: FIRST }, earlier.response, refresh.response, next.response]);
    const view = await mount(projects(api.fetch));
    try {
      await settle();
      expect(drawn(view)).toEqual(['e1', 'e2']);
      await view.click('.act__more');
      await settle(30_000);
      expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null]);
      earlier.release(SECOND);
      await settle();
      expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
      refresh.release(failure, status as number);
      await settle();
      expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null, null]);
      expect(drawn(view)).toEqual([]);
    } finally {
      earlier.release(SECOND);
      refresh.release(FIRST);
      next.release(FIRST);
      await view.unmount();
    }
  },
);
