// SPDX-License-Identifier: AGPL-3.0-only
// Proof from the independent review of the Work log refresh, retitled by what it proves; its body is as written.
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { mount } from '../surfaces/mount.tsx';
import { event, json, page, projects, refused } from './work-log-stand-in.tsx';

it('the Work log withdraws private task history once the same grant is revoked', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  let revoked = false;
  let ledgerReads = 0;
  let boardReads = 0;
  const privateHistory = page(
    [
      {
        day: '2026-09-28',
        events: [event('private', '2026-09-28T02:00:00Z', 'OPS-1', 'Private task')],
      },
    ],
    false,
  );
  const fetch: typeof globalThis.fetch = async (input) => {
    const at = String(input);
    if (at.endsWith('/task/ledger')) ledgerReads += 1;
    if (at.endsWith('/task/board')) boardReads += 1;
    if (revoked && (at.endsWith('/task/ledger') || at.endsWith('/task/board'))) {
      return json(refused('SCOPE_NOT_GRANTED', []), 403);
    }
    if (at.endsWith('/task/ledger')) return json(privateHistory);
    if (at.endsWith('/task/board')) return json({ ok: true, tasks: [] });
    if (at.endsWith('/preference/read')) return json({ ok: true, preferences: {} });
    return json({ ok: true });
  };
  const view = await mount(projects(fetch));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.text()).toContain('Private task');
    revoked = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
      window.dispatchEvent(new Event('online'));
    });
    expect(
      view.find('[data-tab="board"] [data-outcome="denied"]') ??
        view.find('[data-outcome="denied"]'),
      `board reads: ${boardReads}`,
    ).not.toBeNull();
    expect(view.text(), `ledger reads after revocation: ${ledgerReads}`).not.toContain(
      'Private task',
    );
    expect(ledgerReads).toBeGreaterThan(1);
  } finally {
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
