// SPDX-License-Identifier: AGPL-3.0-only
//
// What breaks what a read's host admits, by default: an answer that drops the
// last one, refused or out (`useRead`'s `breaks`).

import type { ReadState } from './authorised-read.ts';

/** An answer that drops the last one: refused or out. */
export const dropsAnswer = (state: ReadState<unknown>): boolean =>
  state.outcome === 'denied' || state.outcome === 'unavailable';
