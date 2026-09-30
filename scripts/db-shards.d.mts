// SPDX-License-Identifier: AGPL-3.0-only
// Types for scripts/db-shards.mjs, read by the tests that import it.
export interface Part {
  readonly index: number;
  readonly count: number;
}
export function parseShard(text: string, what?: string): Part;
export function readPlan(path: string | URL): {
  parts: Record<string, number>;
  seconds: Record<string, number>;
};
export function planItems(
  named: readonly string[],
  parts: Readonly<Record<string, number>>,
): string[];
export function itemOf(item: string): { suite: string; part: string | undefined };
export function suitePart(text: string | undefined): Part;
export function inPart(index: number, part: Part): boolean;
export function assignShards(
  items: readonly string[],
  seconds: Readonly<Record<string, number>>,
  count: number,
): string[][];
