// SPDX-License-Identifier: AGPL-3.0-only
//
// Signing out leaves nothing of any business this sign-in held (#888). A
// switch keeps the sign-in, so the business it left must go then or at the
// sign-out: its confirmed four-eyes threshold and sign-off setting are money
// and data separation, and the tab's next person must not inherit them. A
// settings answer that lands for the left business after the switch is gone
// at the sign-out too.

import { expect, it } from 'vitest';
import { sessionMemory } from '../../apps/web/src/screens/settings/confirmed.ts';
import {
  SessionStore,
  grantKeyOf,
  settingsCacheKey,
  type Session,
  type StorageLike,
} from '../../apps/web/src/session/token.ts';

function map(): StorageLike & { readonly held: Map<string, string> } {
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

const ADA_ALPHA: Session = { businessKey: 'alpha', email: 'ada@example.test', sessionId: 's-ada' };
const ADA_BRAVO: Session = { businessKey: 'bravo', email: 'ada@example.test', sessionId: 's-ada' };

const keep = (storage: StorageLike, session: Session, values: { fourEyes: number }) => {
  sessionMemory(storage, session.businessKey, grantKeyOf(session)).keep(values);
};

const settingsLeft = (storage: { held: Map<string, string> }): string[] =>
  [...storage.held.keys()].filter((key) => key.startsWith('ops-astro.settings.'));

it('signing out after a business switch leaves neither business’s confirmed settings', () => {
  const storage = map();
  const store = new SessionStore(storage);
  store.set(ADA_ALPHA);
  keep(storage, ADA_ALPHA, { fourEyes: 500 });
  store.set(ADA_BRAVO);
  keep(storage, ADA_BRAVO, { fourEyes: 900 });

  store.clear();

  expect(settingsLeft(storage)).toEqual([]);
  expect(store.session).toBeNull();
});

it('a left business’s settings answer landing after the switch is gone at sign-out', () => {
  const storage = map();
  const store = new SessionStore(storage);
  store.set(ADA_ALPHA);
  store.set(ADA_BRAVO);
  // Alpha's save, pressed before the switch, answers now and keeps its value.
  keep(storage, ADA_ALPHA, { fourEyes: 500 });

  store.clear();

  expect(storage.held.get(settingsCacheKey('alpha'))).toBeUndefined();
  expect(settingsLeft(storage)).toEqual([]);
});

it('a reload between the switch and the sign-out still clears the business it left', () => {
  const storage = map();
  const first = new SessionStore(storage);
  first.set(ADA_ALPHA);
  first.set(ADA_BRAVO);
  keep(storage, ADA_ALPHA, { fourEyes: 500 });
  keep(storage, ADA_BRAVO, { fourEyes: 900 });

  // The tab reloads: a new store over the same storage, then the person signs out.
  const reloaded = new SessionStore(storage);
  reloaded.clear();

  expect(settingsLeft(storage)).toEqual([]);
});

it('one unreadable entry in the held list does not stop sign-out clearing the others', () => {
  const storage = map();
  const store = new SessionStore(storage);
  store.set(ADA_ALPHA);
  store.set(ADA_BRAVO);
  keep(storage, ADA_ALPHA, { fourEyes: 500 });
  keep(storage, ADA_BRAVO, { fourEyes: 900 });
  // Something else in the tab wrote a value of another shape into the list.
  storage.setItem(
    'ops-astro.held-businesses',
    JSON.stringify(['alpha', { not: 'a key' }, 'bravo']),
  );

  new SessionStore(storage).clear();

  expect(settingsLeft(storage)).toEqual([]);
});
