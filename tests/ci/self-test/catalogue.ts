// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e's catalogue (parts.json) and the shapes a mutation's run reports in.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One part before T4e: its invariants, the files that carry them and its commits on this line. */
export interface Part {
  readonly id: string;
  readonly invariants: readonly string[];
  readonly files: readonly string[];
  /** What a revert leaves at the head: a path, or a folder ending in `/`. */
  readonly keep: readonly string[];
  readonly commits: readonly string[];
  /**
   * A T4 part is test tooling, proven by its own planted-mutation cases (by
   * name, in its files) rather than a revert: the split's T4-N4 reverts every
   * T2 and T3 part.
   */
  readonly planted?: readonly string[];
}

export const keeps = (part: Part, path: string): boolean =>
  part.keep.some((one) => (one.endsWith('/') ? path.startsWith(one) : path === one));

export const PARTS: readonly Part[] = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'parts.json'), 'utf8')) as {
    parts: Part[];
  }
).parts;

/** What one mutation did and what its check said. */
export interface Ran {
  readonly applied: boolean;
  /** Cases, files or commands that reported an outcome; 0 means nothing ran. */
  readonly executed: number;
  readonly red: boolean;
  readonly detail: string;
  /** The cases that ran, by full name: a part's verdict reads its named invariant from them. */
  readonly cases?: readonly { readonly name: string; readonly passed: boolean }[];
}

export interface CaseLine {
  readonly case: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}
