// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Proofs from the independent review of the Work log refresh, retitled by what they prove; their bodies are as written; each first asserts the refreshed first-page request before the second press.
/* oxlint-disable max-lines-per-function, require-await -- the review's proofs, kept as written */

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { mount, settle } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, held, projects, server } from './work-log-stand-in.tsx';

it('a floor refresh while an earlier page is on its way draws each day once', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  const pending = held();
  const api = server([{ body: FIRST }, pending.response, { body: FIRST }, { body: SECOND }]);
  const view = await mount(projects(api.fetch));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await view.click('.act__more');
    expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.asked.map((body) => body['before'])).toEqual([null, '2026-09-22', null]);
    await view.click('.act__more');
    pending.release(SECOND);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(api.asked.filter((body) => body['before'] === '2026-09-22')).toHaveLength(1);
  } finally {
    pending.release(SECOND);
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});

it('a floor refresh cannot admit a second earlier-page read while the first is pending', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  const pending = held();
  const api = server([{ body: FIRST }, pending.response, { body: FIRST }, { body: SECOND }]);
  const view = await mount(projects(api.fetch));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await view.click('.act__more');
    expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.asked).toHaveLength(3);
    await view.click('.act__more');
    pending.release(SECOND);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(api.asked.filter((body) => body['before'] === '2026-09-22')).toHaveLength(1);
  } finally {
    pending.release(SECOND);
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});

it('a floor refresh cannot enable a second request for an earlier page still in flight', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  const pending = held();
  const asked: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/preference/read'))
      return Response.json({ ok: true, preferences: {} });
    if (!String(url).endsWith('/task/ledger')) return Response.json({ ok: true, tasks: [] });
    const body = JSON.parse(String(init?.body)) as { before: string | null };
    asked.push(body.before);
    return body.before === null
      ? Response.json(FIRST)
      : pending.response.then((response) => response.clone());
  };
  const view = await mount(projects(fetch));
  try {
    await settle();
    await view.click('.act__more');
    await settle();
    expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(asked).toEqual([null, '2026-09-22', null]);
    await view.click('.act__more');
    await settle();
    await act(async () => pending.release(SECOND));
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(asked.filter((before) => before !== null)).toHaveLength(1);
  } finally {
    pending.release(SECOND);
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});
