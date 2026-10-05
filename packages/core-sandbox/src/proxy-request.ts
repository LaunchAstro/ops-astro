// SPDX-License-Identifier: AGPL-3.0-only
import type { CreateShape } from './create-body.ts';
import type { Result } from './refusal.ts';
export type ContainerAction = 'attach' | 'start' | 'wait' | 'kill' | 'inspect' | 'delete';
export type ProxyOp =
  | { readonly kind: 'ping' | 'version' | 'info' }
  | { readonly kind: 'create'; readonly shape: CreateShape; readonly image: string }
  | { readonly kind: ContainerAction; readonly id: string }
  | { readonly kind: 'load'; readonly site: string | null; readonly contentLength: number }
  | { readonly kind: 'image-inspect' | 'image-delete'; readonly image: string };
export type ProxyGrammar = { readonly apiVersion: string; readonly shapes: readonly CreateShape[] };
export function readProxyRequest(
  _bytes: Uint8Array,
  _grammar: ProxyGrammar,
): Result<{ op: ProxyOp }> {
  return { ok: true, op: { kind: 'ping' } };
}
export function forwardBytes(_op: ProxyOp, _apiVersion: string): Uint8Array {
  return new Uint8Array();
}
