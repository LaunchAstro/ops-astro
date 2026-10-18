// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, held, json, page } from './work-log-stand-in.tsx';

/** The drawn reader's client, whose earlier page and refresh wait, and the next reader's. */
function readers(business: string) {
  const earlier = held();
  const refresh = held();
  let reads = 0;
  const old = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input, init) => {
      if (!String(input).endsWith('/task/ledger'))
        return Promise.resolve(json({ ok: true, preferences: {} }));
      const { before } = JSON.parse(String(init?.body));
      if (before !== null) return earlier.response;
      reads += 1;
      return reads === 1 ? Promise.resolve(json(FIRST)) : refresh.response;
    },
  });
  const urls: string[] = [];
  const next = new OperationsClient({
    origin: '',
    businessKey: business,
    signedIn: true,
    fetch: (input) => {
      urls.push(String(input));
      return Promise.resolve(
        json(
          String(input).endsWith('/task/ledger') ? page([], false) : { ok: true, preferences: {} },
        ),
      );
    },
  });
  return { earlier, refresh, old, next, urls };
}

const log = (client: OperationsClient, grantKey: string) => (
  <WorkLog client={client} grantKey={grantKey} navigate={() => {}} />
);

const tick = async (ms = 1) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

it.each([
  ['business', 'bravo', 'ada'],
  ['person', 'alpha', 'ben'],
])(
  '%s separation drops the previous reader’s held refresh and earlier page',
  async (_, business, person) => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { earlier, refresh, old, next, urls } = readers(business);
    const view = await mount(log(old, 'alpha:ada'));
    try {
      await tick();
      await view.click('.act__more');
      await tick(30_000);
      await view.render(log(next, `${business}:${person}`));
      await tick();
      expect(drawn(view)).toEqual([]);
      earlier.release(SECOND);
      refresh.release(FIRST);
      await tick();
      expect(drawn(view)).toEqual([]);
      await tick(30_000);
      expect(drawn(view)).toEqual([]);
      expect(urls.filter((url) => url.endsWith('/task/ledger'))).toHaveLength(2);
      expect(urls.every((url) => url.startsWith(`/api/b/${business}/`))).toBe(true);
    } finally {
      earlier.release(SECOND);
      refresh.release(FIRST);
      await view.unmount();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  },
);
