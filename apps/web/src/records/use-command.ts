// SPDX-License-Identifier: AGPL-3.0-only
//
// The write half that pairs with `useRead`: one command in flight, and what
// the server said about it.
//
// Every write on the task page, the proposals view and the board went through
// the same steps by hand: mark it busy, clear the last reason, send, stop being
// busy, describe the failure, then branch on the code. The branching is the
// only part that differed between them, and even that came down to three
// codes read the same way everywhere. So the answer is classified once, here,
// and a caller keeps only the step that is its own: clearing a box, settling a
// draft, lifting a note above a reread, or holding an attempt whose outcome is
// unknown.
//
// The words are still the server's. A failure's text is `describeFailure`'s,
// which is the refusal verbatim by code; nothing here chooses friendlier ones.

import { useState } from 'react';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type WireRefusal,
} from '../operations/client.ts';
import { describeRefusal } from './submit.ts';

/**
 * What a write came to, in the terms a screen acts on.
 *
 * - `ok`: stored.
 * - `stale`: `VERSION_STALE`. Somebody else moved the record on first.
 * - `closed`: `SCOPE_NOT_GRANTED`. About this reader, not the record, so a
 *   control that asks again would only be refused again.
 * - `failed`: any other refusal. The outcome is known and nothing was stored.
 * - `unknown`: the server did not answer. It may or may not have stored it.
 */
export type Settlement =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'stale' | 'closed' | 'failed';
      readonly refusal: WireRefusal;
      readonly because: string;
    }
  | { readonly kind: 'unknown'; readonly because: string };

export type Failure = Exclude<Settlement, { readonly kind: 'ok' }>;

export function settle(result: CallResult<unknown>): Settlement {
  if (isRefusal(result)) {
    const because = describeRefusal(result);
    if (result.code === 'VERSION_STALE') return { kind: 'stale', refusal: result, because };
    if (result.code === 'SCOPE_NOT_GRANTED') return { kind: 'closed', refusal: result, because };
    return { kind: 'failed', refusal: result, because };
  }
  if (isUnavailable(result)) return { kind: 'unknown', because: result.because };
  return { kind: 'ok' };
}

export interface Command {
  /** A write is in flight. Controls that would start another are disabled on it. */
  readonly busy: boolean;
  /** The last write's failure, until the next write starts or `reset` is called. */
  readonly failure: Failure | null;
  /** Send one write, and hand its settlement to the caller's own step. */
  readonly run: <T>(
    work: () => Promise<CallResult<T>>,
    then?: (settlement: Settlement) => void,
  ) => void;
  /** Forget the last failure without sending anything. */
  readonly reset: () => void;
}

export function useCommand(): Command {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const run: Command['run'] = (work, then) => {
    setBusy(true);
    setFailure(null);
    void (async () => {
      const settlement = settle(await work());
      setBusy(false);
      setFailure(settlement.kind === 'ok' ? null : settlement);
      then?.(settlement);
    })();
  };

  return {
    busy,
    failure,
    run,
    reset: () => {
      setFailure(null);
    },
  };
}
