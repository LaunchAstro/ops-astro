// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable no-await-in-loop, no-inline-comments, require-await, unicorn/prefer-dom-node-dataset -- Sol's proof, kept as written */
//
// Sol's proofs on #1923 (S1923-1 to 3), copied with their assertions unchanged: a delayed
// answer, a remounted card and an older poll never extend or restore Launch, even when two
// reads are sent on the same clock reading (#1928).
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { ABOUT, V1, mockPropose } from './sidebar-corrections-support.tsx';

beforeEach(() =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  }),
);
afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const read = (state: string, ms: number) =>
  json({
    ok: true,
    correction: {
      correctionId: 'mock-correction-1',
      state,
      approver: null,
      versionId: state === 'locating' ? null : V1,
      verifiedAt: ms > 0 ? '2026-10-19T00:00:00.000Z' : null,
      verifiedForMs: ms,
      refusal: null,
    },
  });
function client(answer: (nth: number) => Promise<Response>, businessKey = 'alpha') {
  let nth = 0;
  return new OperationsClient({
    origin: '',
    businessKey,
    signedIn: true,
    // The desk's list read (#1897) answers empty and takes no number.
    fetch: (async (url: string | URL) =>
      String(url).endsWith('/live_correction/list')
        ? json({ ok: true, corrections: [] })
        : answer(++nth)) as typeof globalThis.fetch,
  });
}
async function ask(c: OperationsClient) {
  const port = mockPropose().port;
  const view = await mount(<SidebarCorrections client={c} propose={port} />);
  for (const [name, value] of Object.entries(ABOUT)) await view.type(`[name="${name}"]`, value);
  await view.click('[data-correction-ask]');
  await advance(0);
  return { view, port };
}
const approve = (view: Awaited<ReturnType<typeof mount>>) =>
  view.find('[data-correction-decide="approve"]');

it('a delayed answer cannot extend the server verification deadline', async () => {
  // The server computes a 20 s remainder now; transport holds that exact response for 25 s.
  const response = read('requested', 20_000);
  let deliver!: (r: Response) => void;
  const c = client(
    (nth) =>
      new Promise<Response>((resolve) => {
        if (nth === 1) deliver = resolve;
      }),
  );
  const { view } = await ask(c);
  await advance(25_000);
  await act(async () => {
    deliver(response);
  });
  await advance(0);
  expect(approve(view), 'server verification expired 5 s before this response arrived').toBeNull();
});

it('returning to an expired held card never offers Approve', async () => {
  const c = client(async () => read('requested', 20_000));
  const { view, port } = await ask(c);
  expect(approve(view)).not.toBeNull();
  const other = client(async () => read('requested', 0), 'bravo');
  await view.render(<SidebarCorrections client={other} propose={port} />);
  await advance(25_000);
  await view.render(<SidebarCorrections client={c} propose={port} />);
  // No event-loop turn is guaranteed before the browser paints or accepts a click.
  expect(approve(view), 'the stored read is already 25 s old with only a 20 s lease').toBeNull();
});

it('an older polling answer cannot resurrect a superseded correction', async () => {
  let deliverOld!: (r: Response) => void;
  const c = client(async (nth) => {
    if (nth === 1) return read('locating', 0);
    if (nth === 2)
      return new Promise<Response>((resolve) => {
        deliverOld = resolve;
      });
    return read('superseded', 0);
  });
  const { view } = await ask(c);
  await advance(5000); // read 2 observed requested, but its answer is held in transport
  const old = read('requested', 60_000);
  await advance(5000); // read 3 observed superseded and arrives first
  expect(view.find('[data-correction-card]')?.getAttribute('data-correction-state')).toBe(
    'superseded',
  );
  await act(async () => {
    deliverOld(old);
  });
  await advance(0);
  expect(
    view.find('[data-correction-card]')?.getAttribute('data-correction-state'),
    'a late snapshot must not undo the newer terminal state',
  ).toBe('superseded');
  expect(approve(view)).toBeNull();
});

it('a same-tick older poll cannot undo the later decision read', async () => {
  let deliverOld!: (r: Response) => void;
  const c = client(async (nth) => {
    if (nth === 1) return read('requested', 0);
    if (nth === 2)
      return new Promise<Response>((resolve) => {
        deliverOld = resolve;
      });
    if (nth === 3) return json({ recordId: 'mock-correction-1', revision: 2 }); // decline mutation
    return read('rejected', 0); // decision's authoritative follow-up read
  });
  const { view } = await ask(c);
  await advance(10_000); // polling read starts and waits in transport
  const sentAt = performance.now();
  await view.click('[data-correction-decide="reject"]');
  expect(performance.now()).toBe(sentAt); // distinct requests can share a clock reading
  expect(view.find('[data-correction-card]')?.getAttribute('data-correction-state')).toBe(
    'declined',
  );
  await act(async () => {
    deliverOld(read('requested', 60_000));
  });
  await advance(0);
  expect
    .soft(
      view.find('[data-correction-card]')?.getAttribute('data-correction-state'),
      'the old poll must not undo the later decision read when timestamps tie',
    )
    .toBe('declined');
  expect(approve(view)).toBeNull();
});
