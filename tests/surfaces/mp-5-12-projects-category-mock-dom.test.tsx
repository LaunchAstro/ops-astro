// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board's category chips (MP-5-12, P-13) before SL08's task
// category catalogue lands (ORCH47 (b)4): the rows take made-up categories
// from one seam, `categoryOf`, and the chips draw inside the design system's
// one mock label (DS-PRIM-32). Nothing about a category is sent to the server:
// the screen asks its reads and nothing else, before and after a chip press.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { categoryOf } from '../../apps/web/src/screens/category-mock.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { READ_NAMES } from '../../apps/web/src/operations/read-names.ts';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const task = (n: number, title: string) => ({
  id: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
  key: `TSK-${String(n)}`,
  title,
  state: { id: 's1', key: 'active', label: 'In progress', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: n, score: 10, calc: 'derived' },
  stage: null,
  clientSet: true,
  actualMinutes: 0,
  estimateMinutes: null,
  pageLink: null,
  statePosition: 1,
  waitReason: null,
  awaitingDecision: false,
});

const TASKS = [task(1, 'Booking form'), task(2, 'Ad copy'), task(3, 'Menu page')];

const READ_PATHS = new Set<string>(READ_NAMES.map((name) => pathOf(name)));

async function openBoard(): Promise<{ board: Mounted; sent: string[] }> {
  const sent: string[] = [];
  const fetch = ((input: RequestInfo | URL) => {
    sent.push(new URL(String(input), 'http://app.invalid').pathname);
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, tasks: TASKS, changedAt: null, withheld: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  mounted = await mount(<Projects navigate={() => {}} client={client} grantKey="alpha:ada" />);
  await settle();
  return { board: mounted, sent };
}

describe('MP-5-12 category chips from the mock seam (until SL08 catalogue)', () => {
  it('draws a chip per made-up category, every one inside the one mock label', async () => {
    const { board } = await openBoard();
    const chips = board.all('.cbd__filters [data-preset^="cat-"]');
    const made = [...new Set(TASKS.map((one) => categoryOf(one)))].filter((one) => one !== null);
    expect(made.length).toBeGreaterThan(0);
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual(made.toSorted());
    for (const chip of chips) {
      const region = chip.closest('[data-provenance="mock"]');
      expect(region, 'a made-up category chip outside the mock label').not.toBeNull();
      expect(region?.querySelector(':scope > .mocktag')?.textContent).toBe('Mock');
    }
    // The filter menu's Category group is the same made-up data, marked too.
    const groups = board.all('.cbd__menu .cbd__menugrp');
    const category = groups.find(
      (one) => one.querySelector('.cbd__menuk')?.textContent === 'Category',
    );
    expect(category, 'the filter menu has no Category group').toBeDefined();
    expect(category?.closest('[data-provenance="mock"]')?.querySelector('.mocktag')).toBeTruthy();
    const status = groups.find((one) => one.querySelector('.cbd__menuk')?.textContent === 'Status');
    expect(status).toBeDefined();
    expect(status?.closest('[data-provenance]')).toBeNull();
    // The viewer's chip and the Review mode are real data: never marked.
    expect(board.find('.cbd__filters [data-mode]')?.closest('[data-provenance]')).toBeNull();
  });

  it('sends nothing about a category: only reads go out, before and after a chip press', async () => {
    const { board, sent } = await openBoard();
    expect(sent.length).toBeGreaterThan(0);
    const chip = board.find('.cbd__filters [data-preset^="cat-"]');
    expect(chip, 'no category chip to press').not.toBeNull();
    await act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    // The tab's live stream listens; it sends nothing.
    const asked = sent
      .map((path) => path.replace(/^\/api\/b\/[^/]+/u, ''))
      .filter((path) => path !== '/live' && !path.startsWith('/live/'));
    expect(asked.filter((path) => !READ_PATHS.has(path))).toEqual([]);
    expect(asked.some((path) => path.includes('categor'))).toBe(false);
  });
});
