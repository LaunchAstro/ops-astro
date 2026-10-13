// SPDX-License-Identifier: AGPL-3.0-only
//
// One carried call's line as the carried custody hears it
// (`carried-custody.ts`): the agent's messages, each opened under the carry
// key before it counts, for this call only, on the agent's own clock. That
// clock is learnt from the accept, so a seal made on one machine is never
// judged by the other's clock: the accept is opened first against its own
// stamp, and every later message on the agent's clock as the accept gives it.

import { ACCEPT_WINDOW_MS, SEAL_LIFE_MS, type Line } from './carriage.ts';
import { opened, type CarryKeys } from './carry-seal.ts';

const nothing = (): void => {};

export interface Clock {
  readonly now: () => number;
  readonly skew: Skew;
}

export interface Heard {
  readonly event: string;
  readonly seq: number;
  readonly runner: string;
  readonly body: unknown;
}

export type Next = (wanted: (heard: Heard) => boolean, until: number) => Promise<Heard | undefined>;

/** A wait until `wake` is called or `ms` pass, whichever comes first. */
function waitFor(ms: number, onWake: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    onWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The agent's clock against this one, learnt from its accept: `acceptedAt`
 * less the instant just before the offer, the most it can be ahead. Unknown
 * until then.
 */
export interface Skew {
  at: number | undefined;
}

/**
 * An accept's seal, opened before the skew is known: sealed as it accepted
 * (within the accept window of its stamp), for one seal's life on the agent's
 * clock. The `k` check holds it to this call's one offer.
 */
function freshAccept(seal: { readonly expiresAt: number }, body: unknown): boolean {
  const acceptedAt = (body as { acceptedAt?: unknown } | null)?.acceptedAt;
  return (
    typeof acceptedAt === 'number' &&
    Number.isSafeInteger(acceptedAt) &&
    seal.expiresAt >= acceptedAt &&
    seal.expiresAt <= acceptedAt + SEAL_LIFE_MS + ACCEPT_WINDOW_MS
  );
}

/**
 * The agent's sealed messages for call `k`, as they arrive, each opened before
 * it counts, on the agent's clock as the skew gives it.
 */
export function listen(line: Line, keys: CarryKeys, k: string, clock: Clock): Next {
  const { now, skew } = clock;
  const queue: Heard[] = [];
  let wake = nothing;
  line.hear((event, message) => {
    const known = skew.at;
    const at = known === undefined ? Number.MIN_SAFE_INTEGER : now() + known;
    const result = opened(keys, message, { direction: 'agent', event, now: at });
    if (!result.ok || result.sealed.k !== k) return;
    if (known === undefined && !(event === 'accept' && freshAccept(result.sealed, result.body)))
      return;
    const { seq, runner } = result.sealed;
    queue.push({ event, seq, runner, body: result.body });
    wake();
  });
  const setWake = (next: () => void): void => {
    wake = next;
  };
  return async (wanted, until) => {
    for (;;) {
      const found = queue.findIndex((heard) => wanted(heard));
      if (found !== -1) return queue.splice(found, 1)[0];
      const left = until - now();
      if (left <= 0) return;
      // oxlint-disable-next-line no-await-in-loop -- waits for the next message or the time
      await waitFor(left, setWake);
    }
  };
}
