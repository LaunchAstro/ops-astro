// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693: how long a correction card offers Approve, and when it reads again.
//
// Approve stands on a version whose check still holds. The read answers how
// long the check holds (`verifiedForMs`), and the hook stamps the answer with
// `performance.now()` as it lands (`readAt`). The clock here is armed from
// that stamp: once the time has passed, the card takes Approve away, says it
// is checking the page again and reads once more. The wall clock plays no part.
//
// While the correction waits for a decision without a check that holds, the
// card reads again every 10 s for at most 10 minutes; while the page is being
// found, every 5 s for at most 3 minutes. A read with a fresh check brings
// Approve back.

import { useEffect, useRef, useState } from 'react';
import type { CardState } from './correction.ts';
import type { Correction } from './correction-desks.ts';

/** How often each state is read again, and for how long at most, in ms. */
const CADENCES: Partial<Readonly<Record<CardState, { every: number; for: number }>>> = {
  requested: { every: 10_000, for: 600_000 },
  locating: { every: 5000, for: 180_000 },
};

export interface LaunchClock {
  /** Approve may be drawn: a version waits for a decision and its check still holds. */
  readonly launchable: boolean;
  /** It waits for a decision, but no check holds: the card is reading the page again. */
  readonly checking: boolean;
}

/** The check the last read stamped: a version, a time left, and a decision still to make. */
const stamped = (correction: Correction): boolean =>
  correction.state === 'requested' &&
  correction.versionId !== null &&
  correction.verifiedForMs > 0 &&
  correction.readAt !== null;

/** The card's clock: whether Approve stands now, and the re-reads while it does not. */
export function useLaunchClock(correction: Correction, reread: () => void): LaunchClock {
  const latest = useRef(reread);
  useEffect(() => {
    latest.current = reread;
  });
  const { state, readAt, verifiedForMs } = correction;
  const holds = stamped(correction);
  // The stamp whose check has aged: Approve goes once its time has passed.
  const [aged, setAged] = useState<number | null>(null);
  useEffect(() => {
    if (!holds || readAt === null) return;
    const timer = setTimeout(
      () => {
        setAged(readAt);
        latest.current();
      },
      Math.max(0, verifiedForMs - (performance.now() - readAt)),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [holds, readAt, verifiedForMs]);
  const launchable = holds && aged !== readAt;
  const polling = state === 'locating' || (state === 'requested' && !launchable);
  // When the card came to its state: the re-reads stop once its time is up.
  const began = useRef<{ readonly state: CardState; readonly at: number } | null>(null);
  useEffect(() => {
    const cadence = CADENCES[state];
    if (!polling || cadence === undefined) return;
    if (began.current?.state !== state) began.current = { state, at: performance.now() };
    const until = began.current.at + cadence.for;
    if (performance.now() >= until) return;
    const timer = setInterval(() => {
      if (performance.now() >= until) {
        clearInterval(timer);
        return;
      }
      latest.current();
    }, cadence.every);
    return () => {
      clearInterval(timer);
    };
  }, [polling, state]);
  return { launchable, checking: state === 'requested' && !launchable };
}
