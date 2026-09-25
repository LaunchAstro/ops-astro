// SPDX-License-Identifier: AGPL-3.0-only
//
// The session store over a storage that misbehaves (thermo L5).
//
// `sessionStorage` throws outright in a blocked-site-data tab, and what is in
// it belongs to the tab rather than to this code. The store keeps working in
// memory either way, and a stored value that is not the shape it wrote is
// treated as nothing kept.

import { describe, expect, it } from 'vitest';
import {
  SessionStore,
  isRecord,
  jsonSlot,
  settingsCacheKey,
  type StorageLike,
} from '../../apps/web/src/session/token.ts';

const SESSION = { token: 't', businessKey: 'alpha', email: 'ada@example.test' };
const ENDED = { address: '/task/T-1', businessKey: 'alpha', code: 'AUTH_UNKNOWN_LOGIN' };

function map(
  seed: Record<string, string> = {},
): StorageLike & { readonly held: Map<string, string> } {
  const held = new Map(Object.entries(seed));
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

const blocked: StorageLike = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('the session store over storage that throws or holds junk', () => {
  it('a blocked storage restores nothing and the session still lives in memory', () => {
    const store = new SessionStore(blocked);
    expect(store.session).toBeNull();
    expect(store.interruption).toBeNull();
    store.set(SESSION);
    expect(store.session).toEqual(SESSION);
    store.end(ENDED);
    expect(store.session).toBeNull();
    expect(store.interruption).toEqual(ENDED);
    expect(store.takeInterruption()).toEqual(ENDED);
    store.clear();
    expect(store.session).toBeNull();
  });

  it('a stored value that is not JSON, or not the shape, is nothing kept', () => {
    expect(new SessionStore(map({ 'ops-astro.session': '{not json' })).session).toBeNull();
    expect(new SessionStore(map({ 'ops-astro.session': '{"token":1}' })).session).toBeNull();
    const offsite = JSON.stringify({ ...ENDED, address: '//elsewhere.test/' });
    expect(new SessionStore(map({ 'ops-astro.return-to': offsite })).interruption).toBeNull();
  });

  it('what it writes it reads back, and sign-out removes the session and its settings memory', () => {
    const storage = map({ [settingsCacheKey('alpha')]: '{"session":"x"}' });
    new SessionStore(storage).set(SESSION);
    const again = new SessionStore(storage);
    expect(again.session).toEqual(SESSION);
    again.clear();
    expect([...storage.held.keys()]).toEqual([]);
  });

  it('a slot reads null for missing, malformed and rejected values, and swallows a throw', () => {
    const storage = map({ bad: '[', array: '[1]' });
    expect(jsonSlot(storage, 'missing', isRecord).read()).toBeNull();
    expect(jsonSlot(storage, 'bad', isRecord).read()).toBeNull();
    expect(
      jsonSlot(storage, 'array', (value): value is string => typeof value === 'string').read(),
    ).toBeNull();
    const slot = jsonSlot(storage, 'kept', isRecord);
    slot.write({ a: 1 });
    expect(slot.read()).toEqual({ a: 1 });
    slot.remove();
    expect(slot.read()).toBeNull();
    const refused = jsonSlot(blocked, 'kept', isRecord);
    expect(refused.read()).toBeNull();
    expect(() => {
      refused.write({ a: 1 });
      refused.remove();
    }).not.toThrow();
  });
});
