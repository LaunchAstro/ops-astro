// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Proofs from the independent review of the Work log refresh, retitled by what they prove; their bodies are as written.

import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, json, page, projects } from './work-log-stand-in.tsx';

it('the refresh tick withdraws deleted-task history from loaded earlier days', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  let deleted = false;
  const asked: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/preference/read')) return json({ ok: true, preferences: {} });
    if (!String(input).endsWith('/task/ledger')) return json({ ok: true, tasks: [] });
    const body = JSON.parse(String(init?.body)) as { before: string | null };
    asked.push(body.before);
    return json(body.before === null ? FIRST : deleted ? page([], false) : SECOND);
  };
  const view = await mount(projects(fetch));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await view.click('.act__more');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.text()).toContain('Oil the hinge');
    deleted = true;
    const current = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    expect(await current.read('task.ledger', { timeZone: 'UTC', before: '2026-09-22' })).toEqual({
      ok: true,
      value: page([], false),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(view.text()).not.toContain('Oil the hinge');
  } finally {
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});

it('refreshing the Work log re-reads the first page and withdraws deleted-task history from earlier days', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', '/projects/#worklog');
  let deleted = false;
  const asked: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/preference/read')) return json({ ok: true, preferences: {} });
    if (!String(input).endsWith('/task/ledger')) return json({ ok: true, tasks: [] });
    const body = JSON.parse(String(init?.body)) as { before: string | null };
    asked.push(body.before);
    return json(body.before === null ? FIRST : deleted ? page([], false) : SECOND);
  };
  const view = await mount(projects(fetch));
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await view.click('.act__more');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(view.text()).toContain('Oil the hinge');
    deleted = true;
    const current = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    expect(await current.read('task.ledger', { timeZone: 'UTC', before: '2026-09-22' })).toEqual({
      ok: true,
      value: page([], false),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(asked.filter((before) => before === null)).toHaveLength(2);
    expect(view.text()).not.toContain('Oil the hinge');
  } finally {
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/projects/');
  }
});
