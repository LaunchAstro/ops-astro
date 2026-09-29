// SPDX-License-Identifier: AGPL-3.0-only
//
// T4e's mutations: not built yet. The red commit of `every_invariant_bites`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Part {
  readonly id: string;
  readonly invariants: readonly string[];
  readonly files: readonly string[];
  readonly keep: 'tests' | 'files';
  readonly commits: readonly string[];
}

export const PARTS: readonly Part[] = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'parts.json'), 'utf8')) as {
    parts: Part[];
  }
).parts;

export interface Ran {
  readonly applied: boolean;
  readonly executed: number;
  readonly red: boolean;
  readonly detail: string;
}

export interface CaseLine {
  readonly case: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export function classify(name: string, ran: Ran): CaseLine {
  return { case: name, status: 'pass', detail: ran.detail };
}

export function everyInvariantBites(lines: readonly CaseLine[]): CaseLine {
  return { case: 'every_invariant_bites', status: 'pass', detail: String(lines.length) };
}

export interface Scratch {
  readonly dir: string;
  readonly branch: string;
  close(): void;
}

export function openScratch(): Scratch {
  throw new Error('self-test: the scratch branch is not built');
}

export function deleteOneMigration(_scratch: Scratch): Ran {
  throw new Error('self-test: T4-N1 is not built');
}

export function changePinnedMockup(_scratch: Scratch): Ran {
  throw new Error('self-test: T4-N3 is not built');
}
