// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #2108: the desk's list read names a correction's version but not its check.
// When it lists a new version for a card that holds a check on the old one,
// the card drops that check and offers no Launch until a read of the new
// version answers. A listed version the card already holds keeps its check.

import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SidebarCorrections } from '../../apps/web/src/views/correction-card.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { ABOUT, V1, V2, mockPropose, type View } from './sidebar-corrections-support.tsx';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const CHECK_MS = 60_000;

/**
 * Business alpha's API: the first list is empty and later ones list the asked
 * correction at `relisted`; each read answers `reads[n]` (the last repeating),
 * checked for a minute. Every decision's body is kept.
 */
function api(relisted: string, reads: readonly string[]) {
  let lists = 0;
  let nth = 0;
  const decided: { readonly versionId?: unknown }[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/live_correction/list')) {
      lists += 1;
      const corrections =
        lists === 1
          ? []
          : [
              {
                correctionId: 'mock-correction-1',
                taskId: '22222222-2222-4222-8222-222222222222',
                state: 'requested',
                approver: null,
                versionId: relisted,
                pageUrl: 'https://agencyastro.com/about',
                word: ABOUT.word,
                replacement: ABOUT.replacement,
                requestedAt: '2026-10-19T00:00:00.000Z',
              },
            ];
      return Promise.resolve(json({ ok: true, corrections }));
    }
    if (path.endsWith('/live_correction/decide')) {
      decided.push(JSON.parse(String(init?.body)) as { readonly versionId?: unknown });
      return Promise.resolve(json({ recordId: 'mock-correction-1', revision: 2 }));
    }
    const versionId = reads[Math.min(nth, reads.length - 1)];
    nth += 1;
    return Promise.resolve(
      json({
        ok: true,
        correction: {
          correctionId: 'mock-correction-1',
          state: 'requested',
          approver: null,
          versionId,
          verifiedAt: '2026-10-19T00:00:00.000Z',
          verifiedForMs: CHECK_MS,
          refusal: null,
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, decided, reads: () => nth };
}

const elsewhere = new OperationsClient({
  origin: '',
  businessKey: 'bravo',
  signedIn: true,
  fetch: (() =>
    Promise.resolve(json({ ok: true, corrections: [] }))) as unknown as typeof globalThis.fetch,
});

const approve = (view: View) => view.find('[data-correction-decide="approve"]');
const checking = (view: View) => view.find('[data-correction-checking]');

/** Asks for the correction under alpha, reads it checked, then draws bravo and alpha again. */
async function relist(alpha: OperationsClient): Promise<View> {
  const { port } = mockPropose();
  const view = await mount(<SidebarCorrections client={alpha} propose={port} />);
  await view.type('[name="page"]', ABOUT.page);
  await view.type('[name="word"]', ABOUT.word);
  await view.type('[name="replacement"]', ABOUT.replacement);
  await view.click('[data-correction-ask]');
  await advance(0);
  expect(approve(view), 'the first read checked V1 for a minute').not.toBeNull();
  await view.render(<SidebarCorrections client={elsewhere} propose={port} />);
  await advance(0);
  await view.render(<SidebarCorrections client={alpha} propose={port} />);
  await advance(0);
  return view;
}

it('a listed new version offers no Launch until a read of that version answers', async () => {
  const alpha = api(V2, [V1, V2]);
  const view = await relist(alpha.client);
  expect(approve(view), 'the minute checked V1, and the list now names V2').toBeNull();
  expect(checking(view)).not.toBeNull();
  const before = alpha.reads();
  await advance(10_000);
  expect(alpha.reads(), 'the card reads the new version again').toBeGreaterThan(before);
  expect(approve(view), 'the read checked V2').not.toBeNull();
  await view.click('[data-correction-decide="approve"]');
  await advance(0);
  expect(alpha.decided.at(-1)?.versionId).toBe(V2);
});

it('a listed version the card already holds keeps its check', async () => {
  const alpha = api(V1, [V1]);
  const view = await relist(alpha.client);
  expect(approve(view), 'the list names the V1 the minute still checks').not.toBeNull();
  expect(checking(view)).toBeNull();
});
