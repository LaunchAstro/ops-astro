// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-5: the dock's history, without a document. Whole-dock entries; only a
// change of place adds one, while scroll is sealed into the entry in hand;
// 25 at most, oldest first out; back and forward walk it, and a new place
// after a step back drops what lay ahead.

import { describe, expect, it } from 'vitest';
import {
  HISTORY_CAP,
  back,
  canBack,
  canForward,
  forward,
  record,
  seal,
  start,
  type DockHistory,
} from '../../apps/web/src/dock/history.ts';
import { CLOSED, type DockState } from '../../apps/web/src/dock/open-set.ts';

const todos = (place?: string): DockState => ({
  open: ['todos'],
  places: place === undefined ? {} : { todos: place },
});

describe('MP-3-5 whole-dock entries', () => {
  it('an entry holds the open set, each panel place and each panel scroll', () => {
    const history = seal(record(start(CLOSED), todos('/task/T-1')), 'todos', 240);
    expect(history.entries.at(-1)).toEqual({
      open: ['todos'],
      places: { todos: '/task/T-1' },
      scroll: { todos: 240 },
    });
  });
});

describe('MP-3-5 only a change of place adds an entry', () => {
  it('adds one when the open set or a place changes, and none for the same place', () => {
    let history = start(CLOSED);
    history = record(history, todos());
    history = record(history, todos());
    history = record(history, todos('/task/T-1'));
    history = record(history, { open: ['todos', 'settings'], places: { todos: '/task/T-1' } });
    history = record(history, { open: ['settings', 'todos'], places: { todos: '/task/T-1' } });
    expect(history.entries).toHaveLength(4);
  });

  it('seals scroll into the entry in hand, however often, and never pushes', () => {
    let history = record(start(CLOSED), todos());
    for (let top = 0; top < 30; top += 1) history = seal(history, 'todos', top);
    expect(history.entries).toHaveLength(2);
    expect(history.entries.at(-1)?.scroll).toEqual({ todos: 29 });
  });

  it('keeps no scroll for a panel that is not open', () => {
    const history = seal(record(start(CLOSED), todos()), 'settings', 90);
    expect(history.entries.at(-1)?.scroll).toEqual({});
  });
});

describe('MP-3-5 cap 25', () => {
  it('keeps the latest 25 and evicts the oldest', () => {
    let history: DockHistory = start(CLOSED);
    for (let step = 0; step < 30; step += 1)
      history = record(history, todos(`/task/T-${String(step)}`));
    expect(HISTORY_CAP).toBe(25);
    expect(history.entries).toHaveLength(25);
    expect(history.at).toBe(24);
    expect(history.entries[0]?.places).toEqual({ todos: '/task/T-5' });
  });
});

describe('MP-3-5 walk', () => {
  it('back returns the previous entry, forward the next, and each end disables its way', () => {
    let history = record(record(start(CLOSED), todos()), todos('/task/T-1'));
    expect(canBack(history)).toBe(true);
    expect(canForward(history)).toBe(false);
    history = back(history);
    expect(history.entries[history.at]).toMatchObject(todos());
    history = back(history);
    expect(history.entries[history.at]).toMatchObject(CLOSED);
    expect(canBack(history)).toBe(false);
    expect(back(history)).toBe(history);
    history = forward(forward(history));
    expect(history.entries[history.at]).toMatchObject(todos('/task/T-1'));
    expect(forward(history)).toBe(history);
  });

  it('a new place after a step back drops what lay ahead', () => {
    let history = record(record(start(CLOSED), todos()), todos('/task/T-1'));
    history = record(back(history), todos('/task/T-2'));
    expect(history.entries.map((entry) => entry.places)).toEqual([{}, {}, { todos: '/task/T-2' }]);
    expect(canForward(history)).toBe(false);
  });

  it('recording the entry just walked to adds nothing', () => {
    const history = back(record(record(start(CLOSED), todos()), todos('/task/T-1')));
    expect(record(history, todos())).toBe(history);
  });
});
