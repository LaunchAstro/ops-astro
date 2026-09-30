// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-3-1c and MP-3-1d: the open set's rules, without a document. What opens,
// what closes, what Escape takes, and what the tab keeps for whom.

import { describe, expect, it } from 'vitest';
import {
  CLOSED,
  close,
  closeAll,
  closedBy,
  dockSlot,
  escape,
  openByGesture,
  press,
  ranked,
  type DockState,
} from '../../apps/web/src/dock/open-set.ts';
import { dockKey, type Session, type StorageLike } from '../../apps/web/src/session/token.ts';

const mia: Session = { token: 'tok-mia', businessKey: 'alpha', email: 'mia@alpha.local' };

function memory(): StorageLike & { readonly held: Map<string, string> } {
  const held = new Map<string, string>();
  return {
    held,
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const opened = (...steps: readonly [id: 'settings' | 'todos' | 'task', shift: boolean][]) =>
  steps.reduce<DockState>((state, [id, shift]) => press(state, id, shift), CLOSED);

describe('MP-3-1 gesture opens', () => {
  it('shows one panel on a plain click and adds one on shift', () => {
    expect(opened(['settings', false]).open).toEqual(['settings']);
    expect(opened(['settings', false], ['todos', true]).open).toEqual(['settings', 'todos']);
  });

  it('draws the open panels in rank order, never open order', () => {
    expect(ranked(opened(['settings', false], ['todos', true]))).toEqual(['todos', 'settings']);
  });

  it('replaces every open panel on a plain click of another tab', () => {
    const state = opened(['settings', false], ['todos', true], ['task', false]);
    expect(state.open).toEqual(['task']);
  });
});

describe('MP-3-1 x closes own', () => {
  it('closes only its panel and drops that panel stored place', () => {
    const state = openByGesture(
      openByGesture(CLOSED, 'todos', false, '/projects/'),
      'task',
      true,
      '/task/T-1',
    );
    const after = close(state, 'task');
    expect(after.open).toEqual(['todos']);
    expect(after.places).toEqual({ todos: '/projects/' });
    expect(closedBy(state, after)).toEqual(['task']);
  });
});

describe('MP-3-1 close all', () => {
  it('closes every open panel at once and keeps no place', () => {
    const state = opened(['settings', false], ['todos', true]);
    expect(closeAll(state)).toEqual(CLOSED);
    expect(closedBy(state, closeAll(state))).toEqual(['settings', 'todos']);
  });
});

describe('MP-3-1 escape order', () => {
  it('closes the last opened panel, one per press, not the highest ranked', () => {
    const state = opened(['settings', false], ['todos', true]);
    expect(escape(state).open).toEqual(['settings']);
    expect(escape(escape(state)).open).toEqual([]);
    expect(escape(CLOSED)).toEqual(CLOSED);
  });
});

describe('MP-3-1 open set survives navigation', () => {
  it('keeps the open set and places for the same person in the same business', () => {
    const storage = memory();
    const state = openByGesture(opened(['settings', false]), 'todos', true, '/task/T-1');
    dockSlot(storage, mia).write(state);
    expect(dockSlot(storage, mia).read()).toEqual(state);
    expect([...storage.held.keys()]).toEqual([dockKey('alpha')]);
  });

  it('restores nothing for another person, another business or no session', () => {
    const storage = memory();
    dockSlot(storage, mia).write(opened(['settings', false]));
    expect(dockSlot(storage, { ...mia, email: 'noah@alpha.local' }).read()).toEqual(CLOSED);
    expect(dockSlot(storage, { ...mia, businessKey: 'bravo' }).read()).toEqual(CLOSED);
    expect(dockSlot(storage, null).read()).toEqual(CLOSED);
  });

  it('keeps no token in what it stores', () => {
    const storage = memory();
    dockSlot(storage, mia).write(opened(['settings', false]));
    expect([...storage.held.entries()].join(' ')).not.toContain('tok-mia');
  });
});

describe('MP-3-1 open set survives navigation', () => {
  it('drops a hostile stored row: unknown ids, repeats, other origins, odd shapes', () => {
    const storage = memory();
    const row = (value: unknown): DockState => {
      storage.setItem(dockKey('alpha'), JSON.stringify(value));
      return dockSlot(storage, mia).read();
    };
    const who = mia.email;
    expect(row({ who, open: ['settings', 'bell', 'constructor', 'settings'], places: {} })).toEqual(
      { open: ['settings'], places: {} },
    );
    expect(
      row({
        who,
        open: ['todos', 'task', 'settings'],
        places: {
          todos: '//evil.test/x',
          task: 'https://evil.test/',
          settings: '/\\evil.test',
          __proto__: '/x',
        },
      }),
    ).toEqual({ open: ['todos', 'task', 'settings'], places: {} });
    expect(row({ who, open: 'settings', places: {} })).toEqual(CLOSED);
    expect(row({ who: 'MIA@ALPHA.LOCAL', open: ['settings'], places: {} })).toEqual(CLOSED);
    expect(row(null)).toEqual(CLOSED);
    storage.setItem(dockKey('alpha'), '{not json');
    expect(dockSlot(storage, mia).read()).toEqual(CLOSED);
  });

  it('keeps working when the storage throws', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => {
      dockSlot(throwing, mia).write(opened(['settings', false]));
    }).not.toThrow();
    expect(dockSlot(throwing, mia).read()).toEqual(CLOSED);
  });
});
