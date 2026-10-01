// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-8-4's count line when the search reads only part of what matches
// (CS-8.9 "how many events pass"). `task.ledger` answers `more` with a query
// when the reader's matching tasks go past C1's bound (500), so some are not
// listed: the count line then says it is partial, and says nothing extra
// when the answer is complete or there is no search.

import { describe, expect, it } from 'vitest';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';
import { event, openWorkLog, pinZone, projects, server, tick } from './work-log-stand-in.tsx';

pinZone();

const DAY: TaskLedgerResult = {
  ok: true,
  days: [{ day: '2026-09-28', events: [event('a1', '2026-09-28T02:00:00Z', 'OPS-1', 'Gate')] }],
  earlier: false,
};

const FOUND: TaskLedgerResult = {
  ok: true,
  days: [{ day: '2026-09-28', events: [event('c1', '2026-09-28T02:00:00Z', 'OPS-3', 'Hinge')] }],
  earlier: false,
};

const BOX = 'input[type="search"]';
const count = (view: Awaited<ReturnType<typeof mount>>) =>
  view.find('[data-ledger-count]')?.textContent ?? null;
const partial = (view: Awaited<ReturnType<typeof mount>>) =>
  view.find('[data-ledger-more-matches]') !== null;

async function searched(answer: TaskLedgerResult) {
  const api = server([{ body: DAY }, { body: answer }, { body: DAY }]);
  const view = await mount(projects(api.fetch));
  await tick();
  await openWorkLog(view);
  await view.type(BOX, 'hinge');
  await tick();
  return view;
}

describe('MP-8-4 the count line when more match than the search reads', () => {
  it('a search answered with more says the count is partial, past the 500 the search reads', async () => {
    const view = await searched({ ...FOUND, more: true });
    expect(count(view)).toBe('1 of 1 entries; more match than the search reads (500+)');
    expect(partial(view)).toBe(true);
  });

  it('a search answered in full says only the count', async () => {
    const view = await searched({ ...FOUND, more: false });
    expect(count(view)).toBe('1 of 1 entries');
    expect(partial(view)).toBe(false);
  });

  it('clearing the search drops the partial note with the query', async () => {
    const view = await searched({ ...FOUND, more: true });
    await view.click('.act__find button');
    await tick();
    expect(count(view)).toBe('1 of 1 entries');
    expect(partial(view)).toBe(false);
  });
});
