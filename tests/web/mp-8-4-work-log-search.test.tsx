// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-8-4's search on the Work log tab (CS-8.9, L-01 to L-04, L-08).
//
// A word is placed as a person (any word of an actor's name in view) or an
// event kind (its synonyms), else it is a free word. Facets of one kind OR,
// different kinds AND. People and kinds are a reading of the days in view;
// free words go to the server as `task.ledger`'s `query`, which C1's search
// answers, so no second search runs here. The page says what it understood,
// how many events pass of how many in view, and what the log holds when
// nothing matches.

import { describe, expect, it } from 'vitest';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';
import { drawn, openWorkLog, pinZone, projects, server, tick } from './work-log-stand-in.tsx';

pinZone();

const ev = (id: string, actorName: string, operation: string, key: string) => ({
  id,
  at: '2026-09-28T02:00:00Z',
  actorName,
  operation,
  task: { key, title: `Task ${key}` },
});

const DAY: TaskLedgerResult = {
  ok: true,
  days: [
    {
      day: '2026-09-28',
      events: [
        ev('a1', 'Ada Admin', 'task.comment', 'OPS-1'),
        ev('a2', 'Ada Admin', 'task.update', 'OPS-1'),
        ev('b1', 'Ben Brown', 'task.comment', 'OPS-2'),
        ev('c1', 'Cy Cole', 'task.complete', 'OPS-3'),
      ],
    },
  ],
  earlier: false,
};

const FOUND: TaskLedgerResult = {
  ok: true,
  days: [{ day: '2026-09-28', events: [ev('c1', 'Cy Cole', 'task.complete', 'OPS-3')] }],
  earlier: false,
};

const BOX = 'input[type="search"]';
const read = (view: Awaited<ReturnType<typeof mount>>) =>
  view.find('[data-ledger-read]')?.textContent ?? null;
const count = (view: Awaited<ReturnType<typeof mount>>) =>
  view.find('[data-ledger-count]')?.textContent ?? null;

async function opened(answers: Parameters<typeof server>[0]) {
  const api = server(answers);
  const view = await mount(projects(api.fetch));
  await tick();
  await openWorkLog(view);
  return { api, view };
}

describe('MP-8-4 facet-style search with the reading line', () => {
  it('a person and a kind read as two facets, said back in words, with no second read', async () => {
    const { api, view } = await opened([{ body: DAY }]);
    await view.type(BOX, 'Ada comment');
    await tick();
    expect(drawn(view)).toEqual(['a1']);
    expect(read(view)).toBe('Reading this as Ada Admin · comments — 1 of them');
    expect(api.asked).toHaveLength(1);
  });

  it('nothing typed says nothing: no reading line', async () => {
    const { view } = await opened([{ body: DAY }]);
    expect(read(view)).toBeNull();
    expect(drawn(view)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });
});

describe('MP-8-4 same kind OR, different kinds AND', () => {
  it('two people are either; a person and a kind are both', async () => {
    const { view } = await opened([{ body: DAY }]);
    await view.type(BOX, 'Ada Ben');
    await tick();
    expect(drawn(view)).toEqual(['a1', 'a2', 'b1']);
    expect(read(view)).toBe('Reading this as Ada Admin or Ben Brown — 3 of them');
    await view.type(BOX, 'Ben comments completed');
    await tick();
    expect(drawn(view)).toEqual(['b1']);
    expect(read(view)).toBe('Reading this as Ben Brown · comments or completions — 1 of them');
  });
});

describe("MP-8-4 free words run on C1's search", () => {
  it('a word that is no person or kind is asked of the ledger as its query, and said back', async () => {
    const { api, view } = await opened([{ body: DAY }, { body: FOUND }]);
    await view.type(BOX, 'hinge');
    await tick();
    expect(api.asked.at(-1)).toMatchObject({ before: null, query: 'hinge' });
    expect(drawn(view)).toEqual(['c1']);
    expect(read(view)).toBe('Reading this as the words “hinge” — 1 of them');
  });
});

describe('MP-8-4 clear the ledger search', () => {
  it('Clear empties the box, drops the reading line and reads the whole ledger again', async () => {
    const { api, view } = await opened([{ body: DAY }, { body: FOUND }, { body: DAY }]);
    await view.type(BOX, 'hinge');
    await tick();
    await view.click('[data-ledger-clear]');
    await tick();
    expect((view.find(BOX) as HTMLInputElement).value).toBe('');
    expect(read(view)).toBeNull();
    expect(api.asked.at(-1)).toMatchObject({ query: null });
    expect(drawn(view)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });
});

describe('MP-8-4 how many events pass and the tracked time in view', () => {
  it('counts what passes of what is in view, and names no time when none is tracked', async () => {
    const { view } = await opened([{ body: DAY }]);
    expect(count(view)).toBe('4 of 4 entries');
    await view.type(BOX, 'comment');
    await tick();
    expect(count(view)).toBe('2 of 4 entries');
    expect(count(view)).not.toMatch(/tracked/u);
  });
});

describe('MP-8-4 no match says what the ledger holds', () => {
  it('a search nothing passes says so, names what the log holds, and offers the clear', async () => {
    const { view } = await opened([{ body: DAY }]);
    await view.type(BOX, 'Cy comment');
    await tick();
    expect(drawn(view)).toEqual([]);
    expect(view.find('.empty__title')?.textContent).toBe('Nothing matches that.');
    expect(view.find('.empty__desc')?.textContent).toMatch(/every change to a task you can see/u);
    await view.click('.empty__action button');
    await tick();
    expect(drawn(view)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });
});
