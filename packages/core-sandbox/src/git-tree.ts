// SPDX-License-Identifier: AGPL-3.0-only
//
// I2 (docs/plan/sandbox-contract.md, section 3). Stub.

import type { TreeEntry } from './input-tree.ts';
import type { SandboxResult } from './refusal.ts';

/** The broker's read: the raw bytes of one git object, at most `maxBytes` of them. */
export type GitRead = (oid: string, maxBytes: number) => Promise<Uint8Array>;

export function assembleTree(
  _read: GitRead,
  _baseRevision: string,
  _edit: { readonly path: string; readonly content: Uint8Array },
): Promise<
  SandboxResult<{ files: ReadonlyMap<string, Uint8Array>; entries: readonly TreeEntry[] }>
> {
  return Promise.resolve({ ok: true, files: new Map(), entries: [] });
}
