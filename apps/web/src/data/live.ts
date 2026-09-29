// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f: the page's side of the live task channel. Not built yet.

export const FLOOR_MS = 30_000;

export interface FollowOptions {
  readonly visible?: () => boolean;
}

export function followLive(
  _open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
  _onChange: () => void,
  _options: FollowOptions = {},
): () => void {
  return () => {};
}
