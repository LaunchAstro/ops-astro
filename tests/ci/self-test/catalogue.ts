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
  /** What a revert leaves at the head: a path, or a folder ending in `/`. None for a T4 part. */
  readonly keep?: readonly string[];
  readonly commits: readonly string[];
  /**
   * A T4 part is test tooling, proven by its own planted-mutation cases (by
   * name, in its files) rather than a revert: the split's T4-N4 reverts every
   * T2 and T3 part. See `verdict.ts`.
   */
  readonly planted?: readonly string[];
  /**
   * A T2 or T3 part's data-separation cases, by title, and what each crosses.
   * A declared crossing that stays green under the part's revert fails the
   * line by name, whatever its title says (`verdict.ts`).
   */
  readonly crossings?: readonly Crossing[];
}

export interface Crossing {
  readonly case: string;
  readonly crosses: readonly ('business' | 'client' | 'person')[];
}

/**
 * How a case titled as a crossing reads. The verdict keys on `crossings`,
 * never on a title; this only lets the catalogue test find a case of a part's
 * files that names a crossing and is not declared.
 */
export const TITLED_CROSSING: RegExp =
  /isolation|business to business|client to client|person to person|another business|another client|foreign|without the grant/iu;

export const keeps = (part: Part, path: string): boolean =>
  (part.keep ?? []).some((one) => (one.endsWith('/') ? path.startsWith(one) : path === one));

export const PARTS: readonly Part[] = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'parts.json'), 'utf8')) as {
    parts: Part[];
  }
).parts;

/** T4-N1 to T4-N3, each one line by its own name (`run.ts`): one never stands in for another. */
export const MUTATION_LINES: readonly string[] = [
  'T4-N1 a deleted migration fails the migration check',
  'T4-N2 an operation with no isolation case fails the isolation matrix',
  'T4-N3 a registry entry with no screen fails the route registry check',
  'T4-N3 a duplicate route id fails the typecheck',
  'T4-N3 a changed pinned-mockup byte fails the mockup pin',
];

/** The unmutated controls a red means nothing without: the shared checks, then one per part. */
export const CONTROL_LINES: readonly string[] = [
  'control: the isolation matrix',
  'control: the route registry check',
  'control: the typecheck',
];
export const controlOf = (part: Part): string =>
  `control: ${part.id} ${part.invariants.join(', ')}`;

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
