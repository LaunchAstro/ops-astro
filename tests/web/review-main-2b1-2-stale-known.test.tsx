// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-2: an answer the read has already dropped must not change
// who the search thinks is in view.
//
// A search for `hinge` is on its way when the box is cleared and the newest
// days are read again. The `hinge` answer, carrying an event by Dee Dunn,
// lands late: the read refuses it, so it is never drawn, and it must not
// leave Dee among the people words are read against either. Otherwise `dee`
// typed next reads as a person nobody in view is, sends no query, and the
// page says nothing matches.

import { describe, expect, it } from 'vitest';
import type { TaskLedgerResult } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';
import { held, openWorkLog, pinZone, projects, server, tick } from './work-log-stand-in.tsx';

pinZone();

const ev = (id: string, actorName: string, key: string, title: string) => ({
  id,
  at: '2026-09-28T02:00:00Z',
  actorName,
  operation: 'task.update',
  task: { key, title },
});

/** The newest days: Ada and Ben, no Dee. */
const DAY: TaskLedgerResult = {
  ok: true,
  days: [
    {
      day: '2026-09-28',
      events: [
        ev('a1', 'Ada Admin', 'OPS-1', 'Fix the gate'),
        ev('b1', 'Ben Brown', 'OPS-2', 'Paint the shed'),
      ],
    },
  ],
  earlier: false,
};

/** The answer for `hinge`, held: Dee Dunn oiled it. */
const H1: TaskLedgerResult = {
  ok: true,
  days: [{ day: '2026-09-15', events: [ev('h1', 'Dee Dunn', 'OPS-3', 'Oil the hinge')] }],
  earlier: false,
};

/** What C1's search finds for the word `dee`: a task named for it, acted on by Ada. */
const FOUND_DEE: TaskLedgerResult = {
  ok: true,
  days: [{ day: '2026-09-20', events: [ev('w1', 'Ada Admin', 'OPS-4', 'Dee street fence')] }],
  earlier: false,
};

const BOX = 'input[type="search"]';

describe('REVIEW-MAIN-2B1-2 a dropped answer leaves the people in view alone', () => {
  it('REVIEW-MAIN-2B1-2: a stale search answer does not make its actors people for the next words', async () => {
    const hinge = held();
    const api = server([{ body: DAY }, hinge.response, { body: DAY }, { body: FOUND_DEE }]);
    const view = await mount(projects(api.fetch));
    await tick();
    await openWorkLog(view);

    await view.type(BOX, 'hinge');
    await tick();
    expect(api.asked.at(-1)).toMatchObject({ query: 'hinge' });

    await view.click('.act__find button');
    await tick();
    expect(api.asked.at(-1)).toEqual({ timeZone: 'Australia/Brisbane', before: null });

    hinge.release(H1);
    await tick();
    expect(view.text()).not.toContain('Oil the hinge');

    await view.type(BOX, 'dee');
    await tick();

    expect(api.asked.at(-1)).toMatchObject({ before: null, query: 'dee' });
    expect(view.find('.act__page .empty__title')).toBeNull();
    await view.unmount();
  });
});
