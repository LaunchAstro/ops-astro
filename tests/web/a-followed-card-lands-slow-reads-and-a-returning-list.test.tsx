// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop, no-promise-executor-return, unicorn/consistent-function-scoping, unicorn/prefer-dom-node-dataset -- the reviewer's proof, kept as written. */
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
const item = {
  correctionId: 'c-1',
  taskId: 't-1',
  state: 'accepted',
  approver: null,
  versionId: 'v-1',
  pageUrl: 'https://example.test',
  word: 'old',
  replacement: 'new',
  requestedAt: '2026-10-18T00:00:00Z',
};
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});
it('criterion 1: successful four-second reads eventually publish and stop polling', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const fetch = ((url: string | URL) => {
    if (String(url).endsWith('/list'))
      return Promise.resolve(json({ ok: true, corrections: [item] }));
    reads++;
    return new Promise<Response>((resolve) =>
      setTimeout(() => resolve(json({ ok: true, correction: { ...item, state: 'live' } })), 4000),
    );
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const view = await mount(<SidebarCorrections client={client} grantKey="alpha:owner:1" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(view.find('[data-correction-card]')?.getAttribute('data-correction-state')).toBe(
    'approved',
  );
  for (let second = 0; second < 20; second++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  expect(reads).toBeGreaterThan(1);
  expect(view.find('[data-correction-card]')?.getAttribute('data-correction-state')).toBe(
    'published',
  );
  const stopped = reads;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(reads).toBe(stopped);
});
it('criterion 2: a late list stays with its business and person grant', async () => {
  let release!: (answer: Response) => void;
  const first = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })) as typeof globalThis.fetch,
  });
  const empty = (businessKey: string) =>
    new OperationsClient({
      origin: '',
      businessKey,
      signedIn: true,
      fetch: (() =>
        Promise.resolve(json({ ok: true, corrections: [] }))) as typeof globalThis.fetch,
    });
  const view = await mount(<SidebarCorrections client={first} grantKey="alpha:alice:1" />);
  await view.render(<SidebarCorrections client={empty('alpha')} grantKey="alpha:bob:2" />);
  release(json({ ok: true, corrections: [item] }));
  await tick();
  expect(view.all('[data-correction-card]')).toHaveLength(0);
  await view.render(<SidebarCorrections client={empty('bravo')} grantKey="bravo:alice:3" />);
  await tick();
  expect(view.all('[data-correction-card]')).toHaveLength(0);
});
it('criterion 1: returning to a business uses the current state from its fresh list', async () => {
  let state = 'requested';
  const client = (businessKey: string) =>
    new OperationsClient({
      origin: '',
      businessKey,
      signedIn: true,
      fetch: (() =>
        Promise.resolve(
          json({ ok: true, corrections: businessKey === 'alpha' ? [{ ...item, state }] : [] }),
        )) as typeof globalThis.fetch,
    });
  const alpha = client('alpha');
  const view = await mount(<SidebarCorrections client={alpha} grantKey="alpha:alice:1" />);
  await tick();
  expect(view.find('[data-correction-card]')?.getAttribute('data-correction-state')).toBe(
    'requested',
  );
  await view.render(<SidebarCorrections client={client('bravo')} grantKey="bravo:alice:1" />);
  await tick();
  state = 'live';
  await view.render(<SidebarCorrections client={alpha} grantKey="alpha:alice:1" />);
  await tick();
  expect(view.find('[data-correction-card]')?.getAttribute('data-correction-state')).toBe(
    'published',
  );
});
