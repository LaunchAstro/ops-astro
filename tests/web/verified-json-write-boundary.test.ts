// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { verifiedJsonWrite } from '../../apps/web/src/session/storage-slot.ts';
import { draftTab } from './projects-draft-app-support.tsx';

const KEY = 'ops-astro.task-scores';
const TASK = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = {
  operationId: '22222222-2222-4222-8222-222222222222',
  revision: 4,
  mark: 'impact',
  value: 10,
};
const ENVELOPE = { version: 1, owner: 'alpha/owner/1', tasks: { [TASK]: ATTEMPT } };

it('a fresh throwing write has no verified recovery copy', () => {
  const storage = draftTab();
  storage.setItem = () => {
    throw new Error('Write refused');
  };
  expect(verifiedJsonWrite(storage, KEY, ENVELOPE)).toBe(false);
  expect(storage.getItem(KEY)).toBeNull();
});

it.each(['retained', 'write-then-throw'] as const)(
  'a %s exact recovery copy remains verified despite the write exception',
  (mode) => {
    const storage = draftTab();
    const set = storage.setItem.bind(storage);
    if (mode === 'retained') set(KEY, JSON.stringify(ENVELOPE));
    storage.setItem = (key, raw) => {
      if (mode === 'write-then-throw') set(key, raw);
      throw new Error('Write answer refused');
    };
    expect(verifiedJsonWrite(storage, KEY, ENVELOPE)).toBe(true);
    expect(storage.getItem(KEY)).toBe(JSON.stringify(ENVELOPE));
  },
);

it.each([
  { ...ENVELOPE, version: 2 },
  { ...ENVELOPE, owner: 'foreign-owner' },
  {
    ...ENVELOPE,
    tasks: { [TASK]: { ...ATTEMPT, operationId: '33333333-3333-4333-8333-333333333333' } },
  },
  { ...ENVELOPE, tasks: { [TASK]: { ...ATTEMPT, revision: 5 } } },
  { ...ENVELOPE, tasks: { [TASK]: { ...ATTEMPT, mark: 'ease' } } },
  { ...ENVELOPE, tasks: { [TASK]: { ...ATTEMPT, value: null } } },
  {
    ...ENVELOPE,
    tasks: { [TASK]: { operationId: ATTEMPT.operationId, revision: 4, mark: 'impact' } },
  },
])('a different complete recovery copy cannot verify the intended envelope %#', (other) => {
  const storage = draftTab();
  storage.setItem(KEY, JSON.stringify(other));
  storage.setItem = () => {
    throw new Error('Write refused');
  };
  expect(verifiedJsonWrite(storage, KEY, ENVELOPE)).toBe(false);
});

it.each([null, '{"version":1', ''])('an absent or truncated copy refuses recovery %#', (raw) => {
  const storage = draftTab();
  if (raw !== null) storage.setItem(KEY, raw);
  storage.setItem = () => {
    throw new Error('Write refused');
  };
  expect(verifiedJsonWrite(storage, KEY, ENVELOPE)).toBe(false);
});

it('a throwing read cannot establish recovery even after a successful write', () => {
  const storage = draftTab();
  storage.getItem = () => {
    throw new Error('Read refused');
  };
  expect(verifiedJsonWrite(storage, KEY, ENVELOPE)).toBe(false);
});

it('a serialisation failure or missing storage refuses without a write', () => {
  const storage = draftTab();
  let writes = 0;
  storage.setItem = () => {
    writes += 1;
  };
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  expect(verifiedJsonWrite(storage, KEY, cycle)).toBe(false);
  expect(verifiedJsonWrite(null, KEY, ENVELOPE)).toBe(false);
  expect(writes).toBe(0);
});

it('a durably empty cleanup remains verified even when its write throws afterward', () => {
  const storage = draftTab();
  const set = storage.setItem.bind(storage);
  const empty = { ...ENVELOPE, tasks: {} };
  storage.setItem = (key, raw) => {
    set(key, raw);
    throw new Error('Write answer refused');
  };
  expect(verifiedJsonWrite(storage, KEY, empty)).toBe(true);
  expect(storage.getItem(KEY)).toBe(JSON.stringify(empty));
});
