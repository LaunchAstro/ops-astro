// SPDX-License-Identifier: AGPL-3.0-only
//
// #1695: the order of the correction reads the sidebar sends.

import { useRef } from 'react';

/**
 * The order of the reads sent for each desk and correction: an answer lands
 * unless one sent after it has landed already, so a slow answer still lands
 * and an overtaken one never draws over a newer state. The list counts as a
 * read of each correction it carries.
 */
export interface Order {
  /** The next read's place in the order. */
  readonly next: () => number;
  /** Whether the answer sent `nth` for `id` under `key` lands; if it does, it is the newest. */
  readonly lands: (key: string, id: string, nth: number) => boolean;
}

export function useOrder(): Order {
  const order = useRef({ sent: 0, landed: new Map<string, number>() });
  return {
    next: () => {
      order.current.sent += 1;
      return order.current.sent;
    },
    lands: (key, id, nth) => {
      const which = JSON.stringify([key, id]);
      if ((order.current.landed.get(which) ?? 0) > nth) return false;
      order.current.landed.set(which, nth);
      return true;
    },
  };
}
