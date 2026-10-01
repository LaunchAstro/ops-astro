// SPDX-License-Identifier: AGPL-3.0-only
//
// The host's count of changes (MP-4-8) as a re-read of the same read, not a
// new one. A new read starts with no answer, so `RecordState`'s `keep` has
// nothing to hold and what is drawn under it mounts afresh; `reload` keeps
// the last answer drawn while the next is in flight (C4 live-sync 4).

import { useEffect, useRef } from 'react';

/** Call `reload` each time `count` moves on from the value it mounted with. */
export function useRereadOn(count: number, reload: () => void): void {
  const seen = useRef(count);
  useEffect(() => {
    if (seen.current === count) return;
    seen.current = count;
    reload();
  }, [count, reload]);
}
