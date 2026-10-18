// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { FIRST, SECOND_OF_THREE, THIRD, drawn, held, json } from './work-log-stand-in.tsx';

it('loading another day during a refresh never overlaps reads of an earlier page', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const pending = held();
  let secondPageReads = 0;
  let pendingEarlierReads = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input, init) => {
      if (!String(input).endsWith('/task/ledger'))
        return Promise.resolve(json({ ok: true, preferences: {} }));
      const body = JSON.parse(String(init?.body)) as { before: string | null };
      if (body.before === null) return Promise.resolve(json(FIRST));
      if (body.before === '2026-09-15') return Promise.resolve(json(THIRD));
      secondPageReads += 1;
      if (secondPageReads === 1) return Promise.resolve(json(SECOND_OF_THREE));
      pendingEarlierReads += 1;
      return pending.response.then((response) => {
        pendingEarlierReads -= 1;
        return response.clone();
      });
    },
  });
  const view = await mount(<WorkLog client={client} grantKey="alpha:ada" navigate={() => {}} />);
  try {
    await settle();
    await view.click('.act__more');
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(pendingEarlierReads).toBe(1);
    await view.click('.act__more');
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(
      pendingEarlierReads,
      'the refresh must not send the same earlier-page read again while it is pending',
    ).toBe(1);
  } finally {
    pending.release(SECOND_OF_THREE);
    await settle();
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
