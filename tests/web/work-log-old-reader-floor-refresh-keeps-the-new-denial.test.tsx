// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { FIRST, held, json, refused } from './work-log-stand-in.tsx';

it('an old reader’s queued floor refresh cannot erase the current reader’s denial', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const pending = held();
  let reads = 0;
  const first = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input) => {
      if (!String(input).endsWith('/task/ledger'))
        return Promise.resolve(json({ ok: true, preferences: {} }));
      reads += 1;
      return reads === 1 ? Promise.resolve(json(FIRST)) : pending.response;
    },
  });
  const second = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input) =>
      Promise.resolve(
        String(input).endsWith('/task/ledger')
          ? json(refused('SCOPE_NOT_GRANTED', []), 403)
          : json({ ok: true, preferences: {} }),
      ),
  });
  const view = await mount(<WorkLog client={first} grantKey="alpha:ada" navigate={() => {}} />);
  try {
    await settle();
    expect(view.text()).toContain('Fix the gate');
    await act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(reads).toBe(2);
    await act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await view.render(<WorkLog client={second} grantKey="alpha:ben" navigate={() => {}} />);
    await settle();
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    await act(() => {
      pending.release(FIRST);
    });
    await settle();
    await settle();
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.find('[data-outcome="loading"]')).toBeNull();
  } finally {
    pending.release(FIRST);
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
