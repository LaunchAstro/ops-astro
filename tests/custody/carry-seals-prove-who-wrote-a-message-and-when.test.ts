// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried call's messages travel on a Realtime topic the call's owner can
// join with their own login, and Realtime does not say who sent a message.
// The seal is what proves the author: an HMAC under the carry key over the
// direction, the call, the runner, the event, its number, the body's digest
// and its expiry. A message opens only for the way it was sealed, for the
// event it names, before its expiry, under a key that is set; any change to
// any part of it is a forgery. During a key rotation both keys open.
//
// The send deadline is anchored to the agent's own accept: `A + W`, and a
// write is allowed up to and at that instant, never after.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACCEPT_WINDOW_MS,
  SEAL_LIFE_MS,
  SEND_WINDOW_MS,
  agentTopic,
  callTopic,
  deadlineOf,
  opened,
  parseCarryKeys,
  sealed,
  sendable,
  topicOf,
  type Sealed,
} from '../../packages/core-custody/src/index.ts';

const KEY = randomBytes(32).toString('base64url');
const NEXT = randomBytes(32).toString('base64url');
const OTHER = randomBytes(32).toString('base64url');

const BUSINESS = '0b6f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const CALL = '7d2c9e41-5a6b-4c7d-8e9f-a0b1c2d3e4f5';
const AGENT = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b';
const NOW = 1_800_000_000_000;

const keysOf = (...values: string[]) => {
  const parsed = parseCarryKeys(values[0], values[1]);
  if (!parsed.ok) throw new Error('keys refused');
  return parsed.keys;
};

const request = (overrides: Partial<Omit<Sealed, 'mac'>> = {}): Sealed =>
  sealed(KEY, {
    direction: 'broker',
    k: CALL,
    runner: 'runner-1',
    event: 'request',
    seq: 0,
    expiresAt: NOW + SEAL_LIFE_MS,
    body: JSON.stringify({ deadlineAt: NOW + 3_000, request: { path: '/api/chat' } }),
    ...overrides,
  });

const expectFrom = { direction: 'broker', event: 'request', now: NOW } as const;

// oxlint-disable-next-line max-lines-per-function -- one sealed message, every way to change it
describe('a carried message opens only as it was sealed', () => {
  it('opens for its own direction, event and moment, and gives its body', () => {
    const result = opened(keysOf(KEY), request(), expectFrom);
    expect(result).toMatchObject({ ok: true, sealed: { k: CALL, runner: 'runner-1', seq: 0 } });
    expect(result.ok && result.body).toStrictEqual({
      deadlineAt: NOW + 3_000,
      request: { path: '/api/chat' },
    });
  });

  it.each([
    ['the body', { body: JSON.stringify({ deadlineAt: NOW + 60_000 }) }],
    ['the call', { k: '7d2c9e41-5a6b-4c7d-8e9f-a0b1c2d3e4f6' }],
    ['the runner', { runner: 'runner-2' }],
    ['the number', { seq: 1 }],
    ['the expiry', { expiresAt: NOW + SEAL_LIFE_MS + 1 }],
  ])('is a forgery once %s is changed after sealing', (_name, change) => {
    const forged = { ...request(), ...change };
    expect(opened(keysOf(KEY), forged, expectFrom)).toStrictEqual({
      ok: false,
      code: 'SEAL_FORGED',
    });
  });

  it('is a forgery under a key that is not set', () => {
    const { mac: _mac, ...fields } = request();
    const other = sealed(OTHER, fields);
    expect(opened(keysOf(KEY, NEXT), other, expectFrom)).toStrictEqual({
      ok: false,
      code: 'SEAL_FORGED',
    });
  });

  it('opens nowhere else: the other direction, or another event', () => {
    expect(opened(keysOf(KEY), request(), { ...expectFrom, direction: 'agent' })).toStrictEqual({
      ok: false,
      code: 'SEAL_WRONG_WAY',
    });
    expect(opened(keysOf(KEY), request(), { ...expectFrom, event: 'settled' })).toStrictEqual({
      ok: false,
      code: 'SEAL_WRONG_WAY',
    });
  });

  it('has expired once its moment is past, and not before', () => {
    const message = request({ expiresAt: NOW + 10 });
    expect(opened(keysOf(KEY), message, { ...expectFrom, now: NOW + 10 }).ok).toBe(true);
    expect(opened(keysOf(KEY), message, { ...expectFrom, now: NOW + 11 })).toStrictEqual({
      ok: false,
      code: 'SEAL_EXPIRED',
    });
  });

  it.each([
    ['nothing', undefined],
    ['a string', 'sealed'],
    ['no mac', { ...request(), mac: undefined }],
    ['a body that is not JSON', request({ body: '{not json' })],
    ['a number that is not whole', { ...request(), seq: 1.5 }],
    ['an extra field', { ...request(), origin: 'https://example.test' }],
    ['a mac of another length', { ...request(), mac: 'abcd' }],
  ])('is malformed when it is %s', (_name, message) => {
    expect(opened(keysOf(KEY), message, expectFrom)).toMatchObject({ ok: false });
    expect(opened(keysOf(KEY), message, expectFrom)).not.toMatchObject({ ok: true });
  });
});

describe('the carry keys', () => {
  it('during a rotation, a message sealed under either key opens', () => {
    const { mac: _mac, ...fields } = request();
    const underNext = sealed(NEXT, fields);
    expect(opened(keysOf(KEY, NEXT), request(), expectFrom).ok).toBe(true);
    expect(opened(keysOf(KEY, NEXT), underNext, expectFrom).ok).toBe(true);
    expect(opened(keysOf(KEY), underNext, expectFrom).ok).toBe(false);
  });

  it.each([
    ['no key', undefined, undefined],
    ['a short key', randomBytes(16).toString('base64url'), undefined],
    ['a key that is not base64url', `${KEY.slice(0, -2)}!!`, undefined],
    ['a short next key', KEY, randomBytes(8).toString('base64url')],
    ['the same key twice', KEY, KEY],
  ])('refuses %s', (_name, current, next) => {
    expect(parseCarryKeys(current, next)).toStrictEqual({ ok: false, code: 'CARRY_KEY_MALFORMED' });
  });
});

describe('the send deadline and the windows', () => {
  it('is the accept plus the send window, and a write is allowed at it, never after', () => {
    expect(SEND_WINDOW_MS).toBe(3_000);
    expect(ACCEPT_WINDOW_MS).toBe(5_000);
    const deadline = deadlineOf(NOW);
    expect(deadline).toBe(NOW + 3_000);
    expect(sendable(deadline, NOW + 2_999)).toBe(true);
    expect(sendable(deadline, deadline)).toBe(true);
    expect(sendable(deadline, deadline + 1)).toBe(false);
  });
});

describe('the carriage topics', () => {
  it('name the business and the agent or the call, and read back', () => {
    expect(agentTopic(BUSINESS, AGENT)).toBe(`carry:${BUSINESS}:agent:${AGENT}`);
    expect(callTopic(BUSINESS, CALL)).toBe(`carry:${BUSINESS}:call:${CALL}`);
    expect(topicOf(callTopic(BUSINESS, CALL))).toStrictEqual({
      business: BUSINESS,
      kind: 'call',
      id: CALL,
    });
  });

  it.each([
    `carry:${BUSINESS}:call:${CALL.toUpperCase()}`,
    `carry:${BUSINESS.toUpperCase()}:agent:${AGENT}`,
    `carry:${BUSINESS}:task:${CALL}`,
    `live:${BUSINESS}:call:${CALL}`,
    `carry:${BUSINESS}:call:${CALL}:extra`,
    `carry:${BUSINESS}:call:not-a-uuid`,
  ])('refuses %s', (topic) => {
    expect(topicOf(topic)).toBeUndefined();
  });

  it('will not build a topic from an id that is not a lower-case uuid', () => {
    expect(() => callTopic(BUSINESS, CALL.toUpperCase())).toThrow();
    expect(() => agentTopic('alpha', AGENT)).toThrow();
  });
});
