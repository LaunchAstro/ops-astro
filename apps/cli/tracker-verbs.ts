// SPDX-License-Identifier: AGPL-3.0-only
//
// Not built: the tracker's verbs (API-5). The named tests come first.

import type { VerbRow } from './verb-args.ts';

export interface UnavailableVerb {
  readonly verb: string;
  readonly usage: string;
  /** The one line it answers, with exit 1 and nothing sent. */
  readonly answer: string;
}

export const TRACKER_VERBS: readonly VerbRow[] = [];

export const UNAVAILABLE_VERBS: readonly UnavailableVerb[] = [];
