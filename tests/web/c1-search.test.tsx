// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C1, search across what the person may see, with ⌘K. The palette asks the
// one scoped query service (`task.search`, C1a) and draws exactly what it
// answered: hits it may show, "nothing found" with no count, or a refusal
// with no title, id or count. Scope before candidates is proved against the
// real database by `tests/reads/search.test.ts` and `C1 isolation`
// (`tests/reads/c1-isolation.test.ts`); here the stand-in is the transport.

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { json, open, settle } from './mp-2-1-support.tsx';
import { press } from './frame-support.tsx';

const HITS = [
  { id: 'task-1', key: 'ABC-1', title: 'Acme brochure' },
  { id: 'task-2', key: 'ABC-7', title: 'Brochure proofs' },
];

/** A transport that answers `task.search` with `answer` and holds every other call. */
function searching(answer: (query: string) => Response) {
  const asked: { readonly url: string; readonly query: string }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/task/search')) return new Promise<Response>(() => {});
    const { query } = JSON.parse(String(init?.body ?? '{}')) as { query: string };
    asked.push({ url, query });
    return answer(query);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

async function typeQuery(
  view: Awaited<ReturnType<typeof open>>['view'],
  words: string,
): Promise<void> {
  await view.type('.palette input', words);
  await act(async () => {
    await new Promise((done) => {
      setTimeout(done, 250);
    });
  });
  await settle();
}

const palette = (view: Awaited<ReturnType<typeof open>>['view']) => view.find('.palette');

describe('C1 CS-2.4 search across what the person may see by click or ⌘K, opening the chosen result', () => {
  it('opens on ⌘K, lists what the service answered, and opens the chosen task on Enter', async () => {
    const { fetch, asked } = searching(() => json({ ok: true, hits: HITS }));
    const { view, seen } = await open('/projects/', { fetch });
    const key = await press(document.body, 'k', { metaKey: true });
    expect(key.defaultPrevented).toBe(true);
    expect(palette(view)?.getAttribute('role')).toBe('dialog');
    expect(document.activeElement).toBe(view.find('.palette input'));

    await typeQuery(view, 'broch');
    expect(asked.map((each) => each.query)).toEqual(['broch']);
    expect(asked[0]?.url).toBe('/api/b/alpha/task/search');
    expect(view.all('.palette [role="option"]').map((each) => each.textContent)).toEqual([
      'ABC-1Acme brochure',
      'ABC-7Brochure proofs',
    ]);

    await press(view.find('.palette input') ?? document.body, 'ArrowDown');
    await press(view.find('.palette input') ?? document.body, 'Enter');
    expect(seen.at(-1)).toBe('/task/ABC-7');
    expect(palette(view)).toBeNull();
    await view.unmount();
  });

  it('opens on a click on the search box, and Escape closes it back to the box', async () => {
    const { fetch } = searching(() => json({ ok: true, hits: HITS }));
    const { view } = await open('/projects/', { fetch });
    await view.click('.appbar .appbar__search');
    expect(palette(view)).not.toBeNull();
    await press(document.activeElement ?? document.body, 'Escape');
    expect(palette(view)).toBeNull();
    expect(document.activeElement).toBe(view.find('.appbar .appbar__search'));
    await view.unmount();
  });

  it('opens a result on a click', async () => {
    const { fetch } = searching(() => json({ ok: true, hits: HITS }));
    const { view, seen } = await open('/projects/', { fetch });
    await view.click('.appbar .appbar__search');
    await typeQuery(view, 'acme');
    await view.click('.palette [role="option"]');
    expect(seen.at(-1)).toBe('/task/ABC-1');
    await view.unmount();
  });
});

describe('C1 scope applies before candidates: nothing, not even a count', () => {
  it('says nothing was found, with no number, when the service answers no hits', async () => {
    const { fetch } = searching(() => json({ ok: true, hits: [] }));
    const { view } = await open('/projects/', { fetch });
    await view.click('.appbar .appbar__search');
    await typeQuery(view, 'zephyrine');
    expect(view.find('.palette .palette__none')?.textContent).toBe('Nothing found.');
    expect(view.find('.palette')?.textContent).not.toMatch(/\d/u);
    await view.unmount();
  });

  it('draws a refusal with no title, id or count', async () => {
    const refusal = {
      refused: true,
      code: 'SCOPE_NOT_GRANTED',
      names: [],
      fixes: ['no live grant covers it'],
    };
    const { fetch } = searching(() => json(refusal, 403));
    const { view } = await open('/projects/', { fetch });
    await view.click('.appbar .appbar__search');
    await typeQuery(view, 'quixotical');
    expect(view.all('.palette [role="option"]')).toHaveLength(0);
    expect(view.find('.palette .palette__none')?.textContent).toBe(
      'Search is not open to you here.',
    );
    expect(view.find('.palette')?.textContent).not.toMatch(/\d/u);
    await view.unmount();
  });

  it('asks nothing for a query with no word in it', async () => {
    const { fetch, asked } = searching(() => json({ ok: true, hits: HITS }));
    const { view } = await open('/projects/', { fetch });
    await view.click('.appbar .appbar__search');
    await typeQuery(view, ' -*- ');
    expect(asked).toEqual([]);
    await view.unmount();
  });
});

describe('C1 this is the one scoped query service', () => {
  it('asks task.search and nothing else for a search', async () => {
    const { fetch, asked } = searching(() => json({ ok: true, hits: HITS }));
    const { view } = await open('/projects/', { fetch });
    const before = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await view.click('.appbar .appbar__search');
    await typeQuery(view, 'broch');
    const calls = (fetch as unknown as { mock: { calls: [RequestInfo | URL][] } }).mock.calls
      .slice(before)
      .map(([input]) => String(input));
    expect(calls).toEqual(asked.map((each) => each.url));
    await view.unmount();
  });
});

describe('C1 the portal has no search', () => {
  it('draws no search box on the client face and ignores ⌘K there', async () => {
    const { fetch, asked } = searching(() => json({ ok: true, hits: HITS }));
    const { view } = await open('/portal/acme-dental/', { fetch });
    expect(view.find('.appbar .appbar__search')).toBeNull();
    const key = await press(document.body, 'k', { metaKey: true });
    expect(key.defaultPrevented).toBe(false);
    expect(palette(view)).toBeNull();
    expect(asked).toEqual([]);
    await view.unmount();
  });
});
