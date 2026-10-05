// SPDX-License-Identifier: AGPL-3.0-only
import type { Result } from './refusal.ts';
import type { Json } from './strict-json.ts';
export type Crossing = 'memory' | 'wall' | 'output';
export type CreateShape =
  | { readonly runClass: 'site.build'; readonly env: readonly string[] }
  | { readonly runClass: 'site.prepare'; readonly env: readonly string[] }
  | {
      readonly runClass: 'probe';
      readonly probed: 'site.build' | 'site.prepare';
      readonly crossing?: Crossing;
      readonly env: readonly string[];
    };
export function fixedCreateBody(_shape: CreateShape, image: string): Json {
  return { Image: image };
}
export function matchCreateBody(
  body: Json,
  shapes: readonly CreateShape[],
): Result<{ shape: CreateShape; image: string }> {
  return { ok: true, shape: shapes[0]!, image: String((body as { Image?: string }).Image) };
}
