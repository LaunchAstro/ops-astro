// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect } from 'react';

type Hold = () => () => boolean;

/** Each host's mounted draft panels, told when a Create goes out, lands or is let go. */
const mounts = new WeakMap<Hold, Set<() => void>>();

export const tell = (hold: Hold): void => {
  for (const told of mounts.get(hold) ?? []) told();
};

/** `told` runs whenever a mount on the same host tells, this one included. */
export function useToldBy(hold: Hold, told: () => void): void {
  useLayoutEffect(() => {
    const each = mounts.get(hold) ?? new Set();
    mounts.set(hold, each.add(told));
    return () => {
      each.delete(told);
    };
  }, []);
}
