// SPDX-License-Identifier: AGPL-3.0-only
//
// The seal on a carried message (`carriage.ts`): proof of who wrote it, for
// which call and runner, as which event and number, and until when.
//
//   mac = HMAC-SHA256(key, direction | k | runner | event | seq | sha256(body) | expiresAt)
//
// The key is shared by the function and the model agent and by nobody else;
// a call's owner, who can join its line, cannot seal. The direction stops one
// side's message being played back as the other's. During a rotation two keys
// are set and either opens; a key that is not set opens nothing. A message
// opens only whole: any change to any part is a forgery, and every check runs
// before its body is read.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type Direction = 'broker' | 'agent';

export interface Sealed {
  readonly direction: Direction;
  /** The call. */
  readonly k: string;
  /** The agent process the call runs under; a restart is a new runner. */
  readonly runner: string;
  readonly event: string;
  /** The message's number in its run, for pieces; 0 for the rest. */
  readonly seq: number;
  /** Milliseconds since the epoch, on the sealer's clock. */
  readonly expiresAt: number;
  /** The body as JSON text, exactly as sealed. */
  readonly body: string;
  /** base64url. */
  readonly mac: string;
}

export type CarryKeys = readonly Buffer[];

export type SealRefusal = 'SEAL_MALFORMED' | 'SEAL_FORGED' | 'SEAL_EXPIRED' | 'SEAL_WRONG_WAY';

/** The bytes of a carry key: base64url of at least 32 bytes. */
function keyBytes(value: string | undefined): Buffer | undefined {
  if (value === undefined || !/^[\w-]+$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= 32 && bytes.toString('base64url') === value ? bytes : undefined;
}

/** The current key and, during a rotation, the next one; refused whole on either being malformed. */
export function parseCarryKeys(
  current: string | undefined,
  next?: string,
):
  | { readonly ok: true; readonly keys: CarryKeys }
  | { readonly ok: false; readonly code: 'CARRY_KEY_MALFORMED' } {
  const first = keyBytes(current);
  const second = next === undefined || next === '' ? undefined : keyBytes(next);
  if (first === undefined || (next !== undefined && next !== '' && second === undefined)) {
    return { ok: false, code: 'CARRY_KEY_MALFORMED' };
  }
  if (second !== undefined && second.equals(first))
    return { ok: false, code: 'CARRY_KEY_MALFORMED' };
  return { ok: true, keys: second === undefined ? [first] : [first, second] };
}

function macOf(key: Buffer, fields: Omit<Sealed, 'mac'>): Buffer {
  const digest = createHash('sha256').update(fields.body, 'utf8').digest('hex');
  const said = [
    fields.direction,
    fields.k,
    fields.runner,
    fields.event,
    String(fields.seq),
    digest,
    String(fields.expiresAt),
  ].join('|');
  return createHmac('sha256', key).update(said, 'utf8').digest();
}

/** The message sealed under `key` (base64url, as the setting holds it). */
export function sealed(key: string | Buffer, fields: Omit<Sealed, 'mac'>): Sealed {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'base64url') : key;
  const { direction, k, runner, event, seq, expiresAt, body } = fields;
  const exact = { direction, k, runner, event, seq, expiresAt, body };
  return { ...exact, mac: macOf(bytes, exact).toString('base64url') };
}

const FIELDS = 'body,direction,event,expiresAt,k,mac,runner,seq';

const whole = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): boolean => typeof value === 'string' && value !== '';

/** Exactly the eight fields, each of its type: anything else is malformed. */
function shapeOf(message: unknown): Sealed | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const shape = message as Record<string, unknown>;
  if (
    Object.keys(shape).toSorted().join() !== FIELDS ||
    (shape['direction'] !== 'broker' && shape['direction'] !== 'agent') ||
    !text(shape['k']) ||
    !text(shape['runner']) ||
    !text(shape['event']) ||
    !whole(shape['seq']) ||
    !whole(shape['expiresAt']) ||
    typeof shape['body'] !== 'string' ||
    typeof shape['mac'] !== 'string'
  ) {
    return undefined;
  }
  return shape as unknown as Sealed;
}

/**
 * The message's body, once it is whole, under a key that is set, sealed the
 * way and for the event `expected` names, and not past its expiry at
 * `expected.now`; otherwise why not.
 */
export function opened(
  keys: CarryKeys,
  message: unknown,
  expected: { readonly direction: Direction; readonly event: string; readonly now: number },
):
  | { readonly ok: true; readonly sealed: Sealed; readonly body: unknown }
  | { readonly ok: false; readonly code: SealRefusal } {
  const shape = shapeOf(message);
  if (shape === undefined) return { ok: false, code: 'SEAL_MALFORMED' };
  const given = Buffer.from(shape.mac, 'base64url');
  const genuine = keys.some((key) => {
    const mac = macOf(key, shape);
    return given.length === mac.length && timingSafeEqual(given, mac);
  });
  if (!genuine) return { ok: false, code: 'SEAL_FORGED' };
  if (shape.direction !== expected.direction || shape.event !== expected.event) {
    return { ok: false, code: 'SEAL_WRONG_WAY' };
  }
  if (expected.now > shape.expiresAt) return { ok: false, code: 'SEAL_EXPIRED' };
  let body: unknown;
  try {
    body = JSON.parse(shape.body);
  } catch {
    return { ok: false, code: 'SEAL_MALFORMED' };
  }
  return { ok: true, sealed: shape, body };
}
