// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';

/** One host slot belongs to one task and grant; stale setters cannot change its successor. */
export function useHeld<T>(
  identity: string,
  denied: boolean,
  keeps?: (held: T, next: T | null) => boolean,
): readonly [T | null, (next: T | null) => void] {
  // The slot always names the task and grant it is for, empty or not, so a
  // setter from an older task or grant can tell it writes nothing here.
  const [held, setHeld] = useState<{ readonly identity: string; readonly value: T | null }>({
    identity,
    value: null,
  });
  if (held.identity !== identity || (denied && held.value !== null)) {
    setHeld({ identity, value: null });
  }
  const value = held.identity === identity ? held.value : null;
  const set = (next: T | null): void => {
    // Writing what is already held keeps the same slot, so no render follows.
    setHeld((current) =>
      current.identity !== identity ||
      current.value === next ||
      (current.value !== null && keeps?.(current.value, next) === true)
        ? current
        : { identity, value: next },
    );
  };
  return [value, set];
}
