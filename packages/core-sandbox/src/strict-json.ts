// SPDX-License-Identifier: AGPL-3.0-only
import type { Result } from './refusal.ts';
export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export function parseStrictJson(
  bytes: Uint8Array,
  _options: { readonly foldCase?: boolean } = {},
): Result<{ value: Json }> {
  return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as Json };
}
