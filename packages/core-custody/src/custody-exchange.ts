// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's side of custody's process channel (`custody.ts`): one message
// out per request id and its answer back, the notes custody sends while a
// dispatch runs passed on as they come, and `lost` for every waiting request
// once custody's process is gone.

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** What custody notes while a dispatch runs, each passed on and never taken as the answer. */
export interface Notes {
  readonly started?: () => void;
  readonly piece?: ((text: string) => void) | undefined;
  readonly written?: (() => void) | undefined;
  /** Asked at `started` for a gated dispatch: true sends `go`, anything else `stop`. */
  readonly gate?: (() => Promise<boolean>) | undefined;
}

export type Exchange = (
  body: Record<string, unknown>,
  notes?: Notes,
) => Promise<Record<string, unknown> | 'lost'>;

/** A note on a running dispatch, passed on: true, or false for its answer. */
function noted(
  child: ChildProcess,
  id: string,
  message: Record<string, unknown>,
  notes: Notes,
): boolean {
  if (message['type'] === 'started') {
    notes.started?.();
    notes.gate?.().then(
      (go) => child.send({ type: go ? 'go' : 'stop', id }),
      () => child.send({ type: 'stop', id }),
    );
  } else if (message['type'] === 'written') {
    notes.written?.();
  } else if (message['type'] === 'piece') {
    if (typeof message['text'] === 'string') notes.piece?.(message['text']);
  } else {
    return false;
  }
  return true;
}

/**
 * One message out and its answer back, or `lost` when custody goes first. A
 * `started` note, each `piece` note and a `written` note are passed on, never
 * taken as the answer.
 */
export function exchangeWith(child: ChildProcess): Exchange {
  const waiting = new Map<string, (message: Record<string, unknown>) => void>();
  const lost = new Set<() => void>();
  child.on('message', (message: unknown) => {
    const shape = message as Record<string, unknown>;
    const id = shape['id'];
    if (typeof id === 'string') waiting.get(id)?.(shape);
  });
  const loseAll = (): void => {
    for (const notify of lost) notify();
  };
  child.on('exit', loseAll);
  // A write to a custody that died before its exit was handled fails as EPIPE: lost, as on exit, not a crash.
  child.on('error', loseAll);
  return async (body, notes = {}) =>
    await new Promise((resolve) => {
      const id = randomUUID();
      const onLost = (): void => {
        waiting.delete(id);
        lost.delete(onLost);
        resolve('lost');
      };
      lost.add(onLost);
      waiting.set(id, (message) => {
        if (noted(child, id, message, notes)) return;
        waiting.delete(id);
        lost.delete(onLost);
        resolve(message);
      });
      if (child.exitCode !== null || !child.connected) {
        onLost();
        return;
      }
      child.send({ ...body, id }, (error) => {
        if (error !== null) onLost();
      });
    });
}
