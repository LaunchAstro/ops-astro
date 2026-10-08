// SPDX-License-Identifier: AGPL-3.0-only
//
// The tab's storage as the session and `/settings` use it: one JSON value per
// key, read through a guard, and never able to take the tab down. Moved whole
// from token.ts, which re-exports it.

/** The narrow part of `Storage` the session and `/settings` use. */
export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** One JSON value kept under one key. */
export interface JsonSlot<T> {
  /** The value, or null when there is none, it is not JSON or the guard rejects it. */
  readonly read: () => T | null;
  readonly write: (value: T) => void;
  readonly remove: () => void;
}

/**
 * The one place browser storage is read and written as JSON.
 *
 * A storage that throws — private mode, blocked site data — must not take the
 * tab with it: every call is caught, a failed read is "nothing kept", and a
 * failed write or removal leaves memory as the only copy, which it already is.
 * A stored value is read through `guard`, because the storage belongs to the
 * tab and not to this code.
 */
export function jsonSlot<T>(
  storage: StorageLike | null,
  key: string,
  guard: (value: unknown) => value is T,
): JsonSlot<T> {
  return {
    read: () => {
      try {
        const raw = storage?.getItem(key) ?? null;
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        return guard(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    write: (value) => {
      try {
        storage?.setItem(key, JSON.stringify(value));
      } catch {
        /* The tab keeps working on what it holds in memory. */
      }
    },
    remove: () => {
      try {
        storage?.removeItem(key);
      } catch {
        /* Nothing to do: memory is already clear. */
      }
    },
  };
}

/**
 * This tab's `sessionStorage`, or null where there is none or it is blocked.
 * Blocked site data makes the global throw on access, not only on use.
 */
export function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** A pre-send recovery copy is kept only when storage returns those exact bytes. */
export function verifiedJsonWrite(
  storage: StorageLike | null,
  key: string,
  value: unknown,
): boolean {
  if (storage === null) return false;
  try {
    const raw = JSON.stringify(value);
    storage.setItem(key, raw);
    return storage.getItem(key) === raw;
  } catch {
    return false;
  }
}

/** Any JSON object. What a slot guard starts from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** A stored UUID's shape, without granting visibility or authority over its row. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
